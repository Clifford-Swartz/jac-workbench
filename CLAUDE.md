# JAC — AI Workbench VSCode Extension

## ⚠️ Two repos, two bridge_client.py files — DO NOT mirror by copy

`Clifford-Swartz/jac` (this monorepo) and `Clifford-Swartz/jac-bridge` (the
standalone bridge) BOTH have a file called `bridge_client.py` at their root.
**They are intentionally not identical.** This monorepo's version is the
leading edge — it carries features the standalone doesn't:
`apply_patch`, `PARALLEL_SAFE` concurrent reads, loop detection, the fuller
OR-identity system prompt, etc. The slim `jac-bridge` repo is meant for users
who just want the daemon and don't need these.

**Do not** `cp` the file from one repo to the other. Doing so silently strips
features. If a change applies to both, use the Edit tool against each path
separately, surgically. Verify with `git diff` before commit. A previous
session got this wrong twice and nuked ~127 lines each time — it's a real
foot-gun.

## What This Is
A VSCode extension that provides a unified AI workspace: chat with cloud/local LLMs, 3D CAD modeling, PCB schematic design, music visualization with Spotify, and a browser panel. Everything runs through a WebSocket relay so multiple machines can share providers.

## Architecture Overview

```
┌─ VSCode Extension (TypeScript) ──────────────────────────┐
│  webviewProvider.ts — Main chat panel                     │
│  cadPanel.ts — 3D CAD + schematic editor (Three.js/SVG)  │
│  musicPanel.ts — Spotify controller + audio visualizer    │
│  browserPanel.ts — Chromium browser panel                 │
│  audioCapture.ts — ScreenCaptureKit audio + volume watch  │
│  wsClient.ts — WebSocket client to relay                  │
└──────────────┬───────────────────────────────────────────┘
               │ WebSocket
┌──────────────▼───────────────────────────────────────────┐
│  Relay (mellow.py on Render)                              │
│  Multi-provider routing, model discovery, failover        │
│  GitHub: Clifford-Swartz/mellow → mellow.py               │
└──────────────┬───────────────────────────────────────────┘
               │ WebSocket
┌──────────────▼───────────────────────────────────────────┐
│  Bridge Client (bridge_client.py)                         │
│  Runs on provider machine, routes to:                     │
│  ├── Claude CLI (sonnet/opus/haiku)                       │
│  ├── Codex CLI (gpt-4o/o3/o4)                             │
│  ├── Gemini CLI                                           │
│  ├── Local llama-server (llm:* models)                    │
│  └── Remote LLM endpoints (JAC_LLM_ENDPOINTS env var)     │
└──────────────────────────────────────────────────────────┘

┌─ Local Tool Servers (Python, localhost) ─────────────────┐
│  server/cad_tools.py (port 5050) — build123d 3D geometry  │
│  server/pcb_tools.py (port 5051) — schematic components   │
│  server/local_models.py — llama-server management         │
└──────────────────────────────────────────────────────────┘

┌─ Native Binary (Swift, macOS) ───────────────────────────┐
│  extension/native/jac-audio                               │
│  ├── capture-audio — ScreenCaptureKit system audio capture│
│  ├── volume-watch — poll speaker volume changes           │
│  ├── volume-daemon — CGEventTap media key interception    │
│  ├── activate/restore — audio device management           │
│  └── get-volume/set-volume — CoreAudio speaker control    │
└──────────────────────────────────────────────────────────┘
```

## Key Files

### Extension (TypeScript)
- `extension/src/extension.ts` — Entry point, registers commands
- `extension/src/webviewProvider.ts` — Main chat panel, local model inference, CAD/schematic auto-execution
- `extension/src/cadPanel.ts` — 3D viewer (Three.js) + schematic editor (SVG) + tool server management
- `extension/src/musicPanel.ts` — Spotify integration, audio visualization modes
- `extension/src/audioCapture.ts` — ScreenCaptureKit capture, FFT analysis, per-band normalization
- `extension/src/musicController.ts` — Platform-specific music control (Darwin/Win32/Linux)
- `extension/src/browserPanel.ts` — Chromium browser via CDP
- `extension/src/wsClient.ts` — WebSocket client with session_id injection
- `extension/src/webview/main.ts` — Chat webview UI (messages, thinking bubbles, model picker, tool rendering)
- `extension/src/webview/music.ts` — Music visualizer (8 modes: spectrum, wave, pulse, radial, sinewave, orbit, glow, fractal)
- `extension/package.json` — Extension manifest, commands, settings

