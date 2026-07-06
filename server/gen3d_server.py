#!/usr/bin/env python3
"""
JAC 3D-generation server (:5052).

Runs INSIDE WSL (where the ROCm/torch env lives) but is reachable from Windows-side JAC via
127.0.0.1:5052 (WSL2 localhost forwarding). Same shape as cad_tools.py / pcb_tools.py, except
generation is slow (seconds to minutes) so it's an ASYNC JOB model:

    POST /generate {mode, image|prompt, model, opts}  -> {job_id}
    GET  /job/<id>                                     -> {state, progress, stage, glb, glb_win, error}
    POST /cancel/<id>                                  -> {ok}
    GET  /health                                       -> {status, backend, device, ready}
    GET  /backends                                     -> {backends:[...]}

Backends (select via arg 2 or GEN3D_BACKEND env; default 'stub' for plumbing bring-up):
  stub     - copies a sample GLB after a fake progress ramp (no torch; validates the pipeline)
  triposr  - image->mesh, warm TSR model (fast ~5s once loaded); replicates ~/TripoSR/run.py
  trellis  - image->mesh SOTA (textured); wired later (P2d)

Output GLBs -> ~/.jac/gen3d_out/<job_id>.glb ; response also carries a Windows UNC path
(\\wsl.localhost\<distro>\...) so JAC can read it directly.
"""
import os, sys, json, time, uuid, queue, shutil, threading, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
OUT_DIR = os.path.join(HOME, ".jac", "gen3d_out")
os.makedirs(OUT_DIR, exist_ok=True)
DISTRO = os.environ.get("WSL_DISTRO_NAME", "Ubuntu-24.04")
SAMPLE_GLB = "/mnt/c/Users/Jane Doe/Desktop/Alfred/trellis-T.glb"  # for the stub backend

BACKEND = (sys.argv[2] if len(sys.argv) > 2 else os.environ.get("GEN3D_BACKEND", "stub")).lower()
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5052

# Free the GPU when idle so a local LLM sharing the card isn't squeezed. Seconds of inactivity
# before the model is unloaded from VRAM; 0 = never unload (stay warm forever). Reload costs ~30s.
IDLE_TTL = float(os.environ.get("GEN3D_IDLE_TTL", "300"))
LAST_ACTIVITY = [time.time()]


def win_path(wsl_path: str) -> str:
    """WSL abs path -> \\wsl.localhost\<distro>\... so Windows JAC can read the file."""
    return r"\\wsl.localhost\{}".format(DISTRO) + wsl_path.replace("/", "\\")


def to_wsl_path(p: str) -> str:
    """Accept a Windows path (C:\\...), a /mnt path, or a WSL path; return something WSL can open."""
    if not p:
        return p
    if len(p) >= 2 and p[1] == ":":                       # C:\Users\... -> /mnt/c/Users/...
        drive = p[0].lower()
        return "/mnt/" + drive + p[2:].replace("\\", "/")
    return p.replace("\\", "/")


# ── Job store ────────────────────────────────────────────────────────────────
JOBS = {}                      # id -> dict
JOBS_LOCK = threading.Lock()
JOB_Q = queue.Queue()


def new_job(req: dict) -> str:
    jid = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[jid] = {"state": "queued", "progress": 0.0, "stage": "queued",
                     "glb": None, "glb_win": None, "error": None, "req": req, "cancel": False}
    JOB_Q.put(jid)
    return jid


def set_job(jid, **kw):
    with JOBS_LOCK:
        if jid in JOBS:
            JOBS[jid].update(kw)


def get_job(jid):
    with JOBS_LOCK:
        j = JOBS.get(jid)
        return dict(j) if j else None


# ── Backends ─────────────────────────────────────────────────────────────────
class StubBackend:
    name = "stub"
    device = "n/a"

    def ready(self):
        return os.path.exists(SAMPLE_GLB)

    def unload(self):
        return False   # nothing on the GPU

    def generate(self, jid, req, progress):
        for p in (0.15, 0.4, 0.7, 0.9):
            if get_job(jid)["cancel"]:
                raise RuntimeError("cancelled")
            progress(p, "generating (stub)")
            time.sleep(0.6)
        out = os.path.join(OUT_DIR, jid + ".glb")
        shutil.copyfile(SAMPLE_GLB, out)
        return out


