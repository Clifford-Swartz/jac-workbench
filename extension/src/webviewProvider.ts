import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { WSClient } from './wsClient';
import { CadPanel } from './cadPanel';

interface SavedMessage {
    role: 'user' | 'assistant';
    text: string;
    images?: Array<{data: string; mediaType: string}>;
    tools?: Array<{name: string; id: string; args: Record<string, unknown>; result?: string; isError?: boolean}>;
    timestamp: number;
}

interface ConversationMeta {
    id: string;
    title: string;
    timestamp: number;
    workspace: string;
    model: string;
    cost: number;
    turns: number;
}

const MAX_CONVERSATIONS = 50;

export class ClaudeUltraPanel {
    public static currentPanel: ClaudeUltraPanel | undefined;

    public static get wsClient(): WSClient | undefined {
        return ClaudeUltraPanel.currentPanel?.wsClient;
    }

    private panel: vscode.WebviewPanel;
    private wsClient: WSClient;
    private context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];
    private _askToolUseIds = new Set<string>();
    private isLocalModel = false;
    private localModelId = '';
    private localModelPort = 8787;
    private localAbortController: AbortController | null = null;
    private localServerProcess: cp.ChildProcess | null = null;
    private pendingCadQuery = false;
    private cloudResponseAccum = '';
    private localChatHistory: Array<{role: string; content: string}> = [];
    private static readonly MAX_HISTORY_TURNS = 10; // keep last 10 turns (20 messages)
    private greetingPending = false;

    static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext): void {
        if (ClaudeUltraPanel.currentPanel) {
            ClaudeUltraPanel.currentPanel.panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'claudeUltraPanel',
            'JAC',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
                ],
            },
        );

        ClaudeUltraPanel.currentPanel = new ClaudeUltraPanel(panel, extensionUri, context);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this.panel = panel;
        this.context = context;

        const config = vscode.workspace.getConfiguration('claudeUltra');
        const serverUrl = config.get<string>('serverUrl', 'ws://localhost:9100');
        const authToken = config.get<string>('authToken', '');

        this.wsClient = new WSClient(serverUrl, authToken, {
            onMessage: (msg) => {
                const raw = msg as Record<string, unknown>;
                // Handle greeting responses
                if (raw.type === 'greeting_response') {
                    this.greetingPending = false;
                    this.panel.webview.postMessage(msg);
                    return;
                }
                // Handle OpenRouter panel-open requests — run the VSCode command
                if (raw.type === 'open_panel') {
                    const sid = raw.session_id as string | undefined;
                    if (!sid || sid === this.wsClient.sessionId) {
                        const panel = (raw.panel as string) || '';
                        const cmdMap: Record<string, string> = {
                            cad: 'claudeUltra.cad',
                            pcb: 'claudeUltra.cad',  // PCB shares the CAD panel
                            browser: 'claudeUltra.browser',
                            music: 'claudeUltra.music',
                        };
                        const command = cmdMap[panel];
                        if (command) {
                            vscode.commands.executeCommand(command);
                            if (panel === 'pcb') {
                                // Switch to schematic tab after opening
                                setTimeout(() => {
                                    vscode.commands.executeCommand('claudeUltra.cadSchematicTab').then(undefined, () => {});
                                }, 500);
                            }
                        }
                    }
                    return;
                }
                // Handle tool execution requests — execute locally, send result back
                if (raw.type === 'tool_execute') {
                    const sid = raw.session_id as string | undefined;
                    if (!sid || sid === this.wsClient.sessionId) {
                        const toolName = (raw.tool_name as string).replace(/^mcp__\w+__/, '');
                        if (toolName === 'AskUserQuestion') {
                            this.panel.webview.postMessage({
                                type: 'ask_user_question',
                                tool_id: raw.tool_id,
                                question: (raw.tool_input as any).question || '',
                                options: (raw.tool_input as any).options || null,
                                multiSelect: (raw.tool_input as any).multiSelect || false,
                            });
                        } else {
                            this.executeToolLocally(
                                raw.tool_id as string,
                                raw.tool_name as string,
                                raw.tool_input as Record<string, unknown>,
                            );
                        }
                    }
                    return;
                }
                // Suppress tool_use/tool_result for AskUserQuestion — handled interactively via ask_user_question
                if (raw.type === 'tool_use') {
                    const tn = (raw.tool_name as string) || '';
                    if (tn.includes('AskUserQuestion')) {
                        this._askToolUseIds.add(raw.tool_use_id as string);
                        return;
                    }
                }
                if (raw.type === 'tool_result' && this._askToolUseIds.has(raw.tool_use_id as string)) {
                    this._askToolUseIds.delete(raw.tool_use_id as string);
                    return;
                }
                // Filter: only pass messages for our session (or global messages without session_id)
                const sid = raw.session_id as string | undefined;
                if (!sid || sid === this.wsClient.sessionId) {
                    this.panel.webview.postMessage(msg);

                    // Accumulate cloud response text for auto-execution
                    if (raw.type === 'assistant_text_delta') {
                        this.cloudResponseAccum += (raw.text as string || '');
                        // Check for complete code blocks (CAD)
                        if (this.cloudResponseAccum.includes('RESULT') && this.cloudResponseAccum.includes('```python') && this.cloudResponseAccum.split('```').length >= 3) {
                            this.autoExecuteCadCode(this.cloudResponseAccum);
                            this.cloudResponseAccum = '';
                        }
                        // Check for schematic commands as they stream
                        if (this.cloudResponseAccum.includes('[sch ') && this.cloudResponseAccum.includes(']')) {
                            this.autoExecuteSchCommands(this.cloudResponseAccum);
                            // Don't clear — more commands may follow
                        }
                    }
                    if (raw.type === 'assistant_text') {
                        const text = raw.text as string || this.cloudResponseAccum;
                        if (this.pendingCadQuery && this.cadResponseCallback) {
                            this.cadResponseCallback(text);
                            this.pendingCadQuery = false;
                            this.cadResponseCallback = null;
                        }
                        this.cloudResponseAccum = '';
                    }
                    if (raw.type === 'result') {
                        if (this.cloudResponseAccum) {
                            this.autoExecuteCadCode(this.cloudResponseAccum);
                            this.autoExecuteSchCommands(this.cloudResponseAccum);
                            this.cloudResponseAccum = '';
                        }
                    }
                }
            },
            onStatusChange: (status) =>
                this.panel.webview.postMessage({ type: 'connection_status', status }),
        });

        this.panel.webview.html = this.getHtml(extensionUri);

        // Messages from webview
        this.panel.webview.onDidReceiveMessage(
            (msg) => {
                switch (msg.type) {
                    case 'query': {
                        this.getCadContextPrefix(msg.prompt).then(cadPrefix => {
                            let prompt = msg.prompt;
                            if (cadPrefix) {
                                prompt += cadPrefix;
                            } else {
                                // Always let the model know CAD is available
                                prompt += '\n\n[Note: You have a built-in CAD tool. If the user asks about 3D modeling, CAD, creating objects, or designing parts, you can generate build123d Python code in a ```python block with RESULT = ... and it will auto-execute in a 3D viewer. Just mention it if relevant.]';
                            }
                            if (this.isLocalModel) {
                                this.queryLocalModel(prompt);
                            } else {
                                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                                this.wsClient.send({
                                    type: 'query',
                                    prompt,
                                    ...(msg.images?.length && { images: msg.images }),
                                    ...(cwd && { cwd }),
                                    ...(msg.provider_id && { provider_id: msg.provider_id }),
                                    client_platform: process.platform,
                                    client_home: os.homedir(),
                                    persist: false,
                                });
                            }
                        });
                        break;
                    }
                    case 'abort_query':
                        if (this.localAbortController) {
                            this.localAbortController.abort();
                        }
                        this.wsClient.send({ type: 'abort_query' });
                        break;
                    case 'council_query': {
                        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        this.wsClient.sendRaw({
                            type: 'council_query',
                            prompt: msg.prompt,
                            models: msg.models,
                            mode: msg.mode,
                            rounds: msg.rounds || 1,
                            session_id: this.wsClient.sessionId,
                            ...(cwd && { cwd }),
                            persist: false,  // extension owns its own chat history
                        });
                        break;
                    }
                    case 'new_conversation': {
                        this.wsClient.send({ type: 'new_conversation' });
                        // Generate fresh session for next conversation
                        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                        let newId = '';
                        for (let i = 0; i < 12; i++) { newId += chars.charAt(Math.floor(Math.random() * chars.length)); }
                        this.wsClient.sessionId = newId;
                        break;
                    }
                    case 'ready':
                        this.wsClient.connect();
                        // Send persisted model prefs
                        this.panel.webview.postMessage({
                            type: 'model_prefs',
                            favorites: this.context.globalState.get<string[]>('ccu.modelFavorites', []),
                            default: this.context.globalState.get<string>('ccu.defaultModel', ''),
                            preferred_machine_id: vscode.workspace.getConfiguration('claudeUltra').get<string>('preferredMachineId', ''),
                        });
                        break;
                    case 'set_model_favorites':
                        this.context.globalState.update('ccu.modelFavorites', msg.favorites || []);
                        break;
                    case 'set_default_model':
                        this.context.globalState.update('ccu.defaultModel', msg.model || '');
                        break;
                    case 'permission_response':
                        this.wsClient.sendRaw({
                            type: 'permission_response',
                            request_id: msg.request_id,
                            allow: msg.allow,
                            remember: msg.remember || false,
                        });
                        break;
                    case 'set_permission_mode':
                        this.wsClient.send({
                            type: 'set_permission_mode',
                            mode: msg.mode,
                        });
                        break;
                    case 'set_model':
                        // Kill old local server when switching models to prevent memory buildup
                        if (this.isLocalModel && (!msg.local || msg.model !== this.localModelId)) {
                            this.killLocalServer();
                        }
                        this.isLocalModel = msg.local || false;
                        if (msg.local) {
                            // Local model — handle entirely in extension, don't tell bridge
                            this.localModelId = msg.model;
                        } else {
                            // Cloud model — route through bridge
                            this.wsClient.sendRaw({
                                type: 'set_model',
                                model: msg.model,
                                local: false,
                                ...(msg.provider_id && { provider_id: msg.provider_id }),
                            });
                        }
                        break;
                    case 'save_conversation':
                        this.saveConversation(
                            msg.id,
                            msg.messages as SavedMessage[],
                            msg.metadata as Partial<ConversationMeta>,
                        );
                        break;
                    case 'load_history':
                        this.sendHistoryList();
                        break;
                    case 'restore_conversation':
                        this.restoreConversation(msg.id as string);
                        break;
                    case 'delete_conversation':
                        this.deleteConversation(msg.id as string);
                        break;
                    case 'get_local_models':
                    case 'browse_local_models':
                        this.detectLocalModels();
                        break;
                    case 'download_local_model': {
                        // Launch a chat prompt asking the cloud model to download the model
                        const modelId = msg.model_id;
                        const catalogEntry = ClaudeUltraPanel.MODEL_CATALOG.find(m => m.id === modelId);
                        const filename = catalogEntry?.filename || modelId;
                        const downloadPrompt = `I need you to download a local LLM model for me. ` +
                            `Please download the GGUF file "${filename}" from HuggingFace to ~/.jac/models/. ` +
                            `Use the huggingface_hub Python library (pip install huggingface_hub if needed). ` +
                            `The file should end up at ~/.jac/models/${filename}. ` +
                            `After downloading, confirm the file size and that it's ready to use.`;
                        // Inject as a query in the main chat
                        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        this.wsClient.send({
                            type: 'query',
                            prompt: downloadPrompt,
                            ...(cwd && { cwd }),
                        });
                        this.panel.webview.postMessage({
                            type: 'assistant_text_delta',
                            text: `*Asking AI to download ${catalogEntry?.label || modelId}...*\n`,
                        });
                        break;
                    }
                    case 'pair_phone':
                        vscode.commands.executeCommand('claudeUltra.pairPhone');
                        break;
                    case 'open_panel': {
                        const cmdMap: Record<string, string> = {
                            music: 'claudeUltra.music',
                            browser: 'claudeUltra.browser',
                            cad: 'claudeUltra.cad',
                        };
                        vscode.commands.executeCommand(cmdMap[msg.panel] || 'claudeUltra.browser');
                        break;
                    }
                    case 'generate_greeting':
                        this.generateGreeting();
                        break;
                    case 'ask_user_answer':
                        // User answered an AskUserQuestion — send result back to bridge
                        this.wsClient.sendRaw({
                            type: 'tool_result_response',
                            tool_id: msg.tool_id,
                            content: msg.answer,
                            is_error: false,
                            session_id: this.wsClient.sessionId,
                        });
                        break;
                }
            },
            null,
            this.disposables,
        );

        // React to settings changes
        vscode.workspace.onDidChangeConfiguration(
            (e) => {
                if (e.affectsConfiguration('claudeUltra')) {
                    const c = vscode.workspace.getConfiguration('claudeUltra');
                    this.wsClient.updateConfig(
                        c.get<string>('serverUrl', 'ws://localhost:9100'),
                        c.get<string>('authToken', ''),
                    );
                }
            },
            null,
            this.disposables,
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private cadResponseCallback: ((text: string) => void) | null = null;

    /** Get CAD system prompt with geometry context, or null if CAD panel is not open. */
    private static readonly SCH_KEYWORDS = /\b(schematic|circuit|pcb|resistor|capacitor|led|555|timer|blink|voltage|regulator|esp32|usb|connector|wire|net|pin|component|board|trace|gerber|bom)\b/i;

    private async getCadContextPrefix(prompt?: string): Promise<string | null> {
        const isSchQuery = prompt && ClaudeUltraPanel.SCH_KEYWORDS.test(prompt);

        if (!CadPanel.currentPanel) return null;

        // Schematic mode — when Schematic tab is active or query is schematic-related
        if (CadPanel.currentPanel.activeTab === 'sch' || isSchQuery) {
            let schContext = 'Empty schematic.';
            try {
                const ctx = await CadPanel.callPcbTool('get_context');
                if (ctx.context) schContext = ctx.context;
            } catch { /* server not ready */ }

            return `\n\n[Schematic Editor — auto-executes commands]\n## Current Schematic\n${schContext}\n## Schematic Commands\nTo build a schematic, output commands in this exact format, one per line:\n[sch add TYPE X Y] — place a component (types: resistor, capacitor, inductor, led, diode, npn, 555, esp32, usb_c, connector_2pin, vcc, gnd)\n[sch add TYPE X Y VALUE] — place with custom value (e.g. [sch add resistor 100 200 1K])\n[sch wire REF1 PIN1 REF2 PIN2] — connect two pins (e.g. [sch wire R1 2 U1 TRIG])\n[sch wire REF1 PIN1 REF2 PIN2 NETNAME] — connect with named net\n[sch reset] — clear schematic\n\n## Pin names by component\n- resistor: 1, 2\n- capacitor: 1, 2\n- led: A, K\n- diode: A, K\n- npn: B, C, E\n- 555: GND, TRIG, OUT, RESET, CTRL, THRES, DISCH, VCC\n- esp32: 3V3, EN, GPIO0-2, GND, TX, RX, USB_D+, USB_D-\n- usb_c: VBUS, GND, CC1, CC2, D+, D-\n- vcc: 1\n- gnd: 1\n\nPlace components with enough spacing (~100-150 units apart). Use real component values.\n[End Schematic Context]\n\n`;
        }

        // 3D CAD mode
        let geoContext = 'No geometry loaded.';
        try {
            const ctx = await CadPanel.callTool('geometry_context');
            if (ctx.ok) geoContext = ctx.context;
        } catch { /* server not ready */ }

        return `\n\n[CAD Context — the CAD viewer is open. Code auto-executes.]\n## Current Geometry\n${geoContext}\n## CAD Rules\n- Write a \`\`\`python code block with RESULT = ...\n- Start with: from build123d import *\n- INPUT_SHAPES = list of current solids. To modify existing: solid = INPUT_SHAPES[0]\n- RESULT = None clears all geometry\n## build123d API (IMPORTANT: follow these signatures exactly)\nPrimitives: Box(l,w,h) Cylinder(r,h) Sphere(r) Cone(r1,r2,h)\nBoolean: a + b (fuse) | a - b (cut) | a & b (intersect)\nTransform: solid.move(Location((x,y,z))) | solid.rotate(Axis.Z, deg)\nScale: scale(solid, factor) — standalone function, NOT a method.\nEdges: fillet(solid.edges(), radius) | chamfer(solid.edges(), length)\nCAUTION: fillet/chamfer/scale are STANDALONE functions, not methods.\n[End CAD Context]\n\n`;
    }

    /** Scan a model response for build123d code blocks and auto-execute them on the CAD server. */
    private async autoExecuteCadCode(responseText: string): Promise<void> {
        const hasCadCode = responseText.includes('RESULT') && (responseText.includes('```python') || responseText.includes('```py') || responseText.includes('build123d') || responseText.includes('from build123d'));
        if (!hasCadCode) return;
        if (!CadPanel.currentPanel) return;
        // Match code blocks: ```python, ```py, or ``` followed by build123d-like code
        const codeRegex = /```(?:python|py)?\s*\n([\s\S]*?)```/g;
        let match;
        while ((match = codeRegex.exec(responseText)) !== null) {
            const code = match[1].trim();
            if (!code.includes('RESULT')) continue;
            try {
                const result = await CadPanel.callTool('cad_execute', { code });
                if (CadPanel.currentPanel) {
                    CadPanel.currentPanel.updateGeometry(result);
                }
                if (result.ok) {
                    this.panel.webview.postMessage({ type: 'assistant_text_delta', text: `\n*CAD: Updated — ${result.n_parts} part(s)*\n` });
                } else {
                    this.panel.webview.postMessage({ type: 'assistant_text_delta', text: `\n*CAD Error: ${result.error?.split('\\n').pop() || result.error}*\n` });
                }
            } catch (err: any) {
                if (CadPanel.currentPanel) {
                    CadPanel.currentPanel.updateGeometry({ ok: false, error: err.message });
                }
            }
        }
        // Also try to find RESULT = ... patterns outside code blocks
        if (!responseText.includes('```') && responseText.includes('RESULT')) {
            const lines = responseText.split('\n').filter(l => l.includes('RESULT') || l.includes('import') || l.includes('Box') || l.includes('Cylinder') || l.includes('Sphere'));
            if (lines.length > 0) {
                const code = lines.join('\n');
                try {
                    const result = await CadPanel.callTool('cad_execute', { code });
                    if (CadPanel.currentPanel) {
                        CadPanel.currentPanel.updateGeometry(result);
                    }
                } catch { /* not valid code */ }
            }
        }
    }

    /** Parse and execute [sch ...] commands from model response. */
    private async autoExecuteSchCommands(responseText: string): Promise<void> {
        if (!CadPanel.currentPanel) return;
        const lines = responseText.split('\n');
        for (const line of lines) {
            const m = line.match(/\[sch\s+(\w+)\s+(.*?)\]/);
            if (!m) continue;
            const [, cmd, rest] = m;
            let result;
            try {
                if (cmd === 'add') {
                    // [sch add TYPE X Y] or [sch add TYPE X Y VALUE]
                    const parts = rest.trim().split(/\s+/);
                    const type = parts[0];
                    const x = parseFloat(parts[1]) || 0;
                    const y = parseFloat(parts[2]) || 0;
                    const value = parts[3];
                    const args: any = { type, x, y };
                    if (value) args.properties = { value };
                    result = await CadPanel.callPcbTool('add_component', args);
                } else if (cmd === 'wire') {
                    // [sch wire REF1 PIN1 REF2 PIN2] or [sch wire REF1 PIN1 REF2 PIN2 NET]
                    const parts = rest.trim().split(/\s+/);
                    result = await CadPanel.callPcbTool('add_wire', {
                        from_comp: parts[0], from_pin: parts[1],
                        to_comp: parts[2], to_pin: parts[3],
                        net: parts[4] || undefined,
                    });
                } else if (cmd === 'reset') {
                    result = await CadPanel.callPcbTool('reset');
                }
                if (result && CadPanel.currentPanel) {
                    (CadPanel.currentPanel as any).panel?.webview?.postMessage({ type: 'sch_result', result });
                }
            } catch (err: any) {
                this.panel.webview.postMessage({ type: 'assistant_text_delta', text: `\n*SCH Error: ${err.message}*\n` });
            }
        }
    }

    /** Called by CadPanel to send a query through the active model. */
    sendCadQuery(prompt: string, onResponse: (text: string) => void): void {
        this.cadResponseCallback = onResponse;
        this.pendingCadQuery = true;

        // Show in chat
        this.panel.webview.postMessage({ type: 'assistant_text_delta', text: '' });

        if (this.isLocalModel) {
            this.queryLocalModel(prompt).then(() => {
                // Response handled in queryLocalModel's stream
            });
        } else {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            this.wsClient.send({
                type: 'query',
                prompt,
                ...(cwd && { cwd }),
            });
        }
    }

    newConversation(): void {
        this.localChatHistory = []; // clear local model history
        this.wsClient.send({ type: 'new_conversation' });
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let newId = '';
        for (let i = 0; i < 12; i++) { newId += chars.charAt(Math.floor(Math.random() * chars.length)); }
        this.wsClient.sessionId = newId;
    }

    // Fallback catalog (used when HuggingFace API is unreachable)
    private static readonly FALLBACK_CATALOG = [
        { id: 'qwen3-30b-a3b', label: 'Qwen3 30B-A3B (MoE)', size: '18 GB', est_tok_s: 5, filename: 'Qwen3-30B-A3B-Q4_K_M.gguf' },
        { id: 'qwen2.5-7b', label: 'Qwen 2.5 7B', size: '4.7 GB', est_tok_s: 21, filename: 'qwen2.5-7b-instruct-q4_k_m.gguf' },
        { id: 'qwen2.5-3b', label: 'Qwen 2.5 3B', size: '2.0 GB', est_tok_s: 49, filename: 'qwen2.5-3b-instruct-q4_k_m.gguf' },
        { id: 'llama3.1-8b', label: 'Llama 3.1 8B', size: '4.9 GB', est_tok_s: 18, filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf' },
        { id: 'gemma3-12b', label: 'Gemma 3 12B', size: '7.3 GB', est_tok_s: 12, filename: 'gemma-3-12b-it-Q4_K_M.gguf' },
        { id: 'qwen2.5-14b', label: 'Qwen 2.5 14B', size: '9.0 GB', est_tok_s: 10, filename: 'qwen2.5-14b-instruct-q4_k_m.gguf' },
        { id: 'mixtral-8x7b', label: 'Mixtral 8x7B (MoE)', size: '26 GB', est_tok_s: 8, filename: 'mixtral-8x7b-instruct-v0.1.Q4_K_M.gguf' },
        { id: 'deepseek-r1-7b', label: 'DeepSeek R1 7B', size: '4.7 GB', est_tok_s: 20, filename: 'DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf' },
    ];

    private static dynamicCatalog: typeof ClaudeUltraPanel.FALLBACK_CATALOG | null = null;
    private static catalogFetchedAt = 0;

    /** Fetch trending GGUF models from HuggingFace. Caches for 1 hour. */
    private static async fetchModelCatalog(): Promise<typeof ClaudeUltraPanel.FALLBACK_CATALOG> {
        const now = Date.now();
        if (ClaudeUltraPanel.dynamicCatalog && now - ClaudeUltraPanel.catalogFetchedAt < 3600000) {
            return ClaudeUltraPanel.dynamicCatalog;
        }

        try {
            const https = await import('https');
            const data = await new Promise<string>((resolve, reject) => {
                const req = https.get(
                    'https://huggingface.co/api/models?filter=gguf&sort=trending&direction=-1&limit=20',
                    { headers: { 'Accept': 'application/json' } },
                    (res) => {
                        let body = '';
                        res.on('data', (c: Buffer) => { body += c; });
                        res.on('end', () => resolve(body));
                    },
                );
                req.on('error', reject);
                req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
            });

            const models = JSON.parse(data);
            const catalog: typeof ClaudeUltraPanel.FALLBACK_CATALOG = [];

            for (const m of models) {
                const repoId = m.modelId || m.id || '';
                if (!repoId) continue;
                // Look for Q4_K_M GGUF in siblings
                const siblings = m.siblings || [];
                const ggufFile = siblings.find((s: any) =>
                    s.rfilename?.endsWith('.gguf') && s.rfilename?.includes('Q4_K_M')
                );
                if (!ggufFile) continue;

                const filename = ggufFile.rfilename;
                const label = repoId.split('/').pop()?.replace(/-GGUF$/i, '') || repoId;
                const sizeBytes = ggufFile.size || 0;
                const sizeGB = sizeBytes > 0 ? (sizeBytes / 1e9).toFixed(1) : '?';
                const id = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');

                catalog.push({
                    id,
                    label,
                    size: `${sizeGB} GB`,
                    est_tok_s: sizeBytes < 5e9 ? 40 : sizeBytes < 10e9 ? 15 : sizeBytes < 20e9 ? 5 : 2,
                    filename,
                });
            }

            if (catalog.length >= 3) {
                ClaudeUltraPanel.dynamicCatalog = catalog;
                ClaudeUltraPanel.catalogFetchedAt = now;
                return catalog;
            }
        } catch { /* HuggingFace unreachable */ }

        return ClaudeUltraPanel.FALLBACK_CATALOG;
    }

    private static get MODEL_CATALOG() {
        return ClaudeUltraPanel.dynamicCatalog || ClaudeUltraPanel.FALLBACK_CATALOG;
    }

    /** Detect local models directly on this machine — no relay involved. */
    private async detectLocalModels(): Promise<void> {
        // Fetch trending models from HuggingFace (cached 1hr)
        const catalog = await ClaudeUltraPanel.fetchModelCatalog();

        const modelsDir = path.join(os.homedir(), '.jac', 'models');
        const downloadedFiles = new Set<string>();

        // Scan ~/.jac/models/ for downloaded GGUF files
        try {
            const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.gguf'));
            for (const file of files) {
                downloadedFiles.add(file.toLowerCase());
            }
        } catch { /* models dir doesn't exist */ }

        // Check if llama-server is running
        let runningModel = '';
        try {
            const http = await import('http');
            const resp = await new Promise<string>((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${this.localModelPort}/v1/models`, (res) => {
                    let data = '';
                    res.on('data', (c: Buffer) => { data += c; });
                    res.on('end', () => resolve(data));
                });
                req.on('error', reject);
                req.setTimeout(1000, () => { req.destroy(); reject(new Error('timeout')); });
            });
            const parsed = JSON.parse(resp);
            if (parsed.data?.length > 0) {
                runningModel = parsed.data[0].id.toLowerCase();
            }
        } catch { /* not running */ }

        // Build model list from catalog with status from local disk
        const models = catalog.map(m => {
            const isDownloaded = downloadedFiles.has(m.filename.toLowerCase());
            const isRunning = runningModel && runningModel.includes(m.filename.toLowerCase().replace('.gguf', ''));
            return {
                id: m.id,
                label: m.label,
                size: m.size,
                status: isRunning ? 'ready' : isDownloaded ? 'ready' : 'not_downloaded' as string,
                est_tok_s: m.est_tok_s,
            };
        });

        // Also add any GGUF files not in the catalog
        try {
            const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.gguf'));
            const catalogFilenames = new Set(catalog.map(m => m.filename.toLowerCase()));
            for (const file of files) {
                if (!catalogFilenames.has(file.toLowerCase())) {
                    const stats = fs.statSync(path.join(modelsDir, file));
                    const sizeGB = (stats.size / (1024 ** 3)).toFixed(1);
                    const label = file.replace('.gguf', '').replace(/-Q\d.*/, '');
                    models.unshift({
                        id: file.replace('.gguf', '').toLowerCase(),
                        label,
                        size: `${sizeGB} GB`,
                        status: 'ready',
                        est_tok_s: stats.size < 5e9 ? 40 : stats.size < 20e9 ? 5 : 2,
                    });
                }
            }
        } catch { /* */ }

        this.panel.webview.postMessage({ type: 'local_models_list', models });
    }

    disconnect(): void {
        this.wsClient.disconnect();
    }

    /** Check if llama-server is healthy on localhost. */
    private async isLocalServerReady(): Promise<boolean> {
        const http = await import('http');
        return new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${this.localModelPort}/health`, (res) => {
                let body = '';
                res.on('data', (c: Buffer) => { body += c; });
                res.on('end', () => resolve(body.includes('"ok"')));
            });
            req.on('error', () => resolve(false));
            req.setTimeout(2000, () => { req.destroy(); resolve(false); });
        });
    }

    /** Kill any existing llama-server and free memory. */
    private async killLocalServer(): Promise<void> {
        if (this.localServerProcess) {
            this.localServerProcess.kill('SIGTERM');
            this.localServerProcess = null;
            await new Promise(r => setTimeout(r, 1000));
        }
        // Also kill any orphaned llama-server on our port
        try {
            if (process.platform === 'win32') {
                // Windows: find PID on port via netstat, then taskkill
                const out = cp.execSync(`netstat -ano | findstr :${this.localModelPort}`, { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf-8' });
                const pids = new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean));
                for (const pid of pids) {
                    try { cp.execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
                }
            } else {
                // macOS / Linux
                cp.execSync(`lsof -ti:${this.localModelPort} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
            }
            await new Promise(r => setTimeout(r, 500));
        } catch { /* no process on port */ }
        // Purge memory cache to reclaim pages from previous model (macOS only)
        if (process.platform === 'darwin') {
            try {
                cp.execSync('purge', { stdio: 'ignore', timeout: 10000 });
            } catch { /* non-admin or timeout */ }
        }
    }

    /** Start llama-server for a local model if not already running. */
    private static readonly JAC_LLM_RELEASE = 'https://github.com/Clifford-Swartz/jac-llm-server/releases/latest/download';

    /** Download the JAC llama-server binary for this platform if not already present. */
    private async ensureJacBinary(): Promise<string | null> {
        const home = os.homedir();
        const binDir = path.join(home, '.jac', 'bin');
        const isWin = process.platform === 'win32';
        const binName = isWin ? 'llama-server.exe' : 'llama-server';
        const binPath = path.join(binDir, binName);

        if (fs.existsSync(binPath)) return binPath;

        // Determine platform artifact name
        let artifact: string;
        if (process.platform === 'darwin') {
            artifact = process.arch === 'arm64' ? 'llama-server-macos-arm64' : 'llama-server-macos-x64';
        } else if (process.platform === 'win32') {
            artifact = 'llama-server-windows-x64';
        } else {
            artifact = 'llama-server-linux-x64';
        }

        const archiveExt = isWin ? '.zip' : '.tar.gz';
        const url = `${ClaudeUltraPanel.JAC_LLM_RELEASE}/${artifact}${archiveExt}`;

        this.panel.webview.postMessage({
            type: 'assistant_text_delta',
            text: `*Downloading JAC LLM server (${artifact})...*\n`,
        });

        try {
            fs.mkdirSync(binDir, { recursive: true });
            const archivePath = path.join(binDir, `${artifact}${archiveExt}`);

            // Download
            const https = await import('https');
            await new Promise<void>((resolve, reject) => {
                const download = (downloadUrl: string, redirects = 0) => {
                    if (redirects > 5) { reject(new Error('Too many redirects')); return; }
                    https.get(downloadUrl, { headers: { 'User-Agent': 'JAC' } }, (res) => {
                        if (res.statusCode === 302 || res.statusCode === 301) {
                            download(res.headers.location!, redirects + 1);
                            return;
                        }
                        if (res.statusCode !== 200) {
                            reject(new Error(`HTTP ${res.statusCode}`));
                            return;
                        }
                        const file = fs.createWriteStream(archivePath);
                        res.pipe(file);
                        file.on('finish', () => { file.close(); resolve(); });
                    }).on('error', reject);
                };
                download(url);
            });

            // Extract
            if (isWin) {
                // Windows: use PowerShell to extract zip
                cp.execSync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${binDir}' -Force"`, { stdio: 'ignore' });
                const extractedExe = path.join(binDir, `${artifact}.exe`);
                if (fs.existsSync(extractedExe) && extractedExe !== binPath) {
                    fs.renameSync(extractedExe, binPath);
                }
            } else {
                // Unix: tar xzf
                cp.execSync(`tar xzf "${archivePath}" -C "${binDir}"`, { stdio: 'ignore' });
                const extractedBin = path.join(binDir, artifact);
                if (fs.existsSync(extractedBin) && extractedBin !== binPath) {
                    fs.renameSync(extractedBin, binPath);
                }
                fs.chmodSync(binPath, 0o755);
            }

            // Cleanup archive
            try { fs.unlinkSync(archivePath); } catch { /* */ }

            this.panel.webview.postMessage({
                type: 'assistant_text_delta',
                text: '*JAC LLM server installed!*\n',
            });

            return fs.existsSync(binPath) ? binPath : null;
        } catch (err: any) {
            this.panel.webview.postMessage({
                type: 'assistant_text_delta',
                text: `*Failed to download JAC LLM server: ${err.message}. Falling back to system llama-server.*\n`,
            });
            return null;
        }
    }

    private async ensureLocalServer(): Promise<boolean> {
        if (await this.isLocalServerReady()) return true;

        // Kill any stale server first to prevent memory buildup
        await this.killLocalServer();

        // Find model file and server binary
        const home = os.homedir();
        const modelsDir = path.join(home, '.jac', 'models');

        // Priority: 1. JAC binary (~/.jac/bin/) 2. pmem build 3. system install
        const jacBin = await this.ensureJacBinary();
        const pmemBuild = path.join(home, 'Desktop', 'pmem', 'Permem', 'vendor', 'llama.cpp', 'build-pmem', 'bin', 'llama-server');
        const systemBuildCandidates = process.platform === 'darwin'
            ? ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server']
            : process.platform === 'win32'
                ? [path.join(home, 'AppData', 'Local', 'Programs', 'llama-server', 'llama-server.exe')]
                : ['/usr/local/bin/llama-server', '/usr/bin/llama-server'];

        // Find the GGUF file for this model
        let files: string[] = [];
        try { files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.gguf')); } catch { /* */ }
        const modelFile = files.find(f => f.toLowerCase().includes(this.localModelId.replace(/-/g, '').toLowerCase().replace('30ba3b', '30B-A3B')))
            || files.find(f => f.toLowerCase().includes(this.localModelId.split('-')[0]))
            || files[0];

        if (!modelFile) {
            this.panel.webview.postMessage({ type: 'error', message: 'No local model file found' });
            return false;
        }

        const modelPath = path.join(modelsDir, modelFile);
        const modelSizeGB = fs.statSync(modelPath).size / (1024 ** 3);
        const systemBuild = systemBuildCandidates.find(p => fs.existsSync(p));

        // Pick the best available binary
        let serverBin: string;
        if (jacBin) {
            serverBin = jacBin;
        } else if (modelSizeGB > 14 && fs.existsSync(pmemBuild)) {
            serverBin = pmemBuild;
        } else {
            serverBin = systemBuild || (fs.existsSync(pmemBuild) ? pmemBuild : 'llama-server');
        }

        const args = [
            '--model', modelPath,
            '--port', String(this.localModelPort),
            '--ctx-size', '2048',
            '--n-gpu-layers', modelSizeGB > 14 ? '10' : '99',
            '--host', '127.0.0.1',
            '--no-warmup',
            '--parallel', '1',
        ];
        // JAC binary or pmem build: use TQ4 KV cache + fast-start flags
        const isJacOrPmem = (serverBin === jacBin) || (serverBin === pmemBuild);
        if (isJacOrPmem && modelSizeGB > 14) {
            args.push('--no-repack', '--batch-size', '2', '--ubatch-size', '2', '-fit', 'off',
                '--cache-type-k', 'tq4', '--cache-type-v', 'tq4');
        } else if (isJacOrPmem) {
            args.push('--cache-type-k', 'tq4', '--cache-type-v', 'tq4');
        }

        this.panel.webview.postMessage({ type: 'assistant_text_delta', text: '*Starting local model...*\n' });

        this.localServerProcess = cp.spawn(serverBin, args, { stdio: 'ignore' });
        this.localServerProcess.on('exit', () => { this.localServerProcess = null; });

        // Wait for health
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await this.isLocalServerReady()) return true;
        }
        this.panel.webview.postMessage({ type: 'error', message: 'Local model failed to start' });
        return false;
    }

    /** Query the local llama-server directly on localhost — no relay roundtrip. */
    private async queryLocalModel(prompt: string): Promise<void> {
        if (!await this.ensureLocalServer()) return;

        const http = await import('http');
        const url = `http://127.0.0.1:${this.localModelPort}/v1/chat/completions`;
        // Add user message to history
        this.localChatHistory.push({ role: 'user', content: prompt });

        // Trim history to MAX_HISTORY_TURNS (keep system prompt + recent turns)
        const maxMessages = ClaudeUltraPanel.MAX_HISTORY_TURNS * 2;
        if (this.localChatHistory.length > maxMessages) {
            this.localChatHistory = this.localChatHistory.slice(-maxMessages);
        }

        const systemMsg = { role: 'system', content: `You are a helpful assistant. Always respond in English. Be concise.

You have tools. To use one, write it on its own line in brackets:
[search your query here] — search the web for anything you don't know
[cad your build123d code here] — create/modify 3D geometry

Examples:
User: "What's the weather in Tokyo?"
You: Let me look that up.
[search weather tokyo today]

User: "Make a box"
You: Creating a box.
[cad RESULT = Box(50, 30, 20)]

Only use tools when needed. Always respond in English.` };

        const body = JSON.stringify({
            model: 'local',
            messages: [systemMsg, ...this.localChatHistory],
            stream: true,
            max_tokens: 512,
            repetition_penalty: 1.3,
            temperature: 0.7,
            top_p: 0.8,
        });

        this.localAbortController = new AbortController();
        const startTime = Date.now();
        let fullResponse = '';
        let inThinking = false;
        let thinkingText = '';
        let rawAccum = '';

        try {
            const resp = await new Promise<import('http').IncomingMessage>((resolve, reject) => {
                const req = http.request(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000, // 10s connection timeout
                }, resolve);
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('Connection timeout — local model may have crashed')); });
                this.localAbortController!.signal.addEventListener('abort', () => req.destroy());
                req.write(body);
                req.end();
            });

            let buffer = '';
            // Inactivity timeout: if no data for 120s, server probably died
            let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
            const resetInactivity = () => {
                if (inactivityTimer) clearTimeout(inactivityTimer);
                inactivityTimer = setTimeout(() => {
                    resp.destroy(new Error('Stream timeout — no data for 120s, local model may have crashed'));
                }, 120000);
            };
            resetInactivity();

            resp.on('data', (chunk: Buffer) => {
                resetInactivity();
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta || {};
                        const content = delta.content || '';
                        const thinking = delta.reasoning_content || '';

                        // Handle reasoning_content field (newer llama.cpp)
                        if (thinking) {
                            thinkingText += thinking;
                            this.panel.webview.postMessage({ type: 'thinking', text: thinking });
                            continue;
                        }

                        if (!content) continue;

                        // Handle <think> tags in content (older llama.cpp)
                        rawAccum += content;

                        // Check for <think> open tag
                        if (!inThinking && rawAccum.includes('<think>')) {
                            inThinking = true;
                            // Send any text before <think> as content
                            const before = rawAccum.split('<think>')[0];
                            if (before) {
                                fullResponse += before;
                                this.panel.webview.postMessage({ type: 'assistant_text_delta', text: before });
                            }
                            rawAccum = rawAccum.split('<think>').slice(1).join('<think>');
                        }

                        if (inThinking) {
                            // Check for </think> close tag
                            if (rawAccum.includes('</think>')) {
                                const parts = rawAccum.split('</think>');
                                thinkingText += parts[0];
                                this.panel.webview.postMessage({ type: 'thinking', text: parts[0] });
                                inThinking = false;
                                // Everything after </think> is the real answer
                                const after = parts.slice(1).join('</think>');
                                if (after) {
                                    fullResponse += after;
                                    this.panel.webview.postMessage({ type: 'assistant_text_delta', text: after });
                                }
                                rawAccum = '';
                            } else {
                                // Still in thinking — send to thinking bubble
                                thinkingText += content;
                                this.panel.webview.postMessage({ type: 'thinking', text: content });
                                rawAccum = '';
                            }
                        } else {
                            // Not in thinking — stream as normal content
                            fullResponse += content;
                            this.panel.webview.postMessage({ type: 'assistant_text_delta', text: content });
                            rawAccum = '';
                        }
                    } catch { /* skip parse errors */ }
                }
            });

            await new Promise<void>((resolve) => {
                resp.on('end', () => { if (inactivityTimer) clearTimeout(inactivityTimer); resolve(); });
                resp.on('error', () => { if (inactivityTimer) clearTimeout(inactivityTimer); resolve(); });
            });

            // Parse bracket-syntax tool calls from response: [search ...] [cad ...]
            const toolMatches = fullResponse.match(/\[(search|cad)\s+([^\]]+)\]/g);
            if (toolMatches) {
                for (const match of toolMatches) {
                    const m = match.match(/\[(search|cad)\s+([^\]]+)\]/);
                    if (!m) continue;
                    const [, toolName, toolArg] = m;

                    this.panel.webview.postMessage({
                        type: 'assistant_text_delta',
                        text: `\n*Using ${toolName}...*\n`,
                    });

                    let toolResult = '';
                    if (toolName === 'search') {
                        try {
                            const https = await import('https');
                            const query = encodeURIComponent(toolArg);
                            const searchUrl = `https://html.duckduckgo.com/html/?q=${query}`;
                            const html = await new Promise<string>((res, rej) => {
                                https.get(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
                                    let d = ''; r.on('data', (c: Buffer) => d += c); r.on('end', () => res(d));
                                }).on('error', rej);
                            });
                            const snippets = html.match(/class="result__snippet">(.*?)<\//g)
                                ?.slice(0, 5)
                                ?.map(s => s.replace(/class="result__snippet">/, '').replace(/<\//, '').replace(/<.*?>/g, ''))
                                || ['No results found'];
                            toolResult = snippets.join('\n');
                        } catch (e: any) {
                            toolResult = `Search failed: ${e.message}`;
                        }
                    } else if (toolName === 'cad') {
                        try {
                            const code = toolArg.includes('RESULT') ? toolArg : `RESULT = ${toolArg}`;
                            const r = await CadPanel.callTool('cad_execute', { code });
                            toolResult = r.ok ? `Created ${r.n_parts} part(s): ${JSON.stringify(r.parts)}` : r.error;
                        } catch (e: any) {
                            toolResult = `CAD error: ${e.message}`;
                        }
                    }

                    this.panel.webview.postMessage({
                        type: 'assistant_text_delta',
                        text: toolResult + '\n',
                    });
                    fullResponse += `\n${toolResult}`;
                }
            }

            const durationMs = Date.now() - startTime;
            this.panel.webview.postMessage({
                type: 'assistant_text',
                text: fullResponse,
                model: 'local',
                timings: { duration_ms: durationMs },
            });
            this.panel.webview.postMessage({
                type: 'result',
                duration_ms: durationMs,
                model: this.localModelId,
                cost: 0,
            });
            this.panel.webview.postMessage({ type: 'done' });

            // Save assistant response to conversation history
            if (fullResponse) {
                this.localChatHistory.push({ role: 'assistant', content: fullResponse });
            }

            // Forward response to CAD panel if this was a CAD query
            if (this.pendingCadQuery && this.cadResponseCallback) {
                this.cadResponseCallback(fullResponse);
                this.pendingCadQuery = false;
                this.cadResponseCallback = null;
            }

            // Auto-execute CAD/schematic commands in local model responses
            this.autoExecuteCadCode(fullResponse);
            this.autoExecuteSchCommands(fullResponse);
        } catch (err: any) {
            if (err?.code !== 'ABORT_ERR' && err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                const msg = err?.message || String(err);
                // Detect if llama-server crashed
                const isCrash = msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')
                    || msg.includes('socket hang up') || msg.includes('EPIPE');
                this.panel.webview.postMessage({
                    type: 'error',
                    message: isCrash
                        ? 'Local model crashed. Click retry or send a new message to restart.'
                        : `Local model error: ${msg}`,
                });
            }
            // Always end streaming state so UI doesn't get stuck
            this.panel.webview.postMessage({ type: 'done' });
        } finally {
            this.localAbortController = null;
        }
    }

    private getHtml(extensionUri: vscode.Uri): string {
        const webview = this.panel.webview;
        const cacheBust = Date.now();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles.css'),
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   img-src data:;
                   font-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}?v=${cacheBust}" rel="stylesheet">
    <title>JAC</title>
