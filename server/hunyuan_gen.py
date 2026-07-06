#!/usr/bin/env python3
"""
Standalone Hunyuan3D 2.1 image -> textured GLB generator (AMD / ROCm / 7900 XTX).

Runs INSIDE the Hunyuan venv (python3.10, torch rocm), spawned as a subprocess by the
gen3d server's HunyuanBackend. Does shape -> UNLOAD -> paint sequentially so VRAM never
holds both models at once (fits 24GB). Emits `PROGRESS <frac> <stage>` lines on stdout for
the server to parse, and `DONE <path> <bytes>` / `ERROR <msg>` at the end.

Encodes the hard-won AMD fixes (see jac.md chronicle):
  - SDPA: enable flash+mem+math; needs TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1 in env
    (else the multiview attention tries to allocate ~67GB).
  - paint kept lean for 24GB: 4 views / render 1024 / texture 2048.
  - bpy removed -> trimesh convert (patched in hy3dpaint/DifferentiableRenderer/mesh_utils.py).
Env vars set by the parent: TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1, PYTORCH_HIP_ALLOC_CONF=expandable_segments:True
"""
import sys, os, time, gc, argparse, traceback


def prog(frac, stage):
    print(f"PROGRESS {frac:.2f} {stage}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--hunyuan-dir", default=os.environ.get("GEN3D_HUNYUAN_DIR", "/root/Hunyuan3D-2.1"))
    ap.add_argument("--weights", default=os.environ.get("GEN3D_HUNYUAN_WEIGHTS", "/root/hy3d21-weights"))
    ap.add_argument("--views", type=int, default=4)
    ap.add_argument("--render-size", type=int, default=1024)
    ap.add_argument("--texture-size", type=int, default=2048)
    args = ap.parse_args()

    import torch
    # RDNA3: enable flash + mem-efficient (via AOTriton) so the big multiview attention doesn't
    # materialize an N^2 matrix and OOM; keep math as fallback.
    torch.backends.cuda.enable_flash_sdp(True)
    torch.backends.cuda.enable_mem_efficient_sdp(True)
    torch.backends.cuda.enable_math_sdp(True)

    HD = args.hunyuan_dir
    os.chdir(HD)
    sys.path.insert(0, HD)
    sys.path.insert(0, os.path.join(HD, "hy3dshape"))
    sys.path.insert(0, os.path.join(HD, "hy3dpaint"))
    try:
        from torchvision_fix import apply_fix
        apply_fix()
    except Exception as e:
        print(f"(torchvision_fix skipped: {e})", flush=True)

    from PIL import Image

    out = args.out
    base = os.path.splitext(out)[0]

    # ---------- Shape ----------
    prog(0.05, "loading shape model")
    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
    shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(args.weights)

    image = Image.open(args.image).convert("RGBA")
    # Remove background if the image is opaque (needs a clean subject on transparent bg).
    try:
        opaque = image.getchannel("A").getextrema() == (255, 255)
        if opaque:
            from hy3dshape.rembg import BackgroundRemover
            image = BackgroundRemover()(image.convert("RGB"))
    except Exception as e:
        print(f"(rembg skipped: {e})", flush=True)

    prog(0.15, "generating shape (~4-5 min)")
    mesh = shape(image=image)[0]
    shape_glb = base + "_shape.glb"
    mesh.export(shape_glb)
    prog(0.50, "shape done")

    # ---------- unload shape, free VRAM before paint ----------
    del shape, mesh
    gc.collect()
    torch.cuda.empty_cache()
    prog(0.52, "freed shape from VRAM")

    # ---------- Paint (PBR) ----------
    prog(0.55, "loading paint model")
    from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig
    conf = Hunyuan3DPaintConfig(args.views, 512)
    conf.realesrgan_ckpt_path = os.path.join(HD, "hy3dpaint/ckpt/RealESRGAN_x4plus.pth")
    conf.multiview_cfg_path = os.path.join(HD, "hy3dpaint/cfgs/hunyuan-paint-pbr.yaml")
    conf.custom_pipeline = os.path.join(HD, "hy3dpaint/hunyuanpaintpbr")
    conf.render_size = args.render_size
    conf.texture_size = args.texture_size
    paint = Hunyuan3DPaintPipeline(conf)

    prog(0.65, "painting multiview PBR (~5-6 min)")
    obj_out = base + ".obj"
    # paint() writes obj_out + PBR maps, then convert_obj_to_glb -> <base>.glb (our trimesh version)
    paint(mesh_path=shape_glb, image_path=args.image, output_mesh_path=obj_out)
    glb_out = base + ".glb"

    if os.path.abspath(glb_out) != os.path.abspath(out):
        import shutil
        shutil.move(glb_out, out)

    if not os.path.exists(out):
        print("ERROR no output GLB produced", flush=True)
        return 1
    prog(1.0, "done")
    print(f"DONE {out} {os.path.getsize(out)}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("ERROR " + "".join(traceback.format_exception_only(type(e), e)).strip(), flush=True)
        traceback.print_exc()
        sys.exit(1)