class TripoSRBackend:
    """Warm TSR model; replicates ~/TripoSR/run.py core. Image->mesh, vertex-colored GLB."""
    name = "triposr"

    TRIPOSR_DIR = os.environ.get("GEN3D_TRIPOSR_DIR", os.path.join(HOME, "TripoSR"))

    def __init__(self):
        self.model = None
        self.device = None
        self._rembg = None
        self._lock = threading.Lock()   # guard load/unload vs a running job
        # Put TripoSR on the path NOW — generate()'s top-level `from tsr...` runs before _load().
        if self.TRIPOSR_DIR not in sys.path:
            sys.path.insert(0, self.TRIPOSR_DIR)

    def unload(self):
        """Drop the model from VRAM so a co-resident LLM gets the card back. Reloads on next job."""
        with self._lock:
            if self.model is None:
                return False
            self.model = None
            self._rembg = None
        try:
            import gc, torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        print("[gen3d] model unloaded (GPU freed)", flush=True)
        return True

    def _load(self, progress):
        if self.model is not None:
            return
        progress(0.05, "loading TripoSR (first run)")
        import torch
        from tsr.system import TSR
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        m = TSR.from_pretrained("stabilityai/TripoSR", config_name="config.yaml", weight_name="model.ckpt")
        m.renderer.set_chunk_size(8192)
        m.to(self.device)
        self.model = m
        import rembg
        self._rembg = rembg.new_session()

    def ready(self):
        return self.model is not None

    def generate(self, jid, req, progress):
        import numpy as np, torch
        from PIL import Image
        from tsr.utils import remove_background, resize_foreground
        self._load(progress)
        img_path = to_wsl_path(req.get("image", ""))
        if not img_path or not os.path.exists(img_path):
            raise RuntimeError("input image not found: %r" % req.get("image"))
        progress(0.3, "preprocessing image")
        image = remove_background(Image.open(img_path), self._rembg)
        image = resize_foreground(image, 0.85)
        arr = np.array(image).astype(np.float32) / 255.0
        arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
        image = Image.fromarray((arr * 255.0).astype(np.uint8))
        if get_job(jid)["cancel"]:
            raise RuntimeError("cancelled")
        progress(0.55, "running model")
        with torch.no_grad():
            scene_codes = self.model([image], device=self.device)
        progress(0.8, "extracting mesh")
        meshes = self.model.extract_mesh(scene_codes, True, resolution=int(req.get("opts", {}).get("mc_resolution", 256)))
        out = os.path.join(OUT_DIR, jid + ".glb")
        progress(0.92, "exporting GLB")
        meshes[0].export(out)
        return out