### Server (Python)
- `bridge_client.py` — Provider bridge: connects to relay, routes queries to Claude/Codex/Gemini/local LLMs
- `server/local_models.py` — Model catalog, download management, llama-server start/stop, tok/s estimation
- `server/cad_tools.py` — build123d geometry execution, tessellation, STL export (port 5050)
- `server/pcb_tools.py` — Schematic components, A* wire routing, KiCad export (port 5051)

### Relay (Python, deployed on Render)
- `relay/relay.py` — Local copy of the relay server
- Deployed as `mellow.py` in GitHub repo `Clifford-Swartz/mellow`
- Push relay changes: use GitHub API via `gh` CLI (see Deployment section)

### Native (Swift, macOS only)
- `extension/native/jac-audio.swift` — Audio capture, volume control, media keys
- `extension/native/jac-audio` — Compiled binary (included in VSIX)

### Static Assets (bundled in VSIX)
- `extension/dist/webview/three.min.js` — Three.js 0.128 (bundled locally, not CDN)
- `extension/dist/webview/OrbitControls.js` — Camera orbit controls
- `extension/dist/webview/TransformControls.js` — Move/rotate/scale gizmos
- `extension/dist/webview/GLTFLoader.js` — GLB/GLTF model loading

## Building

### Extension
```bash
cd extension

# Install dependencies (first time)
npm install

# Build
npx webpack --mode production

# Package as VSIX
npx vsce package --no-dependencies

# Install in VSCode
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension jac-0.2.3.vsix --force

# All in one:
npx webpack --mode production && npx vsce package --no-dependencies && "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension jac-0.2.3.vsix --force
```

### Native binary (macOS)
```bash
cd extension/native
swiftc -O -framework CoreAudio -framework CoreGraphics -framework Cocoa -framework IOKit -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia jac-audio.swift -o jac-audio
```

### Bridge
```bash
# Start the bridge (connects to relay as provider)
python bridge_client.py --relay wss://mellow-backend.onrender.com

# With custom LLM endpoints
JAC_LLM_ENDPOINTS="http://192.168.1.50:8787" python bridge_client.py --relay wss://mellow-backend.onrender.com
```

### Tool servers (auto-started by extension, but can run manually)
```bash
# CAD tool server (needs build123d: pip install build123d)
python server/cad_tools.py 5050

# PCB schematic server
python server/pcb_tools.py 5051
```

## Deployment

### Relay (Render)
The relay runs on Render, deployed from `Clifford-Swartz/mellow` GitHub repo. The file is `mellow.py` (not `relay/relay.py`). Push changes via GitHub API:

```bash
# Push relay updates (no git clone needed)
CONTENT=$(base64 < relay/relay.py)
SHA=$(~/bin/gh api repos/Clifford-Swartz/mellow/contents/mellow.py --jq '.sha')
~/bin/gh api repos/Clifford-Swartz/mellow/contents/mellow.py \
  -X PUT \
  --field message="description of change" \
  --field content="$CONTENT" \
  --field sha="$SHA"
```

Render auto-deploys on push. Takes 1-5 minutes. The relay Procfile runs `python mellow.py` directly (not gunicorn).

### Extension (VSIX)
The extension is distributed as a `.vsix` file. Currently installed manually. Not on VS Code Marketplace.

## How Things Work

### Chat Flow (Cloud Models)
1. User types in webview → `webviewProvider.ts` receives `query` message
2. If CAD panel open, injects geometry/schematic context into prompt
3. Sends to relay via `wsClient.send()`
4. Relay forwards to bridge provider
5. Bridge routes to Claude CLI / Codex / Gemini based on model
6. Response streams back: relay → extension → webview
7. Extension scans response for `\`\`\`python` blocks with `RESULT` → auto-executes on CAD tool server
8. Extension scans for `[sch add ...]` commands → auto-executes on PCB tool server

### Chat Flow (Local Models)
1. User types → `webviewProvider.ts` detects `isLocalModel`
2. `queryLocalModel()` sends HTTP POST directly to `localhost:8787`
3. Streaming response parsed for `<think>` tags (thinking bubble), content, and tool calls
4. No relay involved — fully local
5. Conversation history maintained (last 10 turns)

### CAD Pipeline
1. User says "make a box with a hole" in main JAC chat
2. Extension detects CAD keywords → auto-opens CAD panel
3. Injects build123d context + geometry state into prompt
4. Model generates `\`\`\`python` block with `RESULT = ...`
5. Extension extracts code → POST to `localhost:5050/` (cad_tools.py)
6. build123d executes → tessellated mesh data returned
7. Three.js renders the mesh in the CAD panel