</head>
<body>
    <div id="app">
        <div id="header">
            <div id="title-wrapper">
                <span id="title">JAC</span>
                <span id="title-chevron">&#x25BE;</span>
                <div id="session-dropdown"></div>
            </div>
            <div id="header-actions">
                <button id="model-btn" title="Change model">Sonnet</button>
                <span id="or-credits" style="display:none;font-size:10px;opacity:0.6;margin:0 6px;" title="OpenRouter usage"></span>
                <div id="context-ring" title="Context usage"></div>
                <span id="connection-status"></span>
                <button id="pair-btn" title="Pair Phone"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="5" height="5" rx="0.8" fill="currentColor"/><rect x="1" y="1" width="3" height="3" rx="0.4" fill="var(--vscode-editor-background,#1e1e1e)"/><rect x="2" y="2" width="1" height="1" fill="currentColor"/><rect x="8" y="0" width="5" height="5" rx="0.8" fill="currentColor"/><rect x="9" y="1" width="3" height="3" rx="0.4" fill="var(--vscode-editor-background,#1e1e1e)"/><rect x="10" y="2" width="1" height="1" fill="currentColor"/><rect x="0" y="8" width="5" height="5" rx="0.8" fill="currentColor"/><rect x="1" y="9" width="3" height="3" rx="0.4" fill="var(--vscode-editor-background,#1e1e1e)"/><rect x="2" y="10" width="1" height="1" fill="currentColor"/><rect x="7" y="7" width="1.2" height="1.2" rx="0.2" fill="currentColor"/><rect x="9.2" y="7" width="1.2" height="1.2" rx="0.2" fill="currentColor"/><rect x="11.4" y="7" width="1.2" height="1.2" rx="0.2" fill="currentColor"/><rect x="7" y="9.2" width="1.2" height="1.2" rx="0.2" fill="currentColor"/><rect x="11.4" y="9.2" width="1.2" height="1.2" rx="0.2" fill="currentColor"/><rect x="7" y="11.4" width="1.2" height="1.2" rx="0.2" fill="currentColor"/><rect x="9.2" y="11.4" width="3.4" height="1.2" rx="0.2" fill="currentColor"/></svg></button>
                <button id="new-convo-btn" title="New conversation">&#x229E;</button>
            </div>
        </div>
        <div id="messages"></div>
        <div id="input-area">
            <div id="streaming-indicator">
                <span class="streaming-dot"></span>
                <span id="streaming-label">Responding...</span>
            </div>
            <div id="slash-menu"></div>
            <div id="input-container">
                <textarea id="prompt-input" placeholder="Type your message..." rows="1"></textarea>
                <div id="image-previews"></div>
                <div id="input-toolbar">
                    <button id="mode-btn" title="Permission mode (click to change)">Bypass</button>
                    <span id="input-hint">Shift+Enter for new line</span>
                    <span class="spacer"></span>
                    <button id="attach-btn" title="Attach images (Clippy wants to help!)">
                        <img id="clippy-img" alt="Clippy" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACYAAAAoCAYAAACSN4jeAAAHPklEQVR4nO1YbWyVZxm+7ud9z/ue73N62tOW9tBBLQ4oWyljaMeUItO5KJkja7dsERf9wWAxxmQQfhhPT/SHaAJbMknUaDBZlq01gzEsRBOL2wgEC4XJAUaVdVBW1kK/aE/f8348t3naDhNX0pYu00SuP+e8J+9zP9dzf1z3/RzgDu7g/xQ0l8XNzc1aNpuctHFYZjIZif82mJlm8tvtQr+dRQ0NzRoReX852P6Nd7O9668PDA+XFcV2E1GXIkdEjM8YlE6nhfpy4Wz/mhPHL3JnZw+f6viAf7GjpWfnzgOVAN98Zy6YrQFuaGjQa2qWVL9ztG3Xspr5XFVVmq9ZXmF99Wv3lb7f+c8fAKTCKT6rUI7nzsaNGyu3b9/2ZFlZVd3efS/XVi0qknV1D5i6LtxYPMJlZSk/ANnV1WWk02tQXV18M6QtLS1YuhTjz5nM+OenEm5SubNlyw+r1MPgdd5k55lt23JzuRwzs/fKK3+QNfc+eDyVqv3yTM4pSENra6s55+RXCc3MXfn89c1rH6oZef31NzOpVNmPhYCU0hMLF1Tx5i0P3//2Wwf/6tPX7Vn/rcUYzdlhkCsUpKSg5zkqxDIUNAoBf840ezcz42xTU5r+U2qmLe/JKlOsCtaseXBVX19v67lznWh8/OlnX3zxpRdK5kX9RAKWlYfjDspTJ94Qbx09iIVVBSB2IVmCSShDEGrr8RQkeLLwkY1P7TrEnBZEn9S/aT3W1NQ07qqOjmzJTzK7Vv9y9wvvVFYudRoff3aDYZomkZDZbFY0NGxAIBARe/e28uL+j7yB4Sx8QqUcQbIgEoqc9MIhwydl+EdPP7nzUFtbWifKuFNGaPog3vQaH2k7tczxjA0fXP5w66OPfSlMYgjtJ/6IyrvW4bvf+w76+69jz+8O4Nx7LbDc09C1ABgeJBMIxD5NI5A2sPTudZX79p0abmpqUoanLIIZlbVarNrP6rXLz9Q/tKr58odXwrGYIf/W/iY6Lx7BseN7se35n2LPb15F9+W3YXuXYPrmQaMwdIrAoCg0CsiAPwZDCx+vrX1s8GO7c05+Ve7pdFrs399VnixK4rXXWpHLn8TiynL86dAJnD53FFufX4CrPS7KF4SgGwxyTUADSEqw1DgcDyI3qrUrTvX1EJkMbtlbZyGEDVCVE41GfSxtnD/fyRV3RZGM2YjHi7GitgKODKDjjInEPEYoSggVAqE4I1KkIVKsIVIkkCwNnZ+Jhs1KoZlBxcUL4Lq9CPod+HUTYA1GKIhUeRSX/uFHdbVAJKCrMKm8gk/TIUDQWAi2JTT4LylbfX3V/KkQ6+3Nqr3YtdgLBfyIFsSgSQ3Cr0MVnK4bAIdQUmpiJOeCxxjWCONK9zDU0EF6QNh53fP5YleUvWw2O3diqiqfe65aqYZ46tvIBMNBRMIRCpkmkuEASmIhEGnjEuVYeWhsoDARha5pcGyhNuGkH4j5jX6vYHmvsqkqcu4eO/FrvbGx0csN/f5ny5aE6oilB9cW4YJSDOWHwJoPVs7FRz19SCajIHZwoasHZzsvwmcIJMJRmSgpR7yw8L0lySU3JkSV5kaM+Vc+WrnJudbT/IwRCmyVOruu62jFhTn8/YyJMbsYoCqkKiwYfhO6CKG7ewBXBwdQVhLH4kWlKCgqZhEsgK6Hjk1YrZ92XzEtKdrkDPe/8agvJH9rWdJLBKGN3rCx/IuFYPSi/XgStjyLmnsJzH4MjeYwf0Ecy5YuRN3Ke5AqTwFCE+Q5MHQcmLDcN21VTqljEyNyiyBqdAYH9z8B3X6ZJJNnuRQL+kg3bIyNlODhr9/AsZMdCAYNJAoWwfUGIeFB0wVShRXwB8JwHE8aAT/ZlnshFn/iyGQXkbMmpiRhMv5ebuTgNmjWDs/xWDoeyAPpiTjKygdxtceAxDWYPj8M3YRtuyhOliAeex+lhfMRDsfgeTZ8gmTAH9SFh58Tkav6I4Ap++Mte+WEp5rIsuor2B3eHQiHH3HG+uFYNhNDsm4waUTDQzfEq81Ma78CVFUybDePgb5KnDk7hhX3dyMRLYWUnpJRzxc0NXtMdoSjG1YBTRLIsJKdWeWYmiTUCKKxP6WbRvfY6Mhh1+armqZTIJHQgtGQHjA1rWRejFbeN8J/PuS6Z07PdzvP3SOv9AT5gbpRFMVL1BABljw+7bgOuxCxZ5S3WlqqaSakPuGxqcB8IQr0L/LskVrPy9dK6ayQ0rs7GDEKRoYt9PUSTJOQKLCVjknPgxxXfRLsD4d9uSHr+6H4hpeY1c2q0ZsJqVsSUzozUdJrvalOyHy+aGysb3EgIGuA0S/Ac5bnLftzpukLQnUAOAD8sEacHYHIN7czt+lEa6fNq2mJTXGJJeCwAA6rq8QUZDUwn0zBvfZ5j50VgFidz+ffDUXWp2frqRkTuzXZFgGovwf6+FYbz+Xye1s3cZqUk38TUAdME1BNH5OdfG/WnrqDO7gD/I/iXxPAONqu9jjcAAAAAElFTkSuQmCC" />
                    </button>
                    <button id="send-btn" title="Send message">&#x2191;</button>
                </div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}?v=${cacheBust}"></script>
