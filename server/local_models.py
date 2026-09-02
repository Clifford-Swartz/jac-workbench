"""
Local model management — download, serve, and query GGUF models via llama.cpp.

Models are stored in ~/.jac/models/ and served via llama-server's OpenAI-compatible API.
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
import signal
from pathlib import Path
from typing import Optional, Callable

log = logging.getLogger("local_models")

# ── Model catalog ────────────────────────────────────────────────────────────

MODELS_DIR = Path.home() / ".jac" / "models"

# Curated models — good balance of quality vs size for different RAM amounts
MODEL_CATALOG = [
    # Small (4-8GB RAM)
    {
        "id": "qwen2.5-3b",
        "label": "Qwen 2.5 3B",
        "size": "2.0 GB",
        "repo": "Qwen/Qwen2.5-3B-Instruct-GGUF",
        "filename": "qwen2.5-3b-instruct-q4_k_m.gguf",
        "ram_needed": 4,
        "ctx_default": 8192,
    },
    {
        "id": "llama3.2-3b",
        "label": "Llama 3.2 3B",
        "size": "2.0 GB",
        "repo": "bartowski/Llama-3.2-3B-Instruct-GGUF",
        "filename": "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        "ram_needed": 4,
        "ctx_default": 8192,
    },
    # Medium (8-16GB RAM)
    {
        "id": "qwen2.5-7b",
        "label": "Qwen 2.5 7B",
        "size": "4.7 GB",
        "repo": "Qwen/Qwen2.5-7B-Instruct-GGUF",
        "filename": "qwen2.5-7b-instruct-q4_k_m.gguf",
        "ram_needed": 8,
        "ctx_default": 8192,
    },
    {
        "id": "llama3.1-8b",
        "label": "Llama 3.1 8B",
        "size": "4.9 GB",
        "repo": "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
        "filename": "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
        "ram_needed": 8,
        "ctx_default": 8192,
    },
    {
        "id": "gemma3-12b",
        "label": "Gemma 3 12B",
        "size": "7.3 GB",
        "repo": "bartowski/gemma-3-12b-it-GGUF",
        "filename": "gemma-3-12b-it-Q4_K_M.gguf",
        "ram_needed": 12,
        "ctx_default": 8192,
    },
    # Large (16-32GB RAM, or with Permem)
    {
        "id": "qwen2.5-14b",
        "label": "Qwen 2.5 14B",
        "size": "9.0 GB",
        "repo": "Qwen/Qwen2.5-14B-Instruct-GGUF",
        "filename": "qwen2.5-14b-instruct-q4_k_m.gguf",
        "ram_needed": 16,
        "ctx_default": 4096,
    },
    {
        "id": "qwen2.5-32b",
        "label": "Qwen 2.5 32B",
        "size": "20 GB",
        "repo": "Qwen/Qwen2.5-32B-Instruct-GGUF",
        "filename": "qwen2.5-32b-instruct-q4_k_m.gguf",
        "ram_needed": 24,
        "ctx_default": 4096,
    },
    {
        "id": "llama3.3-70b",
        "label": "Llama 3.3 70B",
        "size": "42 GB",
        "repo": "bartowski/Llama-3.3-70B-Instruct-GGUF",
        "filename": "Llama-3.3-70B-Instruct-Q4_K_M.gguf",
        "ram_needed": 48,
        "ctx_default": 2048,
    },
    # ── MoE models (benefit hugely from Permem) ─────────────────────────────
    {
        "id": "mixtral-8x7b",
        "label": "Mixtral 8x7B (MoE)",
        "size": "26 GB",
        "repo": "TheBloke/Mixtral-8x7B-Instruct-v0.1-GGUF",
        "filename": "mixtral-8x7b-instruct-v0.1.Q4_K_M.gguf",
        "ram_needed": 32,
        "ctx_default": 8192,
        "moe": True,
        "active_params_b": 13,
    },
    {
        "id": "qwen3-30b-a3b",
        "label": "Qwen3 30B-A3B (MoE)",
        "size": "18 GB",
        "repo": "Qwen/Qwen3-30B-A3B-GGUF",
        "filename": "Qwen3-30B-A3B-Q4_K_M.gguf",
        "ram_needed": 20,
        "ctx_default": 2048,
        "moe": True,
        "active_params_b": 3,
    },
    {
        # Deep Reinforce, MIT, Aug 2026. ~3B active of 35B; tops its size class
        # on coding/agentic (SWE-bench Verified 79, Terminal-Bench 2.1 67.8),
        # beating Qwen3.5-397B on both. Multimodal (mmproj shipped separately).
        "id": "ornith-1.5-35b-a3b",
        "label": "Ornith 1.5 35B-A3B (MoE)",
        "size": "21.7 GB",
        "repo": "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
        "filename": "Ornith-1.5-35B-Q4_K_M.gguf",
        "ram_needed": 24,
        "ctx_default": 8192,
        "moe": True,
        "active_params_b": 3,
    },
    {
        # Dense sibling - Q8_0 leaves ~14 GB headroom on a 24 GB card.
        "id": "ornith-1.5-9b",
        "label": "Ornith 1.5 9B",
        "size": "9.8 GB",
        "repo": "ornith-ai/Ornith-1.5-9B-GGUF",
        "filename": "Ornith-1.5-9B-Q8_0.gguf",
        "ram_needed": 12,
        "ctx_default": 8192,
    },
    {
        "id": "mixtral-8x22b",
        "label": "Mixtral 8x22B (MoE)",
        "size": "80 GB",
        "repo": "MaziyarPanahi/Mixtral-8x22B-Instruct-v0.1-GGUF",
        "filename": [
            "Mixtral-8x22B-Instruct-v0.1.Q4_K_M-00001-of-00002.gguf",
            "Mixtral-8x22B-Instruct-v0.1.Q4_K_M-00002-of-00002.gguf",
        ],
        "ram_needed": 96,
        "ctx_default": 4096,
        "moe": True,
        "active_params_b": 39,
    },
    {
        "id": "deepseek-v3-0324",
        "label": "DeepSeek V3 (MoE)",
        "size": "377 GB",
        "repo": "bartowski/DeepSeek-V3-0324-GGUF",
        "filename": "DeepSeek-V3-0324-Q4_K_M.gguf",
        "ram_needed": 400,
        "ctx_default": 2048,
        "moe": True,
        "active_params_b": 37,
    },
]


def get_system_ram_gb() -> int:
    """Get system RAM in GB."""
    try:
        import platform
        if platform.system() == "Darwin":
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)
            return int(int(out.strip()) / (1024**3))
        elif platform.system() == "Linux":
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        return int(int(line.split()[1]) / (1024**2))
        elif platform.system() == "Windows":
            out = subprocess.check_output(
                ["wmic", "ComputerSystem", "get", "TotalPhysicalMemory"],
                text=True,
            )
            for line in out.strip().split("\n"):
                line = line.strip()
                if line.isdigit():
                    return int(int(line) / (1024**3))
    except Exception:
        pass
    return 16  # default guess


def _get_memory_bandwidth_gbs() -> float:
    """Estimate memory bandwidth in GB/s for tok/s estimation."""
    import platform
    if platform.system() != "Darwin":
        return 50.0  # conservative default for non-Mac
    try:
        chip = subprocess.check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
        ).strip().lower()
    except Exception:
        return 100.0
    # Apple Silicon bandwidth table (GB/s)
    bw_table = {
        "m1": 68, "m1 pro": 200, "m1 max": 400, "m1 ultra": 800,
        "m2": 100, "m2 pro": 200, "m2 max": 400, "m2 ultra": 800,
        "m3": 100, "m3 pro": 150, "m3 max": 400, "m3 ultra": 800,
        "m4": 120, "m4 pro": 273, "m4 max": 546, "m4 ultra": 800,
    }
    for name in sorted(bw_table, key=len, reverse=True):
        if name in chip:
            return bw_table[name]
    return 100.0


# Total params (billions) for dense models
_MODEL_PARAMS_B = {
    "qwen2.5-3b": 3, "llama3.2-3b": 3,
    "qwen2.5-7b": 7, "llama3.1-8b": 8,
    "gemma3-12b": 12, "qwen2.5-14b": 14,
    "qwen2.5-32b": 32, "llama3.3-70b": 70,
}


def _get_ssd_bandwidth_gbs() -> float:
    """Estimate SSD sequential read bandwidth in GB/s."""
    import platform
    if platform.system() == "Darwin":
        return 3.5  # Apple NVMe typical
    return 2.0  # conservative default


def estimate_tok_s(model_id: str) -> Optional[int]:
    """Estimate tokens/sec based on hardware and model characteristics.

    Three speed regimes:
    1. Fits in RAM: memory-bandwidth-bound (fast)
       tok/s = mem_bw / (active_params * bytes_per_param) * efficiency
    2. Slightly exceeds RAM (active params fit): mostly fast with
       occasional SSD paging for cold experts
    3. Active params exceed RAM: SSD-bandwidth-bound (very slow)
       tok/s = ssd_bw / (active_bytes_per_token) — often < 1
    """
    catalog_entry = None
    for m in MODEL_CATALOG:
        if m["id"] == model_id:
            catalog_entry = m
            break

    is_moe = catalog_entry.get("moe", False) if catalog_entry else False
    if is_moe and catalog_entry:
        active_params_b = catalog_entry["active_params_b"]
    else:
        active_params_b = _MODEL_PARAMS_B.get(model_id)

    if not active_params_b:
        return None

    ram = get_system_ram_gb()
    mem_bw = _get_memory_bandwidth_gbs()
    ssd_bw = _get_ssd_bandwidth_gbs()
    bytes_per_param = 0.56  # Q4_K_M average
    active_gb = active_params_b * bytes_per_param  # data read per token

    model_size_gb = float(catalog_entry["size"].split()[0]) if catalog_entry else active_gb
    # Usable RAM for model (after OS, KV cache, etc.)
    usable_ram = ram * 0.7

    if model_size_gb <= usable_ram:
        # Regime 1: fits in RAM — memory bandwidth bound, full GPU
        tok_s = (mem_bw / active_gb) * 0.7
    elif active_gb <= usable_ram:
        # Regime 2: model overflows but active params fit in RAM.
        # Uses pmem build with partial GPU offload (~10 layers).
        # --no-repack and --batch-size 2 trade startup speed for
        # inference speed. CPU-heavy with some GPU acceleration.
        # Measured: ~2-3 tok/s for 17 GB MoE on 16 GB M4 with 10 GPU layers.
        overflow = model_size_gb / usable_ram
        if overflow <= 1.3:
            # Barely overflows — most data stays hot, partial GPU helps
            tok_s = (mem_bw / active_gb) * 0.15  # ~15% of theoretical due to no-repack + partial GPU
        else:
            # More overflow — more paging, less GPU benefit
            tok_s = (mem_bw / active_gb) * 0.08
    else:
        # Regime 3: active params exceed RAM — SSD bound, unusable
        tok_s = 0

    return max(1, int(tok_s)) if tok_s >= 0.5 else 0


def _get_filenames(catalog_entry: dict) -> list:
    """Return filename(s) as a list, whether single string or list."""
    fn = catalog_entry["filename"]
    return fn if isinstance(fn, list) else [fn]


def get_model_status(model_id: str) -> str:
    """Check if a model is downloaded."""
    for m in MODEL_CATALOG:
        if m["id"] == model_id:
            filenames = _get_filenames(m)
            if all((MODELS_DIR / f).exists() for f in filenames):
                return "ready"
            return "not_downloaded"
    return "not_downloaded"


def list_models() -> list:
    """List all catalog models with their status."""
    ram = get_system_ram_gb()
    result = []
    for m in MODEL_CATALOG:
        status = get_model_status(m["id"])
        entry: dict = {
            "id": m["id"],
            "label": m["label"],
            "size": m["size"],
            "status": status,
            "fits_ram": m["ram_needed"] <= ram,
        }
        if m.get("moe"):
            entry["moe"] = True
        tok_s = estimate_tok_s(m["id"])
        if tok_s is not None:
            entry["est_tok_s"] = tok_s
        result.append(entry)
    return result


# ── Model download ───────────────────────────────────────────────────────────

async def download_model(
    model_id: str,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> bool:
    """Download a model from HuggingFace. Returns True on success."""
    catalog_entry = None
    for m in MODEL_CATALOG:
        if m["id"] == model_id:
            catalog_entry = m
            break
    if not catalog_entry:
        log.error("Unknown model: %s", model_id)
        return False

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    filenames = _get_filenames(catalog_entry)

    if all((MODELS_DIR / f).exists() for f in filenames):
        log.info("Model already downloaded: %s", filenames[0])
        return True

    repo = catalog_entry["repo"]

    if progress_cb:
        progress_cb(f"Downloading {catalog_entry['label']} ({catalog_entry['size']})...")

    try:
        from huggingface_hub import hf_hub_download

        for i, filename in enumerate(filenames):
            if (MODELS_DIR / filename).exists():
                log.info("Part %d/%d already exists: %s", i + 1, len(filenames), filename)
                continue

            log.info("Downloading %s from %s (%d/%d)", filename, repo, i + 1, len(filenames))
            if progress_cb and len(filenames) > 1:
                progress_cb(f"Downloading part {i + 1}/{len(filenames)}: {filename}")

            await asyncio.get_event_loop().run_in_executor(
                None,
                lambda fn=filename: hf_hub_download(
                    repo_id=repo,
                    filename=fn,
                    local_dir=str(MODELS_DIR),
                    local_dir_use_symlinks=False,
                ),
            )

        log.info("Downloaded %s (%d file%s)", catalog_entry['label'],
                 len(filenames), "s" if len(filenames) > 1 else "")
        if progress_cb:
            progress_cb(f"Downloaded {catalog_entry['label']}!")
        return True
    except Exception as e:
        log.error("Download failed: %s", e)
        if progress_cb:
            progress_cb(f"Download failed: {e}")
        return False


# ── llama-server management ──────────────────────────────────────────────────

class LlamaServer:
    """Manages a llama-server process for a specific model."""

    def __init__(self):
        self.process: Optional[subprocess.Popen] = None
        self.current_model: Optional[str] = None
        self.port: int = 8787
        self.ready = False
        self.thinking_cb: Optional[Callable[[str], None]] = None

    def find_llama_server(self, needs_pmem: bool = False) -> Optional[str]:
        """Find llama-server binary.

        Uses Permem-enabled build only when the model exceeds available RAM
        (needs_pmem=True). For models that fit in RAM, the system llama-server
        is preferred since pmem's Mach-mapped regions aren't Metal-compatible.
        """
        pmem_build = str(Path.home() / "Desktop" / "pmem" / "Permem" / "vendor" / "llama.cpp" / "build-pmem" / "bin" / "llama-server")

        if needs_pmem and os.path.exists(pmem_build):
            log.info("Using Permem-enabled llama-server (model exceeds RAM): %s", pmem_build)
            return pmem_build

        # Bundled build that ships next to this repo (jac-llm-server-src). On
        # Windows this is the Vulkan build, which is the GPU path on AMD -
        # llama.cpp's ROCm backend is measurably SLOWER than Vulkan on gfx1100
        # (ggml-org/llama.cpp#20934), so we prefer it and do not look for HIP.
        here = Path(__file__).resolve()
        for parent in here.parents[:4]:
            for exe in ("llama-server.exe", "llama-server"):
                bundled = parent / "jac-llm-server-src" / "llama.cpp" / "build" / "bin" / exe
                if bundled.exists():
                    log.info("Using bundled llama-server: %s", bundled)
                    return str(bundled)

        # System llama-server (works with Metal GPU acceleration)
        path = shutil.which("llama-server")
        if path:
            log.info("Using system llama-server: %s", path)
            return path
        import platform
        fallback_paths = [str(Path.home() / "bin" / "llama-server")]
        if platform.system() == "Darwin":
            fallback_paths = ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"] + fallback_paths
        elif platform.system() == "Linux":
            fallback_paths = ["/usr/local/bin/llama-server", "/usr/bin/llama-server"] + fallback_paths
        elif platform.system() == "Windows":
            fallback_paths = [
                str(Path.home() / "AppData" / "Local" / "Programs" / "llama-server" / "llama-server.exe"),
            ] + fallback_paths
        for p in fallback_paths:
            if os.path.exists(p):
                log.info("Using system llama-server: %s", p)
                return p

        # Last resort: pmem build even for small models
        if os.path.exists(pmem_build):
            log.info("Falling back to Permem llama-server (no system build found): %s", pmem_build)
            return pmem_build
        return None

    async def start(self, model_id: str) -> bool:
        """Start llama-server for a model. Stops any existing server first."""
        if self.current_model == model_id and self.ready:
            return True  # already running this model

        await self.stop()

        # Find the model file
        catalog_entry = None
        for m in MODEL_CATALOG:
            if m["id"] == model_id:
                catalog_entry = m
                break
        if not catalog_entry:
            log.error("Unknown model: %s", model_id)
            return False

        filenames = _get_filenames(catalog_entry)
        # For split GGUFs, pass the first file — llama-server auto-discovers the rest
        model_path = MODELS_DIR / filenames[0]
        if not all((MODELS_DIR / f).exists() for f in filenames):
            log.error("Model not fully downloaded: %s", filenames)
            return False

        ram = get_system_ram_gb()
        needs_pmem = catalog_entry["ram_needed"] > ram
        server_bin = self.find_llama_server(needs_pmem=needs_pmem)
        if not server_bin:
            log.error("llama-server not found")
            return False

        ctx_size = catalog_entry.get("ctx_default", 4096)
        is_moe = catalog_entry.get("moe", False)
        overflow_ratio = catalog_entry["ram_needed"] / ram if ram > 0 else 999

        # Determine GPU/CPU split strategy based on model size vs RAM
        extra_flags: list = []
        if not needs_pmem:
            # Model fits in RAM — full GPU offload, system llama-server
            gpu_layers = 99
            log.info("Model fits in RAM: full GPU offload")
        elif overflow_ratio <= 1.5:
            # Barely exceeds RAM (e.g. 18 GB model on 16 GB) — partial GPU
            # offload with pmem. Use 10 GPU layers (~3.5 GB on Metal),
            # rest on CPU with demand paging. Pmem build with fast-start flags.
            gpu_layers = 10
            extra_flags = [
                "--no-repack",      # skip 80 GB tensor reformat
                "--no-warmup",      # skip warmup inference
                "--parallel", "1",  # single slot, fewer graph splits
                "--batch-size", "2",
                "--ubatch-size", "2",
                "-fit", "off",      # we handle fitting ourselves
                "--cache-type-k", "tq4",   # TurboQuant 3.8x KV compression, 0.996 cosine
                "--cache-type-v", "tq4",
            ]
            log.info("Pmem partial GPU: %d layers on Metal, rest on CPU/pmem (overflow %.1fx)",
                     gpu_layers, overflow_ratio)
        elif overflow_ratio <= 3.0 and is_moe:
            # MoE model moderately exceeding RAM — CPU-only with fast-start
            gpu_layers = 0
            extra_flags = [
                "--no-repack", "--no-warmup",
                "--parallel", "1",
                "--batch-size", "2", "--ubatch-size", "2",
                "-fit", "off",
                "--cache-type-k", "tq4", "--cache-type-v", "tq4",
            ]
            log.info("MoE+pmem CPU-only: %.1fx overflow, fast-start mode", overflow_ratio)
        else:
            # Massively exceeds RAM — CPU-only, fast-start
            gpu_layers = 0
            extra_flags = [
                "--no-repack", "--no-warmup",
                "--parallel", "1",
                "--batch-size", "2", "--ubatch-size", "2",
                "--cache-type-k", "tq4", "--cache-type-v", "tq4",
                "-fit", "off",
            ]
            log.info("Large model pmem: CPU-only, %.1fx overflow", overflow_ratio)

        cmd = [
            server_bin,
            "--model", str(model_path),
            "--port", str(self.port),
            "--ctx-size", str(ctx_size),
            "--n-gpu-layers", str(gpu_layers),
            "--host", "127.0.0.1",
        ] + extra_flags

        log.info("Starting llama-server: %s", " ".join(cmd))

        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.current_model = model_id

        # Wait for server to be ready (poll health endpoint)
        # Large models need more time to load (especially through pmem)
        import aiohttp
        timeout_secs = 60 + (catalog_entry["ram_needed"] // 8) * 30  # scale with size
        log.info("Waiting up to %ds for model to load...", timeout_secs)
        for attempt in range(timeout_secs):
            await asyncio.sleep(1)
            if self.process.poll() is not None:
                # Process died
                stderr = self.process.stderr.read().decode() if self.process.stderr else ""
                log.error("llama-server died: %s", stderr[:500])
                self.process = None
                self.current_model = None
                return False
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        f"http://127.0.0.1:{self.port}/health",
                        timeout=aiohttp.ClientTimeout(total=2),
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            if data.get("status") == "ok":
                                self.ready = True
                                log.info("llama-server ready for %s", model_id)
                                return True
            except Exception:
                pass  # not ready yet

        log.error("llama-server failed to start within %ds", timeout_secs)
        await self.stop()
        return False

    async def stop(self):
        """Stop the current llama-server process."""
        if self.process:
            log.info("Stopping llama-server (PID %d)", self.process.pid)
            try:
                self.process.send_signal(signal.SIGTERM)
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
            except Exception:
                pass
            self.process = None
        self.current_model = None
        self.ready = False

    async def _background_warmup(self):
        """Send a dummy request to warm up pmem page cache in background.

        Pages in active expert weights (~2/8 per layer) so the first real
        user request doesn't pay the full cold-start penalty. Runs async
        after the server reports healthy.
        """
        import aiohttp
        log.info("pmem: starting background warmup...")
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"http://127.0.0.1:{self.port}/v1/chat/completions",
                    json={
                        "model": self.current_model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                    },
                    timeout=aiohttp.ClientTimeout(total=600),
                ) as resp:
                    await resp.read()
            log.info("pmem: background warmup complete — experts cached")
        except Exception as e:
            log.warning("pmem: background warmup failed: %s", e)

    async def query(
        self,
        messages: list,
        stream_cb: Optional[Callable[[str], None]] = None,
    ) -> str:
        """Send a chat completion request to the running llama-server."""
        if not self.ready:
            return "Error: Local model server not ready"

        import aiohttp

        payload = {
            "model": self.current_model,
            "messages": messages,
            "stream": stream_cb is not None,
            "max_tokens": 2048,
            "repetition_penalty": 1.3,
            "temperature": 0.7,
            "top_p": 0.8,
        }

        url = f"http://127.0.0.1:{self.port}/v1/chat/completions"

        async with aiohttp.ClientSession() as session:
            if stream_cb:
                # Streaming response — route reasoning_content to thinking_cb,
                # content to stream_cb. If content is empty after streaming,
                # the model only produced thinking — send thinking as response.
                full_response = ""
                full_thinking = ""
                async with session.post(url, json=payload) as resp:
                    async for line in resp.content:
                        line = line.decode().strip()
                        if line.startswith("data: "):
                            data = line[6:]
                            if data == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data)
                                delta = chunk["choices"][0]["delta"]
                                thinking = delta.get("reasoning_content") or ""
                                content = delta.get("content") or ""
                                if thinking:
                                    full_thinking += thinking
                                    # Don't stream thinking to UI — too slow
                                    # at 2-3 tok/s. Just accumulate silently.
                                if content:
                                    full_response += content
                                    stream_cb(content)
                            except (json.JSONDecodeError, KeyError, IndexError):
                                pass
                if full_response:
                    return full_response
                # Model only produced thinking — extract the last
                # conclusion/answer from the reasoning as the response
                if full_thinking:
                    # Look for common answer patterns in thinking
                    for marker in ["\n\n", "So,", "Therefore", "I'll go with", "answer is"]:
                        idx = full_thinking.rfind(marker)
                        if idx > len(full_thinking) // 2:
                            answer = full_thinking[idx:].strip()
                            stream_cb(answer)
                            return answer
                    # Fallback: last sentence
                    lines = [l.strip() for l in full_thinking.strip().split('\n') if l.strip()]
                    if lines:
                        stream_cb(lines[-1])
                        return lines[-1]
                return ""
            else:
                # Non-streaming
                async with session.post(url, json=payload) as resp:
                    data = await resp.json()
                    msg = data["choices"][0]["message"]
                    return msg.get("content") or msg.get("reasoning_content") or ""


# ── Singleton ────────────────────────────────────────────────────────────────

_server = LlamaServer()


def get_server() -> LlamaServer:
    return _server