### PCB Pipeline
1. User says "design a 555 LED blinker" with Schematic tab active
2. Extension injects schematic context + component library
3. Model generates `[sch add 555 200 200]` and `[sch wire R1 2 U1 TRIG]` commands
4. Extension parses brackets → POST to `localhost:5051/` (pcb_tools.py)
5. Components placed, A* wire routing, SVG updated

### Music Visualization
1. `jac-audio capture-audio 44100` captures system audio via ScreenCaptureKit (macOS)
2. Raw f32le PCM piped to stdout → Node.js reads it
3. FFT (2048-point Hann window) → 64 frequency bands
4. Hybrid normalization (70% global + 30% per-band)
5. Temporal smoothing (fast attack, slow release)
6. 8 visualization modes rendered on canvas at 30fps

### Model Discovery
Bridge auto-detects available models:
- Claude CLI → sonnet, opus, haiku
- Codex CLI → gpt-4o, o3, o4 (if authenticated)
- Gemini CLI → gemini models (if authenticated)
- Local llama-server on port 8787 → `llm:model-name`
- Remote endpoints via `JAC_LLM_ENDPOINTS` env var

All models appear in JAC's cloud tab. Model watcher re-checks every 30 seconds.

## Cross-Platform Notes
- Audio: ScreenCaptureKit (macOS), DirectShow (Windows), PulseAudio (Linux)
- Music control: AppleScript (macOS), WinRT (Windows), DBus (Linux)
- Process management: `pkill`/`lsof` guarded with `process.platform` checks
- Paths: `os.homedir()` instead of hardcoded, platform-aware llama-server search
- CAD/PCB tool servers: pure Python, cross-platform
- Native binary: macOS only, ffmpeg fallback on other platforms

## Extension Settings
- `claudeUltra.serverUrl` — Relay WebSocket URL (default: `wss://mellow-backend.onrender.com`)
- `claudeUltra.authToken` — Auth token for relay

## Commands
- `JAC: Open` — Open main chat panel
- `JAC: New Conversation` — Clear chat history
- `JAC: CAD` — Open 3D/schematic panel
- `JAC: Music` — Open music panel
- `JAC: Browser` — Open browser panel
- `JAC: Disconnect` — Disconnect from relay

## Known Issues
- Screen Recording permission must be granted to `jac-audio` binary after each VSIX update
- Local model thinking tokens (Qwen3) sometimes leak into main response
- Schematic wire routing can overlap on complex circuits
- Music fractal mode can occasionally show solid colors during parameter transitions

## Cross-account coordination (Mac: clawf ↔ claudiusmaximus)

The bridge daemon and the JAC VSCode extension run as `claudiusmaximus` (so
Messages.app stays signed in for AI-driven iMessage). The Claude Code sandbox
blocks Claude in `clawf` from reading that account's home folder, so direct
introspection (e.g., "what's in their VSCode settings.json?") is denied.

To exchange info without the user shuttling output by hand, both Claudes share
a mailbox in `/tmp` (mode 1777, both accounts can rw):

- `/tmp/jac-cross-REQUEST.md` — the active request
- `/tmp/jac-cross-RESPONSE.md` — the latest response

### When you (clawf Claude) need something from claudiusmaximus:
1. Write `/tmp/jac-cross-REQUEST.md`. Include at the top: an ISO timestamp,
   exact commands to run, and what to put in the response.
2. Tell the user one short sentence: *"Ping your other Claude — request waiting
   in `/tmp/jac-cross-REQUEST.md`."*
3. Wait. Use ScheduleWakeup (~60s) and re-check; or just ask the user when ready.
4. Read `/tmp/jac-cross-RESPONSE.md`. Match by the timestamp you wrote.

### When you (claudiusmaximus Claude) are told there's a request:
1. Read `/tmp/jac-cross-REQUEST.md`.
2. Run *exactly* the commands listed. Don't volunteer beyond what was asked.
3. Write the result to `/tmp/jac-cross-RESPONSE.md`. Echo the request's timestamp
   at the top so the requester can correlate. Keep output verbatim under fenced
   code blocks; don't paraphrase.
4. Leave REQUEST.md alone — the requester cleans up.

### Setup on a fresh claudiusmaximus session
The user should give that account's Claude the same instruction by either
(a) cloning `Clifford-Swartz/jac` into a working dir so this CLAUDE.md
auto-loads, or (b) saving a memory pointing at this protocol.
