# Hunyuan3D Desktop Server Setup

## What This Does
Sets up your AMD RX 7900 XTX desktop as a 3D model generation server.
JAC on your MacBook sends text/image prompts → desktop runs Hunyuan3D → sends back GLB meshes → Three.js renders them in the CAD panel.

## Prerequisites
- AMD RX 7900 XTX (24GB VRAM) ✓
- Ubuntu 22.04+ or Windows with WSL2
- Python 3.10+
- ~30GB disk space for model weights

## Step 1: Install ROCm (AMD GPU Compute)

```bash
# Ubuntu 22.04/24.04
wget https://repo.radeon.com/amdgpu-install/latest/ubuntu/jammy/amdgpu-install_6.4.60400-1_all.deb
sudo dpkg -i amdgpu-install_6.4.60400-1_all.deb
sudo amdgpu-install --usecase=rocm
sudo usermod -aG render,video $USER

# Verify
rocminfo | grep "Name:" | head -5
# Should show "gfx1100" for 7900 XTX
```

## Step 2: Install PyTorch with ROCm

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm6.3

# Verify GPU is visible
python -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
# Should print: True / AMD Radeon RX 7900 XTX
```

## Step 3: Clone and Install Hunyuan3D-2.1

```bash
git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git
cd Hunyuan3D-2.1
pip install -r requirements.txt
pip install flask

# Download model weights (will auto-download on first run, or manually):
# The model is hosted on HuggingFace — ~15GB total
python -c "from huggingface_hub import snapshot_download; snapshot_download('tencent/Hunyuan3D-2.1', local_dir='./weights')"
```

## Step 4: Create the JAC 3D Server

Save this as `jac_3d_server.py` in the Hunyuan3D directory:

```python
"""
JAC 3D Model Generation Server
Receives text/image prompts from JAC, runs Hunyuan3D, returns GLB meshes.
"""
import os
import sys
import json
import time
import uuid
import base64
import logging
from pathlib import Path
from flask import Flask, request, jsonify, send_file

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("jac-3d")

app = Flask(__name__)

# Lazy-load the model to avoid slow startup
model = None

def get_model():
    global model
    if model is None:
        log.info("Loading Hunyuan3D-2.1 model...")
        # Import and initialize the model
        # Adjust this import based on Hunyuan3D-2.1's actual API
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
        model = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            "tencent/Hunyuan3D-2.1",
            torch_dtype="float16",
            device="cuda"
        )
        log.info("Model loaded!")
    return model

OUTPUT_DIR = Path("./outputs")
OUTPUT_DIR.mkdir(exist_ok=True)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model_loaded": model is not None})


@app.route("/generate", methods=["POST"])
def generate():
    """Generate a 3D model from text or image.

    Request body:
        text: str — text prompt (e.g. "a red dragon")
        image: str — base64 encoded image (optional, for image-to-3D)
        steps: int — diffusion steps (default 50, lower = faster)
        format: str — output format: "glb" or "obj" (default "glb")

    Returns:
        JSON with download URL, or the file directly if ?download=true
    """
    data = request.json or {}
    text = data.get("text", "")
    image_b64 = data.get("image")
    steps = data.get("steps", 50)
    output_format = data.get("format", "glb")

    if not text and not image_b64:
        return jsonify({"ok": False, "error": "Provide 'text' or 'image'"}), 400

    job_id = str(uuid.uuid4())[:8]
    output_path = OUTPUT_DIR / f"{job_id}.{output_format}"

    log.info(f"Job {job_id}: text='{text[:50]}', steps={steps}")
    t0 = time.time()

    try:
        pipe = get_model()

        # Handle image input
        image = None
        if image_b64:
            import io
            from PIL import Image
            image_bytes = base64.b64decode(image_b64)
            image = Image.open(io.BytesIO(image_bytes))

        # Generate mesh
        # NOTE: Adjust this call based on Hunyuan3D-2.1's actual API
        # The API may differ — check the repo's README/examples
        result = pipe(
            prompt=text if text else None,
            image=image,
            num_inference_steps=steps,
        )

        # Export to GLB/OBJ
        # The result object should have an export method
        if hasattr(result, 'export'):
            result.export(str(output_path))
        elif hasattr(result, 'meshes'):
            result.meshes[0].export(str(output_path))
        else:
            # Try trimesh export
            import trimesh
            mesh = trimesh.Trimesh(
                vertices=result.vertices,
                faces=result.faces
            )
            mesh.export(str(output_path))

        elapsed = time.time() - t0
        size_mb = output_path.stat().st_size / (1024 * 1024)
        log.info(f"Job {job_id}: done in {elapsed:.1f}s, {size_mb:.1f}MB")

        return jsonify({
            "ok": True,
            "job_id": job_id,
            "elapsed_s": round(elapsed, 1),
            "size_mb": round(size_mb, 2),
            "download_url": f"/download/{job_id}.{output_format}",
        })

    except Exception as e:
        log.error(f"Job {job_id}: failed — {e}")
        import traceback
        return jsonify({"ok": False, "error": str(e), "traceback": traceback.format_exc()}), 500