class HunyuanBackend:
    """SOTA: Hunyuan3D 2.1 (shape + PBR paint). Runs in its OWN py3.10/rocm venv, so we spawn it
    as a SUBPROCESS per job (hunyuan_gen.py) — which also frees all VRAM on exit (safe on 24GB)."""
    name = "hunyuan"
    device = "cuda"
    VENV_PY = os.environ.get("GEN3D_HUNYUAN_PY", "/root/Hunyuan3D-2.1/.venv/bin/python")
    HUNYUAN_DIR = os.environ.get("GEN3D_HUNYUAN_DIR", "/root/Hunyuan3D-2.1")
    GEN_SCRIPT = os.environ.get("GEN3D_HUNYUAN_SCRIPT",
                                os.path.join(os.path.dirname(os.path.abspath(__file__)), "hunyuan_gen.py"))

    def ready(self):
        # "ready" == installed; models load per-job in the subprocess (nothing kept resident here).
        return os.path.exists(self.VENV_PY) and os.path.exists(self.GEN_SCRIPT)

    def unload(self):
        return False  # subprocess frees everything on exit; nothing resident to unload

    def generate(self, jid, req, progress):
        import subprocess
        img = to_wsl_path(req.get("image", ""))
        if not img or not os.path.exists(img):
            raise RuntimeError(f"input image not found: {req.get('image')!r}")
        out = os.path.join(OUT_DIR, jid + ".glb")
        env = dict(os.environ)
        env.setdefault("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", "1")
        env.setdefault("PYTORCH_HIP_ALLOC_CONF", "expandable_segments:True")
        opts = req.get("opts") or {}
        cmd = [self.VENV_PY, self.GEN_SCRIPT, "--image", img, "--out", out,
               "--views", str(opts.get("views", 4)),
               "--render-size", str(opts.get("render_size", 1024)),
               "--texture-size", str(opts.get("texture_size", 2048))]
        proc = subprocess.Popen(cmd, cwd=self.HUNYUAN_DIR, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        last_err = ""
        for line in proc.stdout:
            line = line.rstrip()
            if get_job(jid)["cancel"]:
                proc.terminate()
                raise RuntimeError("cancelled")
            if line.startswith("PROGRESS "):
                parts = line.split(" ", 2)
                try:
                    progress(float(parts[1]), parts[2] if len(parts) > 2 else "working")
                except Exception:
                    pass
            elif line.startswith("ERROR "):
                last_err = line[6:]
            print("[hunyuan] " + line, flush=True)
        proc.wait()
        if proc.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(f"hunyuan generation failed: {last_err or 'exit ' + str(proc.returncode)}")
        return out


def make_backend(name):
    if name == "triposr":
        return TripoSRBackend()
    if name == "hunyuan":
        return HunyuanBackend()
    if name == "trellis":
        raise RuntimeError("trellis backend not wired yet (P2d)")
    return StubBackend()


# Backend instances are cached and selected per request (req['backend']), so one server can host
# the fast tier (triposr, in-process) and the best tier (hunyuan, subprocess) at once.
BACKENDS = {}
BACKENDS_LOCK = threading.Lock()


def get_backend(name):
    name = name or BACKEND
    with BACKENDS_LOCK:
        if name not in BACKENDS:
            BACKENDS[name] = make_backend(name)
        return BACKENDS[name]


BACKEND_IMPL = get_backend(BACKEND)


JOB_RUNNING = [False]

# ── Worker ───────────────────────────────────────────────────────────────────
def worker():
    while True:
        jid = JOB_Q.get()
        j = get_job(jid)
        if not j or j["cancel"]:
            set_job(jid, state="error", error="cancelled")
            continue
        JOB_RUNNING[0] = True
        LAST_ACTIVITY[0] = time.time()
        set_job(jid, state="running", stage="starting", progress=0.02)

        def progress(p, stage):
            set_job(jid, progress=float(p), stage=stage)

        impl = get_backend(j["req"].get("backend"))
        try:
            out = impl.generate(jid, j["req"], progress)
            set_job(jid, state="done", progress=1.0, stage="done",
                    glb=out, glb_win=win_path(out))
        except Exception as e:
            set_job(jid, state="error", stage="error",
                    error="".join(traceback.format_exception_only(type(e), e)).strip() or str(e))
        finally:
            JOB_RUNNING[0] = False
            LAST_ACTIVITY[0] = time.time()
            # Per-job VRAM-tight mode: drop the model right after this job.
            if (j["req"].get("opts") or {}).get("unload_after"):
                impl.unload()


# ── Idle watcher: free the GPU after IDLE_TTL of no jobs ──────────────────────
def idle_watcher():
    while True:
        time.sleep(15)
        if IDLE_TTL <= 0:
            continue
        if not JOB_RUNNING[0] and JOB_Q.empty() and (time.time() - LAST_ACTIVITY[0]) > IDLE_TTL:
            with BACKENDS_LOCK:
                impls = list(BACKENDS.values())
            for impl in impls:
                if impl.ready():
                    impl.unload()


threading.Thread(target=worker, daemon=True).start()
threading.Thread(target=idle_watcher, daemon=True).start()


# ── HTTP ─────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            loaded = BACKEND_IMPL.ready()
            return self._send(200, {"status": "ok", "backend": BACKEND_IMPL.name,
                                    "device": getattr(BACKEND_IMPL, "device", "?"),
                                    "ready": loaded, "loaded": loaded,
                                    "idle_ttl": IDLE_TTL,
                                    "idle_s": round(time.time() - LAST_ACTIVITY[0])})
        if self.path == "/backends":
            with BACKENDS_LOCK:
                loaded = {n: b.ready() for n, b in BACKENDS.items()}
            return self._send(200, {"backends": ["stub", "triposr", "hunyuan", "trellis"],
                                    "active": BACKEND_IMPL.name, "loaded": loaded})
        if self.path.startswith("/job/"):
            j = get_job(self.path[5:])
            if not j:
                return self._send(404, {"error": "no such job"})
            return self._send(200, {k: j[k] for k in ("state", "progress", "stage", "glb", "glb_win", "error")})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n)) if n else {}
        if self.path == "/generate":
            mode = body.get("mode", "image")
            if mode == "text":
                return self._send(400, {"error": "text->3D not enabled (needs txt2img backend, P2d). Use mode:image."})
            if not body.get("image"):
                return self._send(400, {"error": "`image` (path) is required for mode:image."})
            # Optional per-request backend (fast=triposr / best=hunyuan); validate it's installed.
            bname = body.get("backend") or BACKEND
            try:
                if not get_backend(bname).ready():
                    return self._send(400, {"error": f"backend '{bname}' is not installed/ready."})
            except Exception as e:
                return self._send(400, {"error": f"unknown backend '{bname}': {e}"})
            return self._send(200, {"job_id": new_job(body)})
        if self.path.startswith("/cancel/"):
            set_job(self.path[8:], cancel=True)
            return self._send(200, {"ok": True})
        if self.path == "/unload":
            freed = BACKEND_IMPL.unload()
            return self._send(200, {"ok": True, "freed": freed})
        return self._send(404, {"error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"[gen3d] backend={BACKEND_IMPL.name} on :{PORT} (distro={DISTRO}, out={OUT_DIR})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