</body>
</html>`;
    }

    private generateGreeting(): void {
        if (this.greetingPending || !this.wsClient) { return; }
        this.greetingPending = true;
        this.wsClient.sendRaw({ type: 'generate_greeting' });
    }

    private getWorkspacePath(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'global';
    }

    private getIndex(): ConversationMeta[] {
        return this.context.globalState.get<ConversationMeta[]>('ccu.conversations.index', []);
    }

    private async saveConversation(
        id: string,
        messages: SavedMessage[],
        metadata: Partial<ConversationMeta>,
    ): Promise<void> {
        if (!messages || messages.length === 0) { return; }
        const workspace = this.getWorkspacePath();
        const meta: ConversationMeta = {
            id,
            title: metadata.title || messages.find(m => m.role === 'user')?.text?.slice(0, 80) || 'Untitled',
            timestamp: Date.now(),
            workspace,
            model: metadata.model || '',
            cost: metadata.cost || 0,
            turns: metadata.turns || 0,
        };

        const index = this.getIndex().filter(c => c.id !== id);
        index.unshift(meta);

        // Prune old conversations for this workspace
        const wsConvos = index.filter(c => c.workspace === workspace);
        if (wsConvos.length > MAX_CONVERSATIONS) {
            const toRemove = wsConvos.slice(MAX_CONVERSATIONS);
            for (const old of toRemove) {
                await this.context.globalState.update(`ccu.conversation.${old.id}`, undefined);
            }
        }
        const pruned = index.filter(
            c => c.workspace !== workspace || wsConvos.indexOf(c) < MAX_CONVERSATIONS,
        );

        await this.context.globalState.update('ccu.conversations.index', pruned);
        await this.context.globalState.update(`ccu.conversation.${id}`, messages);
    }

    private sendHistoryList(): void {
        const workspace = this.getWorkspacePath();
        // Show all conversations, current workspace first
        const index = this.getIndex().sort((a, b) => {
            const aMatch = a.workspace === workspace ? 0 : 1;
            const bMatch = b.workspace === workspace ? 0 : 1;
            if (aMatch !== bMatch) { return aMatch - bMatch; }
            return b.timestamp - a.timestamp;
        });
        this.panel.webview.postMessage({ type: 'history_list', conversations: index });
    }

    private async restoreConversation(id: string): Promise<void> {
        const messages = this.context.globalState.get<SavedMessage[]>(`ccu.conversation.${id}`);
        const meta = this.getIndex().find(c => c.id === id);
        if (messages) {
            this.panel.webview.postMessage({
                type: 'conversation_loaded',
                messages,
                meta: meta || null,
            });
        }
    }

    private async deleteConversation(id: string): Promise<void> {
        const index = this.getIndex().filter(c => c.id !== id);
        await this.context.globalState.update('ccu.conversations.index', index);
        await this.context.globalState.update(`ccu.conversation.${id}`, undefined);
        this.sendHistoryList();
    }

    // ── Local tool execution ──────────────────────────────────────────────

    private executeToolLocally(toolId: string, toolName: string, toolInput: Record<string, unknown>): void {
        // Strip MCP prefix if present (e.g. "mcp__local__Read" → "Read")
        const name = toolName.replace(/^mcp__\w+__/, '');

        const sendResult = (content: string, isError = false) => {
            this.wsClient.sendRaw({
                type: 'tool_result_response',
                tool_id: toolId,
                content,
                is_error: isError,
                session_id: this.wsClient.sessionId,
            });
        };

        try {
            switch (name) {
                case 'Read':
                    this.toolRead(toolInput, sendResult);
                    break;
                case 'Write':
                    this.toolWrite(toolInput, sendResult);
                    break;
                case 'Edit':
                    this.toolEdit(toolInput, sendResult);
                    break;
                case 'Bash':
                    this.toolBash(toolInput, sendResult);
                    break;
                case 'Glob':
                    this.toolGlob(toolInput, sendResult);
                    break;
                case 'Grep':
                    this.toolGrep(toolInput, sendResult);
                    break;
                case 'ListDirectory':
                    this.toolListDirectory(toolInput, sendResult);
                    break;
                default:
                    sendResult(`Unknown tool: ${name}`, true);
            }
        } catch (e: any) {
            sendResult(e.message || String(e), true);
        }
    }

    private toolRead(input: Record<string, unknown>, send: (content: string, isError?: boolean) => void): void {
        const filePath = input.file_path as string;
        if (!filePath) { send('file_path is required', true); return; }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            const offset = (input.offset as number) || 0;
            const limit = (input.limit as number) || lines.length;
            const sliced = lines.slice(offset, offset + limit);
            const numbered = sliced.map((line, i) => `${String(offset + i + 1).padStart(6)}→${line}`).join('\n');
            send(numbered);
        } catch (e: any) {
            send(e.message, true);
        }
    }

    private toolWrite(input: Record<string, unknown>, send: (content: string, isError?: boolean) => void): void {
        const filePath = input.file_path as string;
        const content = input.content as string;
        if (!filePath || content === undefined) { send('file_path and content are required', true); return; }
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            fs.writeFileSync(filePath, content, 'utf-8');
            send(`File written: ${filePath}`);
        } catch (e: any) {
            send(e.message, true);
        }
    }

    private toolEdit(input: Record<string, unknown>, send: (content: string, isError?: boolean) => void): void {
        const filePath = input.file_path as string;
        const oldString = input.old_string as string;
        const newString = input.new_string as string;
        const replaceAll = input.replace_all === true;
        if (!filePath || oldString === undefined || newString === undefined) {
            send('file_path, old_string, and new_string are required', true);
            return;
        }
        try {
            let content = fs.readFileSync(filePath, 'utf-8');
            if (!content.includes(oldString)) {
                send(`old_string not found in ${filePath}`, true);
                return;
            }
            if (replaceAll) {
                content = content.split(oldString).join(newString);
            } else {
                const idx = content.indexOf(oldString);
                content = content.substring(0, idx) + newString + content.substring(idx + oldString.length);
            }
            fs.writeFileSync(filePath, content, 'utf-8');
            send(`File updated: ${filePath}`);
        } catch (e: any) {
            send(e.message, true);
        }
    }

    private toolBash(input: Record<string, unknown>, send: (content: string, isError?: boolean) => void): void {
        const command = input.command as string;
        if (!command) { send('command is required', true); return; }
        const cwd = (input.cwd as string) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const resolvedCwd = fs.existsSync(cwd) ? cwd : os.homedir();
        const timeout = (input.timeout as number) || 120000;
        cp.exec(command, {
            cwd: resolvedCwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf-8',
        }, (err, stdout, stderr) => {
            if (err) {
                send((stdout || '') + (stderr || '') || err.message, true);
            } else {
                send(stdout || '(no output)');
            }
        });
    }

    private toolGlob(input: Record<string, unknown>, send: (content: string, isError?: boolean) => void): void {
        const pattern = input.pattern as string;
        if (!pattern) { send('pattern is required', true); return; }
        const searchPath = (input.path as string) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
        try {
            // Cross-platform: walk directory tree with Node.js fs
            const skip = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
            const matches: string[] = [];
            const maxResults = 100;

            // Convert glob to regex: **/ = any path, * = any name chars, ? = single char
            const regexStr = pattern
                .replace(/\./g, '\\.')
                .replace(/\*\*\//g, '(.+/)?')
                .replace(/\*/g, '[^/]*')
                .replace(/\?/g, '[^/]');
            const re = new RegExp('^' + regexStr + '$');

            const maxDepth = 20;
            const walk = (dir: string, rel: string, depth: number) => {
                if (matches.length >= maxResults || depth > maxDepth) { return; }
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    if (matches.length >= maxResults) { return; }
                    const childRel = rel ? rel + '/' + entry.name : entry.name;
                    if (entry.isDirectory()) {
                        if (!skip.has(entry.name)) { walk(path.join(dir, entry.name), childRel, depth + 1); }
                    } else if (re.test(childRel) || re.test(entry.name)) {
                        matches.push(path.join(dir, entry.name));
                    }
                }
            };
            walk(searchPath, '', 0);
            send(matches.join('\n') || '(no matches)');
        } catch (e: any) {
            send(e.message, true);
        }
    }

    private toolGrep(input: Record<string, unknown>, send: (content: string, isError?: boolean) => void): void {
        const pattern = input.pattern as string;
        if (!pattern) { send('pattern is required', true); return; }
        const searchPath = (input.path as string) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
        const globFilter = input.glob as string || '';
        const outputMode = (input.output_mode as string) || 'files_with_matches';

        try {
            const re = new RegExp(pattern);
            const skip = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);
            const results: string[] = [];
            const maxResults = 200;

            // Optional glob filter → regex
            let globRe: RegExp | null = null;
            if (globFilter) {
                const g = globFilter.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
                globRe = new RegExp(g + '$');
            }

            const maxDepth = 20;
            const walk = (dir: string, depth: number) => {
                if (results.length >= maxResults || depth > maxDepth) { return; }
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    if (results.length >= maxResults) { return; }
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (!skip.has(entry.name)) { walk(full, depth + 1); }
                    } else {
                        if (globRe && !globRe.test(entry.name)) { continue; }
                        try {
                            const content = fs.readFileSync(full, 'utf-8');
                            const lines = content.split('\n');
                            let matchCount = 0;
                            const matchLines: string[] = [];
                            for (let i = 0; i < lines.length; i++) {
                                if (re.test(lines[i])) {
                                    matchCount++;
                                    matchLines.push(`${full}:${i + 1}:${lines[i]}`);
                                }
                            }
                            if (matchCount > 0) {
                                if (outputMode === 'files_with_matches') {
                                    results.push(full);
                                } else if (outputMode === 'count') {
                                    results.push(`${full}:${matchCount}`);
                                } else {
                                    results.push(...matchLines);
                                }
                            }
                        } catch { /* skip binary/unreadable files */ }
                    }
                }
            };

            // If searchPath is a file, search just that file
            const stat = fs.statSync(searchPath);
            if (stat.isFile()) {
                const content = fs.readFileSync(searchPath, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (re.test(lines[i])) {
                        results.push(`${searchPath}:${i + 1}:${lines[i]}`);
                    }
                }
            } else {
                walk(searchPath, 0);
            }
            send(results.join('\n') || '(no matches)');
        } catch (e: any) {
            send(e.message, true);
        }
    }

    private toolListDirectory(input: Record<string, unknown>, send: (content: string, isError?: boolean) => void): void {
        const dirPath = input.path as string;
        if (!dirPath) { send('path is required', true); return; }
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const lines = entries.map(e => `${e.isDirectory() ? '[dir]  ' : '[file] '}${e.name}`);
            send(lines.join('\n') || '(empty directory)');
        } catch (e: any) {
            send(e.message, true);
        }
    }

    private dispose(): void {
        ClaudeUltraPanel.currentPanel = undefined;
        this.wsClient.disconnect();
        this.panel.dispose();
        this.disposables.forEach((d) => d.dispose());
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
