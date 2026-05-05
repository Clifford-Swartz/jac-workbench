/**
 * CAD Panel — embeds the Sesame-CAD Flask app (Three.js 3D viewer + schematic editor)
 * in a VSCode editor tab. Starts the Flask server as a child process if not already running.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

export class CadPanel {
    public static currentPanel: CadPanel | undefined;
    private static readonly viewType = 'jacCad';

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private static serverProcess: cp.ChildProcess | null = null;
    private static serverPort = 5050;
    private disposed = false;
    public activeTab: '3d' | 'sch' = '3d';

    public static createOrShow(extensionUri: vscode.Uri): void {
        if (CadPanel.currentPanel) {
            CadPanel.currentPanel.panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            CadPanel.viewType,
            'CAD',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
            },
        );
        CadPanel.currentPanel = new CadPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.panel.onDidDispose(() => {
            this.disposed = true;
            CadPanel.currentPanel = undefined;
        });

        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready') {
                await this.startServer();
            } else if (msg.type === 'cad_query') {
                // Route through JAC's active model with CAD context
                await this.handleCadQuery(msg.prompt);
            } else if (msg.type === 'cad_tool') {
                // Direct tool execution (buttons like + Box)
                const result = await CadPanel.callTool(msg.tool, msg.args || {});
                this.panel.webview.postMessage({ type: 'tool_result', result });
            } else if (msg.type === 'save_stl') {
                await this.saveStl(msg.target || 0);
            } else if (msg.type === 'load_glb_file') {
                // User wants to load a GLB file from disk
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    filters: { '3D Models': ['glb', 'gltf', 'obj'] },
                });
                if (uris && uris[0]) {
                    const data = fs.readFileSync(uris[0].fsPath);
                    const b64 = data.toString('base64');
                    this.panel.webview.postMessage({
                        type: 'load_glb_base64',
                        data: b64,
                        name: path.basename(uris[0].fsPath),
                    });
                }
            } else if (msg.type === 'pcb_tool') {
                const result = await CadPanel.callPcbTool(msg.tool, msg.args || {});
                this.panel.webview.postMessage({ type: 'sch_result', result });
            } else if (msg.type === 'tab_change') {
                this.activeTab = msg.tab;
            }
        });

        this.panel.webview.html = this.getLoadingHtml();
        this.startServer();
    }

    /** Check if the CAD tool server is running. */
    private async isServerReady(): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${CadPanel.serverPort}/health`, (res) => {
                let body = '';
                res.on('data', (c: Buffer) => { body += c; });
                res.on('end', () => resolve(body.includes('"ok"')));
            });
            req.on('error', () => resolve(false));
            req.setTimeout(2000, () => { req.destroy(); resolve(false); });
        });
    }

    /** Start the CAD tool server if not running. */
    private async startServer(): Promise<void> {
        if (await this.isServerReady()) {
            this.showCadUI();
            return;
        }

        const serverScript = path.join(
            os.homedir(),
            'Desktop', 'Claude Code Ultra', 'server', 'cad_tools.py',
        );

        this.panel.webview.html = this.getLoadingHtml('Starting CAD tool server...');

        // Use the venv Python which has build123d installed
        const venvBin = process.platform === 'win32' ? 'Scripts' : 'bin';
        const pythonExe = process.platform === 'win32' ? 'python.exe' : 'python';
        const venvPython = path.join(
            os.homedir(),
            'Desktop', 'Claude Code Ultra', '.venv', venvBin, pythonExe,
        );
        const pythonBin = fs.existsSync(venvPython) ? venvPython : 'python';

        CadPanel.serverProcess = cp.spawn(pythonBin, [serverScript, String(CadPanel.serverPort)], {
            stdio: 'ignore',
        });
        CadPanel.serverProcess.on('exit', () => { CadPanel.serverProcess = null; });

        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await this.isServerReady()) {
                this.showCadUI();
                return;
            }
        }
        this.panel.webview.html = this.getLoadingHtml('Failed to start CAD server. Check that build123d is installed: pip install build123d');
    }

    /** Load a GLB mesh into the 3D viewer from a buffer or URL. */
    public loadGLBFromBuffer(data: Buffer, name: string): void {
        this.panel.webview.postMessage({
            type: 'load_glb_base64',
            data: data.toString('base64'),
            name,
        });
    }

    public loadGLBFromURL(url: string, name: string): void {
        this.panel.webview.postMessage({
            type: 'load_glb_url',
            url,
            name,
        });
    }

    /** Save STL to the current workspace directory. */
    private async saveStl(target: number): Promise<void> {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
            vscode.window.showErrorMessage('No workspace folder open — open a folder first.');
            return;
        }
        const defaultName = `part_${target}.stl`;
        const name = await vscode.window.showInputBox({
            prompt: 'Save STL as',
            value: defaultName,
        });
        if (!name) return;

        const filepath = path.join(cwd, name);
        try {
            const result = await CadPanel.callTool('export_stl', { target, filename: filepath });
            if (result.ok) {
                vscode.window.showInformationMessage(`Saved ${name} (${result.size_kb} KB)`);
            } else {
                vscode.window.showErrorMessage(`Save failed: ${result.error}`);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Save failed: ${err.message}`);
        }
    }

    private static pcbServerProcess: cp.ChildProcess | null = null;
    private static pcbPort = 5051;

    /** Ensure the PCB tool server is running. */
    private async ensurePcbServer(): Promise<void> {
        // Quick health check
        const alive = await new Promise<boolean>((resolve) => {
            const req = http.get(`http://127.0.0.1:${CadPanel.pcbPort}/health`, (res) => {
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(1000, () => { req.destroy(); resolve(false); });
        });
        if (alive) return;

        const serverScript = path.join(
            os.homedir(),
            'Desktop', 'Claude Code Ultra', 'server', 'pcb_tools.py',
        );
        const venvBin2 = process.platform === 'win32' ? 'Scripts' : 'bin';
        const pythonExe2 = process.platform === 'win32' ? 'python.exe' : 'python';
        const venvPython = path.join(
            os.homedir(),
            'Desktop', 'Claude Code Ultra', '.venv', venvBin2, pythonExe2,
        );
        const pythonBin = fs.existsSync(venvPython) ? venvPython : 'python';
        CadPanel.pcbServerProcess = cp.spawn(pythonBin, [serverScript, String(CadPanel.pcbPort)], { stdio: 'ignore' });
        CadPanel.pcbServerProcess.on('exit', () => { CadPanel.pcbServerProcess = null; });
        // Wait briefly
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 500));
            const ok = await new Promise<boolean>((resolve) => {
                const req = http.get(`http://127.0.0.1:${CadPanel.pcbPort}/health`, () => resolve(true));
                req.on('error', () => resolve(false));
                req.setTimeout(500, () => { req.destroy(); resolve(false); });
            });
            if (ok) return;
        }
    }

    /** Call a PCB tool and return the result. */
    public static async callPcbTool(tool: string, args: Record<string, unknown> = {}): Promise<any> {
        // Ensure server is running
        if (CadPanel.currentPanel) {
            await CadPanel.currentPanel.ensurePcbServer();
        }
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ tool, args });
            const req = http.request(`http://127.0.0.1:${CadPanel.pcbPort}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
                let data = '';
                res.on('data', (c: Buffer) => { data += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: data }); }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /** Call a CAD tool and return the result. */
    public static async callTool(tool: string, args: Record<string, unknown> = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ tool, args });
            const req = http.request(`http://127.0.0.1:${CadPanel.serverPort}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
                let data = '';
                res.on('data', (c: Buffer) => { data += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: data }); }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /** Handle a CAD query — route through JAC's active model, execute code from response. */
    private async handleCadQuery(prompt: string): Promise<void> {
        // 1. Get current geometry context
        let geoContext = 'No geometry loaded.';
        try {
            const ctx = await CadPanel.callTool('geometry_context');
            if (ctx.ok) geoContext = ctx.context;
        } catch { /* no server yet */ }

        // 2. Build the full prompt with CAD system instructions
        const cadPrompt = `You are a CAD assistant. Generate build123d Python code.

## Current Geometry
${geoContext}

## Rules
- Code MUST assign result to RESULT variable
- Start with: from build123d import *
- INPUT_SHAPES = list of current solids
- Wrap code in \`\`\`python block
- Be concise

## Quick Ref
Box(l,w,h) Cylinder(r,h) Sphere(r)
Fuse: a+b  Cut: a-b  Move: s.move(Location((x,y,z)))
Rotate: s.rotate(Axis.Z, deg)  Scale: scale(s, f)

## Request: ${prompt}`;

        // 3. Route through the main JAC panel's active model
        this.panel.webview.postMessage({ type: 'status', text: 'Thinking...' });

        const { ClaudeUltraPanel } = await import('./webviewProvider');
        const mainPanel = ClaudeUltraPanel.currentPanel;
        if (!mainPanel) {
            this.panel.webview.postMessage({ type: 'status', text: 'Open JAC panel first' });
            return;
        }

        // Tell the main panel this is a CAD query — it will route to the model
        // and send the full response back to us
        mainPanel.sendCadQuery(cadPrompt, async (responseText: string) => {
            // 4. Extract and execute code from the response
            await this.executeCodeFromResponse(responseText);
        });
    }

    /** Push updated geometry parts to the CAD viewer. */
    public updateGeometry(result: any): void {
        if (this.disposed) return;
        this.panel.webview.postMessage({ type: 'tool_result', result });
        if (result.ok) {
            this.panel.webview.postMessage({ type: 'status', text: `Done — ${result.n_parts} parts` });
        } else {
            this.panel.webview.postMessage({ type: 'status', text: `Error: ${result.error}` });
        }
    }

    /** Extract and execute build123d code from model response text. */
    public async executeCodeFromResponse(responseText: string): Promise<void> {
        // Extract python code blocks
        const codeMatch = responseText.match(/```python\n([\s\S]*?)```/);
        if (!codeMatch) {
            this.panel.webview.postMessage({
                type: 'status',
                text: 'No code block found in response',
            });
            return;
        }

        const code = codeMatch[1].trim();
        this.panel.webview.postMessage({ type: 'status', text: 'Executing code...' });

        try {
            const result = await CadPanel.callTool('cad_execute', { code });
            this.panel.webview.postMessage({ type: 'tool_result', result });
            if (result.ok) {
                this.panel.webview.postMessage({ type: 'status', text: `Done — ${result.n_parts} parts` });
            } else {
                this.panel.webview.postMessage({ type: 'status', text: `Error: ${result.error}` });
            }
        } catch (err: any) {
            this.panel.webview.postMessage({ type: 'status', text: `Error: ${err.message}` });
        }
    }

    /** Show the native Three.js CAD viewer. */
    private showCadUI(): void {
        if (this.disposed) return;
        const nonce = getNonce();
        const threeUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'three.min.js'),
        );
        const orbitUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'OrbitControls.js'),
        );
        const transformUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'TransformControls.js'),
        );
        const gltfUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'GLTFLoader.js'),
        );
        this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   script-src 'nonce-${nonce}' 'unsafe-eval';
                   style-src 'unsafe-inline';
                   img-src data:;">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, sans-serif; height: 100vh; display: flex; flex-direction: column; }
        #top-bar { padding: 4px 8px; background: #16213e; display: flex; gap: 6px; align-items: center; border-bottom: 1px solid #333; font-size: 11px; }
        #top-bar button { background: #0f3460; color: #e0e0e0; border: 1px solid #444; border-radius: 3px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
        #top-bar button:hover { background: #1a5276; }
        .tab-btn { font-weight: 600; }
        .tab-btn.active { background: #4daafc; color: #000; border-color: #4daafc; }
        #top-bar .status { margin-left: auto; opacity: 0.5; }
        #main { flex: 1; display: flex; overflow: hidden; }
        #tool-sidebar { width: 42px; background: #0d1b2e; border-right: 1px solid #333; display: flex; flex-direction: column; padding: 4px; gap: 2px; overflow: visible; z-index: 10; }
        .tool-btn { width: 34px; height: 34px; background: #16213e; border: 1px solid #333; border-radius: 4px; color: #ccc; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px; position: relative; }
        .tool-btn:hover { background: #1a3a5c; border-color: #4daafc; }
        .tool-btn.active { background: #4daafc; color: #000; border-color: #4daafc; }
        .tool-btn::after { content: attr(data-tip); position: absolute; left: 42px; top: 50%; transform: translateY(-50%); background: #222; color: #ddd; padding: 3px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.15s; z-index: 100; border: 1px solid #444; }
        .tool-btn:hover::after { opacity: 1; }
        .tool-sep { height: 1px; background: #333; margin: 4px 2px; }
        #viewer-wrap { flex: 1; position: relative; }
        #viewer { width: 100%; height: 100%; }
        #parts-panel { position: absolute; right: 6px; top: 6px; width: 200px; background: rgba(22,33,62,0.92); border: 1px solid #333; border-radius: 6px; padding: 6px; font-size: 11px; max-height: 45vh; overflow-y: auto; backdrop-filter: blur(8px); }
        #parts-panel h3 { font-size: 11px; margin-bottom: 4px; color: #4daafc; font-weight: 600; }
        .part-item { padding: 3px 5px; border-radius: 3px; cursor: pointer; margin-bottom: 1px; }
        .part-item:hover { background: #1a3a5c; }
        .part-dims { opacity: 0.5; font-size: 9px; }
        /* input bar removed — queries come from the main JAC chat */
    </style>
</head>
<body>
    <div id="top-bar">
        <button class="tab-btn active" id="tab-3d">3D</button>
        <button class="tab-btn" id="tab-sch">Schematic</button>
        <span style="border-left:1px solid #444; height:16px; margin:0 6px"></span>
        <button id="btn-step" title="Open STEP file">Open</button>
        <button id="btn-stl" title="Save to workspace">Save</button>
        <button id="btn-reset" title="Clear all">Reset</button>
        <span class="status" id="status">Ready</span>
    </div>
    <div id="main">
        <div id="tool-sidebar">
            <button class="tool-btn active" id="btn-select" data-tip="Select (Esc)">&#x2B9E;</button>
            <button class="tool-btn" id="btn-move" data-tip="Move (G)">&#x2725;</button>
            <button class="tool-btn" id="btn-rotate" data-tip="Rotate (R)">&#x21BB;</button>
            <button class="tool-btn" id="btn-scale" data-tip="Scale (S)">&#x2922;</button>
            <div class="tool-sep"></div>
            <button class="tool-btn" id="btn-box" data-tip="Box">&#x25A1;</button>
            <button class="tool-btn" id="btn-cyl" data-tip="Cylinder">&#x25CB;</button>
            <button class="tool-btn" id="btn-sphere" data-tip="Sphere">&#x25CF;</button>
            <div class="tool-sep"></div>
            <button class="tool-btn" id="btn-union" data-tip="Union">&#x222A;</button>
            <button class="tool-btn" id="btn-cut" data-tip="Cut">&#x2296;</button>
            <div class="tool-sep"></div>
            <button class="tool-btn" id="btn-dup" data-tip="Duplicate (Shift+D)">&#x2750;</button>
            <button class="tool-btn" id="btn-mirror" data-tip="Mirror">&#x2194;</button>
            <button class="tool-btn" id="btn-del" data-tip="Delete (X)">&#x2715;</button>
        </div>
        <div id="viewer-wrap">
            <div id="viewer"></div>
            <div id="parts-panel"><h3>Parts</h3><div id="parts-list">No geometry</div></div>
        </div>
        <div id="schematic-wrap" style="display:none; flex:1; position:relative;">
            <svg id="sch-canvas" width="100%" height="100%" style="background:#1a1a2e;">
                <defs>
                    <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#222244" stroke-width="0.5"/>
                    </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#grid)"/>
                <g id="sch-components"></g>
                <g id="sch-wires"></g>
            </svg>
            <div id="sch-palette" style="position:absolute;right:6px;top:6px;width:160px;background:rgba(22,33,62,0.92);border:1px solid #333;border-radius:6px;padding:6px;font-size:10px;max-height:60vh;overflow-y:auto;backdrop-filter:blur(8px);">
                <h3 style="font-size:11px;margin-bottom:4px;color:#4daafc;">Components</h3>
                <div id="sch-lib-list"></div>
            </div>
        </div>
    </div>
    <!-- Input removed: CAD queries come from the main JAC chat -->

    <script src="${threeUri}" nonce="${nonce}"></script>
    <script src="${orbitUri}" nonce="${nonce}"></script>
    <script src="${transformUri}" nonce="${nonce}"></script>
    <script src="${gltfUri}" nonce="${nonce}"></script>
    <script nonce="${nonce}">

        const API = 'http://127.0.0.1:${CadPanel.serverPort}';
        let scene, camera, renderer, orbitControls, transformControls;
        let meshes = [];
        let selectedIndex = -1;
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        function init() {
            scene = new THREE.Scene();
            scene.background = new THREE.Color(0x1a1a2e);

            camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10000);
            camera.position.set(100, 80, 100);

            const viewerEl = document.getElementById('viewer');
            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(viewerEl.clientWidth, viewerEl.clientHeight);
            viewerEl.appendChild(renderer.domElement);

            orbitControls = new THREE.OrbitControls(camera, renderer.domElement);
            orbitControls.enableDamping = true;

            // Transform gizmo
            transformControls = new THREE.TransformControls(camera, renderer.domElement);
            transformControls.addEventListener('dragging-changed', (e) => {
                orbitControls.enabled = !e.value;
            });
            transformControls.addEventListener('objectChange', () => {
                // Will sync position back to server on mouse up
            });
            transformControls.addEventListener('mouseUp', () => {
                if (selectedIndex >= 0 && meshes[selectedIndex]) {
                    const m = meshes[selectedIndex];
                    const mode = transformControls.getMode();
                    if (mode === 'translate') {
                        vscode.postMessage({ type: 'cad_tool', tool: 'transform_part', args: {
                            target: selectedIndex, transform: 'translate',
                            vector: [m.position.x, m.position.z, m.position.y]
                        }});
                    } else if (mode === 'rotate') {
                        // Send euler angles
                        const e = m.rotation;
                        vscode.postMessage({ type: 'cad_tool', tool: 'transform_part', args: {
                            target: selectedIndex, transform: 'rotate',
                            axis: 'Z', angle: THREE.MathUtils.radToDeg(e.z)
                        }});
                    } else if (mode === 'scale') {
                        vscode.postMessage({ type: 'cad_tool', tool: 'transform_part', args: {
                            target: selectedIndex, transform: 'scale',
                            factor: m.scale.x
                        }});
                    }
                }
            });
            scene.add(transformControls);

            // Lights
            scene.add(new THREE.AmbientLight(0x606060, 2));
            const dl = new THREE.DirectionalLight(0xffffff, 1.5);
            dl.position.set(50, 100, 50);
            scene.add(dl);
            const dl2 = new THREE.DirectionalLight(0xffffff, 0.5);
            dl2.position.set(-50, -20, -50);
            scene.add(dl2);

            // Grid
            scene.add(new THREE.GridHelper(200, 20, 0x333355, 0x222244));

            // Click to select
            renderer.domElement.addEventListener('click', onViewerClick);

            const onResize = () => {
                const w = viewerEl.clientWidth, h = viewerEl.clientHeight;
                camera.aspect = w / h;
                camera.updateProjectionMatrix();
                renderer.setSize(w, h);
            };
            window.addEventListener('resize', onResize);
            new ResizeObserver(onResize).observe(viewerEl);

            // Keyboard shortcuts
            window.addEventListener('keydown', (e) => {
                if (e.target !== document.body) return;
                if (e.key === 'g' || e.key === 'G') setTransformMode('translate');
                else if (e.key === 'r' && !e.metaKey) setTransformMode('rotate');
                else if (e.key === 's' && !e.metaKey) setTransformMode('scale');
                else if (e.key === 'x' || e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
                else if (e.key === 'd' && e.shiftKey) duplicateSelected();
                else if (e.key === 'Escape') deselectAll();
            });

            animate();
        }

        function animate() {
            requestAnimationFrame(animate);
            orbitControls.update();
            renderer.render(scene, camera);
        }

        function onViewerClick(event) {
            const rect = renderer.domElement.getBoundingClientRect();
            mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            const hits = raycaster.intersectObjects(meshes);
            if (hits.length > 0) {
                const idx = meshes.indexOf(hits[0].object);
                selectPart(idx);
            } else {
                deselectAll();
            }
        }

        function selectPart(idx) {
            deselectAll();
            if (idx < 0 || idx >= meshes.length) return;
            selectedIndex = idx;
            meshes[idx].material.emissive = new THREE.Color(0x444444);
            transformControls.attach(meshes[idx]);
            document.getElementById('status').textContent = 'Selected part ' + idx;
            // Highlight in parts list
            document.querySelectorAll('.part-item').forEach((el, i) => {
                el.style.background = i === idx ? '#1a3a5c' : '';
            });
        }

        function deselectAll() {
            if (selectedIndex >= 0 && meshes[selectedIndex]) {
                meshes[selectedIndex].material.emissive = new THREE.Color(0x000000);
            }
            selectedIndex = -1;
            transformControls.detach();
            document.getElementById('status').textContent = 'Ready — ' + meshes.length + ' parts';
            document.querySelectorAll('.part-item').forEach(el => { el.style.background = ''; });
        }

        let currentTool = 'select';
        function setActiveTool(tool) {
            currentTool = tool;
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            const btn = document.getElementById('btn-' + tool);
            if (btn) btn.classList.add('active');
        }
        function setTransformMode(mode) {
            transformControls.setMode(mode);
            const toolMap = { translate: 'move', rotate: 'rotate', scale: 'scale' };
            setActiveTool(toolMap[mode] || mode);
        }

        function deleteSelected() {
            if (selectedIndex < 0) return;
            vscode.postMessage({ type: 'cad_tool', tool: 'delete_parts', args: { targets: [selectedIndex] } });
            deselectAll();
        }

        function duplicateSelected() {
            if (selectedIndex < 0) return;
            vscode.postMessage({ type: 'cad_tool', tool: 'duplicate_part', args: { target: selectedIndex, offset: [20, 0, 0] } });
        }

        const COLORS = [0x4daafc, 0x4ec990, 0xf0a030, 0xe06060, 0xa070d0, 0x60c0c0, 0xd0d060, 0xf080b0];

        function updateViewer(parts) {
            // Remove old meshes
            meshes.forEach(m => { scene.remove(m); m.geometry.dispose(); });
            meshes = [];

            parts.forEach((p, i) => {
                let geo;
                if (p.mesh && p.mesh.positions && p.mesh.indices) {
                    // Real tessellated geometry from build123d
                    geo = new THREE.BufferGeometry();
                    const pos = new Float32Array(p.mesh.positions);
                    // Swap Y/Z for Three.js (Y=up)
                    for (let j = 0; j < pos.length; j += 3) {
                        const tmp = pos[j + 1];
                        pos[j + 1] = pos[j + 2];
                        pos[j + 2] = tmp;
                    }
                    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                    geo.setIndex(p.mesh.indices);
                    geo.computeVertexNormals();
                } else {
                    // Fallback: bounding box cube
                    const [w, h, d] = p.dims || [10, 10, 10];
                    geo = new THREE.BoxGeometry(w, d, h);
                }
                const mat = new THREE.MeshPhongMaterial({
                    color: COLORS[i % COLORS.length],
                    transparent: true, opacity: 0.85,
                    side: THREE.DoubleSide,
                });
                const mesh = new THREE.Mesh(geo, mat);
                if (!p.mesh) {
                    mesh.position.set(p.center[0], p.center[2], p.center[1]);
                }
                scene.add(mesh);
                meshes.push(mesh);
            });

            document.getElementById('status').textContent = 'Ready — ' + parts.length + ' parts';
            updatePartsList(parts);
        }

        function updatePartsList(parts) {
            const el = document.getElementById('parts-list');
            if (!parts.length) { el.innerHTML = 'No geometry'; return; }
            el.innerHTML = parts.map((p, i) =>
                '<div class="part-item">' +
                '<span style="color:' + '#' + COLORS[i % COLORS.length].toString(16).padStart(6, '0') + '">\\u25A0</span> ' +
                'Part ' + i +
                '<div class="part-dims">' + p.dims.join(' \\u00d7 ') + ' mm — ' + p.volume + ' mm\\u00b3</div></div>'
            ).join('');
        }

        // ── GLB/GLTF Loader ─────────────────────────────────────────
        const gltfLoader = new THREE.GLTFLoader();
        let glbMeshes = [];  // track GLB meshes separately

        function loadGLB(arrayBuffer, name) {
            // Remove previous GLB meshes
            glbMeshes.forEach(m => { scene.remove(m); if (m.geometry) m.geometry.dispose(); });
            glbMeshes = [];

            gltfLoader.parse(arrayBuffer, '', (gltf) => {
                const model = gltf.scene;

                // Center and scale the model
                const box = new THREE.Box3().setFromObject(model);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);
                const scale = 100 / maxDim;  // normalize to ~100mm

                model.position.sub(center);
                model.scale.setScalar(scale);

                // Ensure all materials are visible
                model.traverse((child) => {
                    if (child.isMesh) {
                        child.material.side = THREE.DoubleSide;
                        if (!child.material.color) {
                            child.material.color = new THREE.Color(0x4daafc);
                        }
                        glbMeshes.push(child);
                    }
                });

                scene.add(model);

                // Update camera to frame the model
                camera.position.set(size.x * scale, size.y * scale * 0.8, size.z * scale * 1.2);
                orbitControls.target.set(0, 0, 0);
                orbitControls.update();

                document.getElementById('status').textContent =
                    (name || 'Model') + ' — ' + glbMeshes.length + ' meshes, ' +
                    Math.round(maxDim) + 'mm';

                // Update parts list
                updatePartsList(glbMeshes.map((m, i) => ({
                    dims: [
                        Math.round(size.x * scale),
                        Math.round(size.y * scale),
                        Math.round(size.z * scale)
                    ],
                    volume: 0,
                })));
            }, (error) => {
                document.getElementById('status').textContent = 'GLB load error: ' + error.message;
            });
        }

        // Load GLB from base64 or URL
        function loadGLBFromBase64(b64, name) {
            const binary = atob(b64);
            const buffer = new ArrayBuffer(binary.length);
            const view = new Uint8Array(buffer);
            for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
            loadGLB(buffer, name);
        }

        function loadGLBFromURL(url, name) {
            fetch(url)
                .then(r => r.arrayBuffer())
                .then(buf => loadGLB(buf, name || url.split('/').pop()))
                .catch(e => {
                    document.getElementById('status').textContent = 'GLB fetch error: ' + e.message;
                });
        }

        /* Tool calls go through the extension host, not direct fetch */

        let vscode;
        try { vscode = acquireVsCodeApi(); } catch(e) {
            document.getElementById('status').textContent = 'ERROR: ' + e.message;
        }

        /* sendCadPrompt removed — queries come from the main JAC chat */

        // Handle messages from extension
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'tool_result') {
                const r = msg.result;
                if (r.parts) updateViewer(r.parts);
                if (r.measurements) updateViewer(r.measurements);
                document.getElementById('status').textContent = r.ok
                    ? 'Done — ' + (r.n_parts || 0) + ' parts'
                    : 'Error: ' + (r.error || 'unknown').substring(0, 100);
            } else if (msg.type === 'status') {
                document.getElementById('status').textContent = msg.text;
            } else if (msg.type === 'load_glb_base64') {
                loadGLBFromBase64(msg.data, msg.name);
            } else if (msg.type === 'load_glb_url') {
                loadGLBFromURL(msg.url, msg.name);
            }
        });

        // Toolbar buttons via addEventListener (inline onclick blocked by CSP)
        document.getElementById('btn-box').addEventListener('click', () => {
            document.getElementById('status').textContent = 'Creating box...';
            vscode.postMessage({ type: 'cad_tool', tool: 'cad_execute', args: { code: 'RESULT = Box(50, 30, 20)' } });
        });
        document.getElementById('btn-cyl').addEventListener('click', () => {
            document.getElementById('status').textContent = 'Creating cylinder...';
            vscode.postMessage({ type: 'cad_tool', tool: 'cad_execute', args: { code: 'RESULT = Cylinder(15, 40)' } });
        });
        document.getElementById('btn-reset').addEventListener('click', () => {
            vscode.postMessage({ type: 'cad_tool', tool: 'reset' });
            updateViewer([]);
            document.getElementById('status').textContent = 'Reset';
        });
        document.getElementById('btn-sphere').addEventListener('click', () => {
            document.getElementById('status').textContent = 'Creating sphere...';
            vscode.postMessage({ type: 'cad_tool', tool: 'cad_execute', args: { code: 'RESULT = Sphere(25)' } });
        });
        document.getElementById('btn-stl').addEventListener('click', () => {
            const t = selectedIndex >= 0 ? selectedIndex : 0;
            vscode.postMessage({ type: 'save_stl', target: t });
        });
        document.getElementById('btn-step').addEventListener('click', () => {
            vscode.postMessage({ type: 'load_glb_file' });
        });
        // Tool sidebar buttons
        document.getElementById('btn-select').addEventListener('click', () => {
            setActiveTool('select');
            transformControls.detach();
        });
        document.getElementById('btn-move').addEventListener('click', () => setTransformMode('translate'));
        document.getElementById('btn-rotate').addEventListener('click', () => setTransformMode('rotate'));
        document.getElementById('btn-scale').addEventListener('click', () => setTransformMode('scale'));
        // Boolean + edit buttons
        document.getElementById('btn-del').addEventListener('click', deleteSelected);
        document.getElementById('btn-dup').addEventListener('click', duplicateSelected);
        document.getElementById('btn-mirror').addEventListener('click', () => {
            if (selectedIndex < 0) return;
            vscode.postMessage({ type: 'cad_tool', tool: 'mirror_part', args: { target: selectedIndex } });
        });
        document.getElementById('btn-union').addEventListener('click', () => {
            document.getElementById('status').textContent = 'Click two parts to union (select first, then Shift+click second)';
        });
        document.getElementById('btn-cut').addEventListener('click', () => {
            document.getElementById('status').textContent = 'Click two parts to cut (select first, then Shift+click second)';
        });
        /* cad-send / cad-input listeners removed — queries come from the main JAC chat */

        // ── SVG Pan/Zoom for Schematic ────────────────────────────────
        const schSvgEl = document.getElementById('sch-canvas');
        let schPanX = 0, schPanY = 0, schZoom = 1;
        let schIsPanning = false, schStartX = 0, schStartY = 0;

        function updateSvgTransform() {
            const comps = document.getElementById('sch-components');
            const wires = document.getElementById('sch-wires');
            const t = 'translate(' + schPanX + ',' + schPanY + ') scale(' + schZoom + ')';
            if (comps) comps.setAttribute('transform', t);
            if (wires) wires.setAttribute('transform', t);
        }

        schSvgEl.addEventListener('mousedown', (e) => {
            if ((e.button === 0 || e.button === 1) && !schDragging) {
                schIsPanning = true;
                schStartX = e.clientX - schPanX;
                schStartY = e.clientY - schPanY;
                schSvgEl.style.cursor = 'grabbing';
            }
        });
        window.addEventListener('mousemove', (e) => {
            if (schDragging && schSelectedIdx >= 0) {
                // Dragging a component
                const rect = schSvgEl.getBoundingClientRect();
                const mx = (e.clientX - rect.left - schPanX) / schZoom;
                const my = (e.clientY - rect.top - schPanY) / schZoom;
                schDragX = mx;
                schDragY = my;
                // Update SVG group position live
                const g = schCompsEl.children[schSelectedIdx];
                if (g) {
                    const comp = schCompData[schSelectedIdx];
                    const rot = (comp && comp.rotation) || 0;
                    g.setAttribute('transform', 'translate(' + mx + ',' + my + ') rotate(' + rot + ')');
                }
                return;
            }
            if (!schIsPanning) return;
            schPanX = e.clientX - schStartX;
            schPanY = e.clientY - schStartY;
            updateSvgTransform();
        });
        window.addEventListener('mouseup', () => {
            if (schDragging && schSelectedIdx >= 0) {
                const comp = schCompData[schSelectedIdx];
                if (comp) {
                    vscode.postMessage({ type: 'pcb_tool', tool: 'move_component', args: { id: comp.id, x: Math.round(schDragX), y: Math.round(schDragY) } });
                    vscode.postMessage({ type: 'pcb_tool', tool: 'get_schematic' });
                }
                schDragging = false;
            }
            schIsPanning = false;
            schSvgEl.style.cursor = 'default';
        });
        schSvgEl.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = schSvgEl.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const oldZoom = schZoom;
            schZoom *= e.deltaY < 0 ? 1.1 : 0.9;
            schZoom = Math.max(0.1, Math.min(5, schZoom));
            schPanX = mx - (mx - schPanX) * (schZoom / oldZoom);
            schPanY = my - (my - schPanY) * (schZoom / oldZoom);
            updateSvgTransform();
        }, { passive: false });

        // ── Schematic Component Interaction State ─────────────────────
        let schSelectedIdx = -1;
        let schDragging = false;
        let schDragX = 0, schDragY = 0;
        let schCompData = []; // mirror of last rendered components array

        window.addEventListener('keydown', (e) => {
            if (activeTab !== 'sch') return;
            if ((e.key === 'Delete' || e.key === 'Backspace') && schSelectedIdx >= 0) {
                const comp = schCompData[schSelectedIdx];
                if (comp) {
                    vscode.postMessage({ type: 'pcb_tool', tool: 'remove_component', args: { id: comp.id } });
                    schSelectedIdx = -1;
                }
            }
        });

        // ── Tab switching ──────────────────────────────────────────────
        let activeTab = '3d';
        document.getElementById('tab-3d').addEventListener('click', () => {
            activeTab = '3d';
            document.getElementById('viewer-wrap').style.display = '';
            document.getElementById('schematic-wrap').style.display = 'none';
            document.getElementById('tool-sidebar').style.display = '';
            document.getElementById('tab-3d').classList.add('active');
            document.getElementById('tab-sch').classList.remove('active');
            vscode.postMessage({ type: 'tab_change', tab: '3d' });
        });
        document.getElementById('tab-sch').addEventListener('click', () => {
            activeTab = 'sch';
            document.getElementById('viewer-wrap').style.display = 'none';
            document.getElementById('schematic-wrap').style.display = '';
            document.getElementById('tool-sidebar').style.display = 'none';
            document.getElementById('tab-3d').classList.remove('active');
            document.getElementById('tab-sch').classList.add('active');
            vscode.postMessage({ type: 'tab_change', tab: 'sch' });
            vscode.postMessage({ type: 'pcb_tool', tool: 'get_schematic' });
            loadSchLibrary();
        });

        // ── Schematic Renderer ───────────────────────────────────────
        const SCH_COLORS = ['#4daafc','#4ec990','#f0a030','#e06060','#a070d0','#60c0c0'];
        const schCompsEl = document.getElementById('sch-components');
        const schWiresEl = document.getElementById('sch-wires');
        let schLibrary = {};

        function renderSchematic(data) {
            schCompsEl.innerHTML = '';
            schWiresEl.innerHTML = '';
            schCompData = data.components || [];
            if (schSelectedIdx >= schCompData.length) schSelectedIdx = -1;

            // Render wires
            (data.wires || []).forEach(w => {
                if (w.points.length < 2) return;
                let d = 'M ' + w.points.map(p => p[0] + ' ' + p[1]).join(' L ');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', d);
                path.setAttribute('fill', 'none');
                path.setAttribute('stroke', '#4ec990');
                path.setAttribute('stroke-width', '2');
                schWiresEl.appendChild(path);
                // Junction dots
                (w.junctions || []).forEach(j => {
                    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    dot.setAttribute('cx', j[0]);
                    dot.setAttribute('cy', j[1]);
                    dot.setAttribute('r', '4');
                    dot.setAttribute('fill', '#4ec990');
                    schWiresEl.appendChild(dot);
                });
            });

            // Render components
            (data.components || []).forEach((comp, idx) => {
                const lib = schLibrary[comp.type] || {};
                const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                g.setAttribute('transform', 'translate(' + comp.x + ',' + comp.y + ') rotate(' + (comp.rotation || 0) + ')');
                g.style.color = SCH_COLORS[idx % SCH_COLORS.length];

                // Component symbol
                if (lib.svg) {
                    const symbolG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                    symbolG.innerHTML = lib.svg;
                    g.appendChild(symbolG);
                } else {
                    // Fallback: rectangle
                    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    rect.setAttribute('x', '-20');
                    rect.setAttribute('y', '-15');
                    rect.setAttribute('width', '40');
                    rect.setAttribute('height', '30');
                    rect.setAttribute('fill', 'none');
                    rect.setAttribute('stroke', 'currentColor');
                    rect.setAttribute('stroke-width', '1.5');
                    g.appendChild(rect);
                }

                // Pin dots + stubs
                const pins = lib.pins || {};
                Object.entries(pins).forEach(([name, pin]) => {
                    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    dot.setAttribute('cx', pin.x);
                    dot.setAttribute('cy', pin.y);
                    dot.setAttribute('r', '3');
                    dot.setAttribute('fill', '#4daafc');
                    dot.setAttribute('stroke', 'none');
                    g.appendChild(dot);
                });

                // Reference label
                const ref = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                ref.setAttribute('x', '0');
                ref.setAttribute('y', '-20');
                ref.setAttribute('text-anchor', 'middle');
                ref.setAttribute('font-size', '10');
                ref.setAttribute('fill', '#aaa');
                ref.textContent = comp.ref;
                g.appendChild(ref);

                // Value label
                const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                val.setAttribute('x', '0');
                val.setAttribute('y', '25');
                val.setAttribute('text-anchor', 'middle');
                val.setAttribute('font-size', '9');
                val.setAttribute('fill', '#888');
                val.textContent = (comp.properties || {}).value || '';
                g.appendChild(val);

                // Selection highlight
                if (idx === schSelectedIdx) {
                    const hw = (lib.w || 40) / 2 + 5;
                    const hh = (lib.h || 30) / 2 + 5;
                    const sel = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    sel.setAttribute('x', String(-hw));
                    sel.setAttribute('y', String(-hh));
                    sel.setAttribute('width', String(hw * 2));
                    sel.setAttribute('height', String(hh * 2));
                    sel.setAttribute('fill', 'none');
                    sel.setAttribute('stroke', '#4daafc');
                    sel.setAttribute('stroke-width', '2');
                    sel.setAttribute('stroke-dasharray', '4,2');
                    sel.setAttribute('rx', '3');
                    g.insertBefore(sel, g.firstChild);
                }

                // Click to select, mousedown to start drag
                g.style.cursor = 'pointer';
                g.addEventListener('mousedown', ((capturedIdx) => (e) => {
                    e.stopPropagation();
                    schSelectedIdx = capturedIdx;
                    schDragging = true;
                    schIsPanning = false; // prevent pan while dragging
                    const rect = schSvgEl.getBoundingClientRect();
                    schDragX = (e.clientX - rect.left - schPanX) / schZoom;
                    schDragY = (e.clientY - rect.top - schPanY) / schZoom;
                    renderSchematic(data); // re-render to show selection highlight
                })(idx));

                schCompsEl.appendChild(g);
            });

            document.getElementById('status').textContent =
                (data.n_components || 0) + ' components, ' + (data.n_wires || 0) + ' wires';
        }

        function loadSchLibrary() {
            vscode.postMessage({ type: 'pcb_tool', tool: 'get_library' });
        }

        function renderSchLibrary(lib) {
            schLibrary = lib;
            const el = document.getElementById('sch-lib-list');
            el.innerHTML = '';
            Object.entries(lib).forEach(([key, comp]) => {
                const item = document.createElement('div');
                item.style.cssText = 'padding:3px 5px;cursor:pointer;border-radius:3px;margin-bottom:1px;';
                item.textContent = comp.name || key;
                item.addEventListener('mouseenter', () => { item.style.background = '#1a3a5c'; });
                item.addEventListener('mouseleave', () => { item.style.background = ''; });
                item.addEventListener('click', () => {
                    // Place component at center of visible area
                    vscode.postMessage({ type: 'pcb_tool', tool: 'add_component', args: { type: key, x: 300, y: 250 } });
                });
                el.appendChild(item);
            });
        }

        // Handle schematic messages
        const origHandler = window.onmessage;
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'sch_result') {
                const r = msg.result;
                if (r.components !== undefined) renderSchematic(r);
                if (r.library) renderSchLibrary(r.library);
            }
        });

        init();
        vscode.postMessage({ type: 'cad_tool', tool: 'list_parts' });
    </script>
</body>
</html>`;
    }

    private getLoadingHtml(message = 'Loading CAD environment...'): string {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style nonce="${nonce}">
        body {
            margin: 0; padding: 40px;
            background: #1e1e1e; color: #ccc;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            display: flex; align-items: center; justify-content: center;
            height: 100vh; box-sizing: border-box;
        }
        .loader { text-align: center; }
        .spinner {
            width: 40px; height: 40px;
            border: 3px solid #333; border-top-color: #4daafc;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="loader">
        <div class="spinner"></div>
        <div>${message}</div>
    </div>
</body>
</html>`;
    }

    /** Kill the Flask server when the extension deactivates. */
    public static cleanup(): void {
        if (CadPanel.serverProcess) {
            CadPanel.serverProcess.kill('SIGTERM');
            CadPanel.serverProcess = null;
        }
        if (CadPanel.pcbServerProcess) {
            CadPanel.pcbServerProcess.kill('SIGTERM');
            CadPanel.pcbServerProcess = null;
        }
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