@app.route("/download/<filename>", methods=["GET"])
def download(filename):
    """Download a generated mesh file."""
    path = OUTPUT_DIR / filename
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    return send_file(str(path), as_attachment=True)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5060
    log.info(f"JAC 3D Server starting on http://0.0.0.0:{port}")
    log.info(f"GPU: {os.popen('rocm-smi --showproductname 2>/dev/null || echo unknown').read().strip()}")
    app.run(host="0.0.0.0", port=port, debug=False)
```

## Step 5: Run the Server

```bash
cd Hunyuan3D-2.1
python jac_3d_server.py 5060
```

First request will take ~30s to load the model. Subsequent requests: 10-30s per mesh.

## Step 6: Test It

```bash
# From the desktop itself
curl -X POST http://localhost:5060/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "a small toy robot", "steps": 30}'

# Download the result
curl -O http://localhost:5060/download/JOBID.glb
```

## Step 7: Expose to Your MacBook

### Option A: Same Network (LAN)
```bash
# Find your desktop's IP
hostname -I | awk '{print $1}'
# e.g. 192.168.1.100

# From MacBook, test:
curl http://192.168.1.100:5060/health
```

### Option B: Different Network (Tunnel)

Use cloudflared (free, no account needed):
```bash
# On desktop:
# Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:5060

# It prints a public URL like: https://something-random.trycloudflare.com
# Use that URL from your MacBook
```

Or use ngrok:
```bash
ngrok http 5060
# Gives you a public URL
```

### Option C: Through JAC's Existing Relay
We can add a 3D generation endpoint to the bridge_client.py that forwards requests through the relay WebSocket. This way the desktop registers as a "3D provider" alongside the existing Claude provider.

## Step 8: Connect to JAC (done on MacBook side)

Once the server is running and reachable, we'll add to the JAC CAD panel:
1. Settings field for "3D Server URL" (e.g. `http://192.168.1.100:5060` or cloudflared URL)
2. "Generate" button in CAD panel — sends text prompt to the 3D server
3. GLB loader in Three.js — renders the returned mesh
4. Hybrid workflow: AI generates base shape → build123d modifies it

## Troubleshooting

### ROCm not detecting GPU
```bash
# Check if GPU is visible
rocm-smi
# If not, ensure you're in the render/video groups and reboot
sudo usermod -aG render,video $USER
sudo reboot
```

### PyTorch not using GPU
```bash
python -c "import torch; print(torch.version.hip)"
# Should print the HIP version, not None
# If None, reinstall PyTorch with the correct ROCm version
```

### Hunyuan3D import errors
```bash
# Some dependencies may need manual install on AMD
pip install trimesh pygltflib open3d
# If open3d fails on ROCm, skip it — only needed for visualization
```

### Out of VRAM
```bash
# Use half precision and fewer steps
# In jac_3d_server.py, the model loads with float16 by default
# Reduce steps to 25-30 for faster/lighter generation
# The 7900 XTX's 24GB should handle the full model easily
```

## What This Enables

Once connected, you can say in JAC chat:

> "Generate a dragon figurine"

And get a full 3D mesh rendered in the CAD viewer within 10-30 seconds. Then:

> "Add a flat base to the bottom for 3D printing"

And build123d modifies the mesh parametrically. AI art + engineering CAD in one workflow.
