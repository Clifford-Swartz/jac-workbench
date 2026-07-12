# CAD — setup & usage guide (for the assistant)

You are helping the user get JAC's **CAD** feature working and then use it. The CAD *tab* (UI) always exists; this guide is about the **backend** that makes it function.

## What CAD needs
- **Python 3.11–3.13** on the machine (JAC finds it automatically).
- **`build123d`** — the parametric CAD kernel (OpenCascade). This is the big one.
- **`fontTools`** — used for text/emboss features.
- The **`cad_tools.py`** server, which JAC starts on demand at `http://127.0.0.1:5050`. It ships inside the app.

Component id in `setup_status` / `setup_install`: **`cad`** (and **`python`** for the interpreter).

## Getting the user set up
1. Call **`setup_status`**. Find the `cad` entry (and `python`).
2. Interpret it:
   - `cad` = **ready** → already working. Skip to *Using CAD*.
   - `cad` = **partial** → the tool script + Python are present but `build123d` isn't installed. Fixable.
   - `cad` = **missing** → Python itself is missing. Install `python` first (`setup_install` id `python`), then `cad`.
3. Tell the user plainly what you are about to install and the rough size (**build123d ≈ 400 MB**), then, once they agree, call **`setup_install`** with `id: "cad"`. This runs `pip install --user build123d fonttools` and streams the log back to you.
4. When it returns, call **`setup_status`** again and confirm `cad` is now **ready**. If it still fails, read the log tail you got back — common causes: no internet, a wheel that needs a C++ build (rare for build123d, which ships wheels), or `pip` pointing at the wrong Python.
5. Offer to open the tab: use **`ui_open_panel`** with `panel: "cad"`.

## Using CAD (once ready)
You drive the live CAD scene with these tools — you do NOT write files:
- **`cad_execute`** — run `build123d` Python; assign the final solid (or list) to `RESULT`. It renders live in the tab. `build123d` is auto-imported. Builders: `Box(l,w,h)`, `Cylinder(r,h)`, `Sphere(r)`, `Cone(bottom,top,h)`, `Torus(major,minor)`. Combine with `+` (union), `-` (cut), `&` (intersect); edit edges with `.fillet(r)` / `.chamfer(s)`. `RESULT` replaces the whole scene unless you build on the pre-bound `INPUT_SHAPES` list (e.g. `RESULT = INPUT_SHAPES + [Box(10,10,10)]`).
- **`cad_list_parts`** — inspect current parts (index, dims, volume, center) before editing.
- **`cad_transform`** — translate/rotate/scale a part by index.
- **`cad_boolean`** — union/cut/intersect two parts by index.

First `cad_execute` after setup will spin up the `:5050` server automatically — a `:5050 not responding` status just means it has not been started yet, not that anything is missing.

Quick example the user can try: *"a 40×20×10 mm box with 3 mm filleted top edges"* →
```python
RESULT = Box(40, 20, 10).fillet(3)
```

## Talking to the user
Be concrete and short. Confirm before installing. Report what changed ("build123d installed, CAD is ready — want me to open the tab and make a test part?"). If Python is missing, explain that CAD needs it and offer to install both in order.
