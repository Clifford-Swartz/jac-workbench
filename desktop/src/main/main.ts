import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, Notification } from 'electron';
import type { BrowserWindow as BrowserWindowType, Tray as TrayType } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import { spawn } from 'child_process';
import { WSClient } from './wsClient';
import { AgentScheduler } from './agentScheduler';
import { fetchORModels, queryOR, ORModel } from './orClient';

const CONFIG_PATH = path.join(os.homedir(), '.jac', 'config.json');
const DEFAULT_CONFIG = {
    relayUrl: 'wss://mellow-backend.onrender.com',
    authToken: '',
    preferredMachineId: 'Mac.attlocal.net',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openAtLogin: false,
    windowBounds: { width: 1000, height: 700 },
    favoriteModels: [] as string[],
    defaultModel: '',
};

function loadConfig(): typeof DEFAULT_CONFIG {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg: typeof DEFAULT_CONFIG): void {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let mainWindow: BrowserWindowType | null = null;
let tray: TrayType | null = null;
let wsClient: WSClient | null = null;
let scheduler: AgentScheduler | null = null;
let config = loadConfig();

// OR state
let orModels: ORModel[] = [];
let currentModel = '';          // tracks selected model across set_model messages
let orAbort: AbortController | null = null;
const CLAUDE_FALLBACK_IDS = new Set(['sonnet', 'opus', 'haiku']);

function isORModel(id: string): boolean { return id.startsWith('or:'); }

// Ollama state
let ollamaModels: ORModel[] = [];
let ollamaAbort: AbortController | null = null;
let ollamaPollTimer: ReturnType<typeof setTimeout> | null = null;
let lastOllamaLocalList: unknown[] = [];

function isOllamaModel(id: string): boolean { return id.startsWith('ollama:'); }

function fmtBytes(b: number): string {
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
    return b + ' B';
}

async function pollOllamaModels(): Promise<void> {
    if (ollamaPollTimer) clearTimeout(ollamaPollTimer);
    try {
        const [tagsRes, psRes] = await Promise.all([
            fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) }),
            fetch('http://localhost:11434/api/ps',   { signal: AbortSignal.timeout(2000) }),
        ]);
        if (tagsRes.ok) {
            const tags = await tagsRes.json() as { models: Array<{ name: string; size: number; details?: { parameter_size?: string } }> };
            const ps   = psRes.ok ? (await psRes.json() as { models: Array<{ name: string }> }) : { models: [] };
            const hotNames = new Set((ps.models || []).map((m: { name: string }) => m.name));

            const prev = ollamaModels.map(m => m.id).join(',');
            ollamaModels = [];   // cleared — Ollama models go to LOCAL tab only

            lastOllamaLocalList = (tags.models || []).map(m => ({
                id: `ollama:${m.name}`,
                label: m.name,
                size: fmtBytes(m.size),
                status: 'ready',
                est_tok_s: hotNames.has(m.name) ? 40 : undefined,
            }));

            // Send to LOCAL tab (merging happens at relay intercept too, but send here for immediate display)
            mainWindow?.webContents.send('relay-message', { type: 'local_models_list', models: lastOllamaLocalList });
        }
    } catch { /* Ollama not running */ }
    ollamaPollTimer = setTimeout(pollOllamaModels, 10000);
}

async function handleOllamaQuery(msg: Record<string, unknown>, modelName: string): Promise<void> {
    ollamaAbort?.abort();
    ollamaAbort = new AbortController();

    const prompt = msg.prompt as string;
    const rawHistory = (msg.history as Array<{ role: string; text: string }> | undefined) || [];
    const messages = [
        ...rawHistory.map(h => ({ role: h.role, content: h.text })),
        { role: 'user', content: prompt },
    ];

    const send = (delta: Record<string, unknown>) => mainWindow?.webContents.send('relay-message', delta);

    try {
        const res = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName, messages, stream: true }),
            signal: ollamaAbort.signal,
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        send({ type: 'stream_start' });

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
                    if (obj.message?.content) send({ type: 'stream_chunk', text: obj.message.content });
                    if (obj.done) send({ type: 'stream_end' });
                } catch { /* skip malformed */ }
            }
        }
    } catch (err: any) {
        if (err.name !== 'AbortError') send({ type: 'error', message: String(err.message) });
    }
    ollamaAbort = null;
}

function mergeModelsForUI(relayModels: ORModel[]): { models: ORModel[]; current_model: string } {
    // Only filter Claude fallbacks once OR models are actually loaded
    const shouldFilter = config.openrouterApiKey && orModels.length > 0;
    const filtered = shouldFilter
        ? relayModels.filter(m => !CLAUDE_FALLBACK_IDS.has(m.id))
        : relayModels;
    const combined = [...ollamaModels, ...orModels, ...filtered];
    // If current model was filtered out, default to first OR model
    const cur = combined.find(m => m.id === currentModel)
        ? currentModel
        : (orModels[0]?.id ?? '');
    return { models: combined, current_model: cur };
}

let pushCount = 0;
let lastRelayModelsSent: string[] = [];
let lastRelayModelsReceived: string[] = [];

function pushModelsToUI(): void {
    const { models, current_model } = mergeModelsForUI([]);
    if (models.length === 0) return;
    pushCount++;
    lastRelayModelsSent = models.slice(0, 3).map(m => m.id);
    mainWindow?.webContents.send('relay-message', { type: 'models_list', models, current_model });
}

async function handleORQuery(msg: Record<string, unknown>, modelId: string): Promise<void> {
    orAbort?.abort();
    orAbort = new AbortController();

    const prompt = msg.prompt as string;
    const rawHistory = (msg.history as Array<{ role: string; text: string }> | undefined) || [];
    const messages = [
        ...rawHistory.map(h => ({ role: h.role, content: h.text })),
        { role: 'user', content: prompt },
    ];

    await queryOR(config.openrouterApiKey, modelId, messages,
        (delta) => mainWindow?.webContents.send('relay-message', delta),
        orAbort.signal,
    );
    orAbort = null;
}

function createWindow(): BrowserWindowType {
    const win = new BrowserWindow({
        width: config.windowBounds.width,
        height: config.windowBounds.height,
        minWidth: 480,
        minHeight: 400,
        title: 'JAC',
        backgroundColor: '#1e1e1e',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile(path.join(__dirname, '../renderer/index.html'));

    win.on('resize', () => {
        const [width, height] = win.getSize();
        config.windowBounds = { width, height };
        saveConfig(config);
    });

    win.on('close', (e) => {
        // Hide to tray instead of quitting
        e.preventDefault();
        win.hide();
    });

    return win;
}

function createTray(): void {
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    const icon = fs.existsSync(iconPath)
        ? nativeImage.createFromPath(iconPath)
        : nativeImage.createEmpty();

    tray = new Tray(icon);
    tray.setToolTip('JAC');

    const updateMenu = () => {
        const pendingFindings = scheduler?.getPendingFindings() ?? [];
        const menu = Menu.buildFromTemplate([
            {
                label: 'Open JAC',
                click: () => { mainWindow?.show(); mainWindow?.focus(); },
            },
            { type: 'separator' },
            ...(pendingFindings.length > 0 ? [
                {
                    label: `${pendingFindings.length} new finding${pendingFindings.length > 1 ? 's' : ''}`,
                    enabled: false,
                },
                ...pendingFindings.slice(0, 3).map(f => ({
                    label: `  ${f.taskName}: ${f.summary.substring(0, 40)}...`,
                    click: () => { mainWindow?.show(); mainWindow?.focus(); },
                })),
                { type: 'separator' as const },
            ] : []),
            {
                label: 'Research Tasks',
                submenu: scheduler?.getTaskNames().map(name => ({
                    label: name,
                    click: () => scheduler?.runNow(name),
                })) ?? [],
            },
            { type: 'separator' },
            {
                label: 'Quit JAC',
                click: () => { app.quit(); },
            },
        ]);
        tray!.setContextMenu(menu);
    };

    tray.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });

    updateMenu();
    scheduler?.on('taskComplete', updateMenu);
    scheduler?.on('taskComplete', (finding: { taskName: string; summary: string }) => {
        new Notification({
            title: `JAC: ${finding.taskName}`,
            body: finding.summary.substring(0, 120),
        }).show();
    });
}

// Forward relay messages from wsClient to renderer
interface SerializedMsg {
    role: 'user' | 'assistant';
    text: string;
    tools?: Array<{ name: string; id: string; args: Record<string, unknown>; result?: string; isError?: boolean }>;
    timestamp: number;
}

function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return (content as Array<Record<string, unknown>>)
            .map(c => c.type === 'text' ? String(c.text) : c.type === 'image' ? '[image]' : '')
            .filter(Boolean).join('\n');
    }
    return String(content ?? '');
}

function loadClaudeCodeHistory(cwd: string): void {
    try {
        const encoded = cwd.replace(/[\/ ]/g, '-');
        const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
        if (!fs.existsSync(projectDir)) return;

        const files = fs.readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        if (!files.length) return;

        const jsonlPath = path.join(projectDir, files[0].f);
        const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);

        const messages: SerializedMsg[] = [];
        // Maps tool_use_id → the assistant SerializedMsg that owns it
        const pendingTools = new Map<string, SerializedMsg>();

        for (const line of lines) {
            try {
                const obj = JSON.parse(line) as Record<string, unknown>;
                if (obj.type !== 'user' && obj.type !== 'assistant') continue;
                const msg = obj.message as Record<string, unknown> | undefined;
                if (!msg) continue;

                const role = msg.role as 'user' | 'assistant';
                const content = msg.content;
                const ts = new Date(obj.timestamp as string).getTime() || Date.now();
                const blocks = typeof content === 'string'
                    ? [{ type: 'text', text: content }]
                    : (Array.isArray(content) ? content as Array<Record<string, unknown>> : []);

                const textParts: string[] = [];
                const toolUses: Array<{ name: string; id: string; args: Record<string, unknown> }> = [];
                const toolResults: Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> = [];

                for (const block of blocks) {
                    if (block.type === 'text') textParts.push(String(block.text ?? ''));
                    else if (block.type === 'tool_use') {
                        toolUses.push({ name: String(block.name), id: String(block.id), args: (block.input as Record<string, unknown>) ?? {} });
                    } else if (block.type === 'tool_result') {
                        toolResults.push({ tool_use_id: String(block.tool_use_id), content: block.content, is_error: Boolean(block.is_error) });
                    }
                    // skip thinking blocks
                }

                // Attach tool results to their owning assistant messages
                for (const tr of toolResults) {
                    const ownerMsg = pendingTools.get(tr.tool_use_id);
                    if (ownerMsg?.tools) {
                        const tool = ownerMsg.tools.find(t => t.id === tr.tool_use_id);
                        if (tool) {
                            tool.result = toolResultText(tr.content);
                            tool.isError = tr.is_error;
                        }
                    }
                    pendingTools.delete(tr.tool_use_id);
                }

                const text = textParts.join('\n').trim();

                // Only emit a message if there's text or tool_use blocks
                if (!text && !toolUses.length) continue;

                const serialized: SerializedMsg = { role, text, timestamp: ts };
                if (toolUses.length) {
                    serialized.tools = toolUses.map(tu => ({ name: tu.name, id: tu.id, args: tu.args }));
                    for (const tu of toolUses) pendingTools.set(tu.id, serialized);
                }
                messages.push(serialized);
            } catch { /* skip malformed lines */ }
        }

        if (!messages.length) return;
        historyStore.set(cwd, messages);
        const PAGE = 50;
        const page = messages.slice(-PAGE);
        mainWindow?.webContents.send('relay-message', {
            type: 'conversation_loaded',
            messages: page,
            historyTotal: messages.length,
            historyOffset: messages.length - page.length,
            historyCwd: cwd,
        });
    } catch { /* silently ignore — feature is best-effort */ }
}

const historyStore = new Map<string, SerializedMsg[]>();

function setupRelay(): void {
    wsClient = new WSClient(config.relayUrl, config.authToken, {
        onMessage: (msg) => {
            const m = msg as unknown as Record<string, unknown>;
            if (m.type === 'models_list') {
                const relayMods = (m.models as ORModel[] | undefined) ?? [];
                lastRelayModelsReceived = relayMods.slice(0, 3).map(mm => mm.id);
                const { models, current_model } = mergeModelsForUI(relayMods);
                mainWindow?.webContents.send('relay-message', { ...m, models, current_model });
            } else if (m.type === 'local_models_list') {
                // Merge bridge's llama.cpp catalog with our Ollama models
                const bridgeModels = (m.models as unknown[]) ?? [];
                const ollamaList = lastOllamaLocalList;
                const merged = [...ollamaList, ...bridgeModels];
                mainWindow?.webContents.send('relay-message', { ...m, models: merged });
            } else {
                mainWindow?.webContents.send('relay-message', msg);
            }
        },
        onStatusChange: (status) => {
            mainWindow?.webContents.send('connection-status', status);
        },
    });
    wsClient.connect();
}

app.whenReady().then(() => {
    // IPC handlers — must be registered after app is ready
    ipcMain.handle('history-load-more', (_e, cwd: string, offset: number) => {
        const all = historyStore.get(cwd);
        if (!all || offset <= 0) return null;
        const PAGE = 50;
        const start = Math.max(0, offset - PAGE);
        return { messages: all.slice(start, offset), newOffset: start, historyTotal: all.length, historyCwd: cwd };
    });
    ipcMain.handle('get-config', () => config);
    ipcMain.handle('save-config', (_e, updates: Partial<typeof DEFAULT_CONFIG>) => {
        config = { ...config, ...updates };
        saveConfig(config);
        return config;
    });
    ipcMain.handle('get-platform', () => process.platform);
    ipcMain.handle('get-home', () => os.homedir());
    ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url));
    ipcMain.handle('get-pending-findings', () => scheduler?.getPendingFindings() ?? []);
    ipcMain.handle('clear-finding', (_e, id: string) => scheduler?.clearFinding(id));
    ipcMain.handle('run-task-now', (_e, name: string) => scheduler?.runNow(name));
    ipcMain.handle('get-tasks', () => scheduler?.getTasks() ?? []);
    ipcMain.on('relay-send', (_e, rawMsg: unknown) => {
        const msg = rawMsg as Record<string, unknown>;
        const type = msg.type as string;

        if (type === 'set_model') {
            currentModel = (msg.model as string) || '';
            if (isORModel(currentModel) || isOllamaModel(currentModel)) return;
        }

        if (type === 'get_local_models') {
            pollOllamaModels();
            return;
        }

        if (type === 'set_model_favorites') {
            config.favoriteModels = (msg.favorites as string[]) || [];
            saveConfig(config);
            return;
        }

        if (type === 'set_default_model') {
            config.defaultModel = (msg.model as string) || '';
            saveConfig(config);
            return;
        }

        if (type === 'abort_query' && isORModel(currentModel)) {
            orAbort?.abort();
            orAbort = null;
            return;
        }

        if (type === 'query' && isORModel(currentModel)) {
            handleORQuery(msg, currentModel).catch(err =>
                mainWindow?.webContents.send('relay-message', { type: 'error', message: String(err) })
            );
            return;
        }

        if (type === 'abort_query' && isOllamaModel(currentModel)) {
            ollamaAbort?.abort();
            ollamaAbort = null;
            return;
        }

        if (type === 'query' && isOllamaModel(currentModel)) {
            const modelName = currentModel.slice('ollama:'.length);
            handleOllamaQuery(msg, modelName).catch(err =>
                mainWindow?.webContents.send('relay-message', { type: 'error', message: String(err) })
            );
            return;
        }

        wsClient?.send(msg as any);
    });
    ipcMain.on('relay-send-raw', (_e, rawMsg: unknown) => {
        const m = rawMsg as Record<string, unknown>;
        if (m.type === 'set_cwd') {
            const cwd = m.cwd as string;
            if (cwd) loadClaudeCodeHistory(cwd);
        }
        wsClient?.sendRaw(m as Record<string, unknown>);
    });

    // Conversation history (persisted to ~/.jac/conversations/)
    const CONV_DIR = path.join(os.homedir(), '.jac', 'conversations');
    const CONV_INDEX = path.join(CONV_DIR, 'index.json');
    const MAX_PER_WORKSPACE = 50;

    function convReadIndex(): unknown[] {
        try { return JSON.parse(fs.readFileSync(CONV_INDEX, 'utf-8')); } catch { return []; }
    }
    function convWriteIndex(idx: unknown[]): void {
        fs.mkdirSync(CONV_DIR, { recursive: true });
        fs.writeFileSync(CONV_INDEX, JSON.stringify(idx));
    }

    ipcMain.handle('conv-save', (_e, messages: unknown[], meta: Record<string, unknown>, workspace: string) => {
        if (!messages || !messages.length) return;
        const id: string = (meta.id as string) || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        fs.mkdirSync(CONV_DIR, { recursive: true });
        fs.writeFileSync(path.join(CONV_DIR, `${id}.json`), JSON.stringify(messages));

        let idx = convReadIndex() as Array<Record<string, unknown>>;
        idx = idx.filter(c => c.id !== id);
        idx.unshift({ ...meta, id, workspace, timestamp: Date.now() });

        // Keep MAX_PER_WORKSPACE per folder, prune old
        const ws = idx.filter(c => c.workspace === workspace);
        if (ws.length > MAX_PER_WORKSPACE) {
            ws.slice(MAX_PER_WORKSPACE).forEach(old => {
                try { fs.unlinkSync(path.join(CONV_DIR, `${old.id}.json`)); } catch {}
            });
        }
        idx = idx.filter(c => c.workspace !== workspace || ws.indexOf(c) < MAX_PER_WORKSPACE);
        convWriteIndex(idx);
        return id;
    });

    ipcMain.handle('conv-load-index', () => convReadIndex());

    ipcMain.handle('conv-load', (_e, id: string) => {
        try { return JSON.parse(fs.readFileSync(path.join(CONV_DIR, `${id}.json`), 'utf-8')); } catch { return null; }
    });

    ipcMain.handle('conv-delete', (_e, id: string) => {
        try { fs.unlinkSync(path.join(CONV_DIR, `${id}.json`)); } catch {}
        convWriteIndex((convReadIndex() as Array<Record<string, unknown>>).filter(c => c.id !== id));
    });

    // Filesystem IPC for sidebar
    ipcMain.handle('fs-list-dir', (_e, dirPath: string) => {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
                .filter(e => !e.name.startsWith('.'))
                .map(e => ({
                    name: e.name,
                    path: path.join(dirPath, e.name),
                    isDir: e.isDirectory(),
                }))
                .sort((a, b) => {
                    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
        } catch { return []; }
    });
    ipcMain.handle('fs-open-in-finder', (_e, dirPath: string) => shell.openPath(dirPath));
    ipcMain.handle('dialog-open-folder', async () => {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
    });

    const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
    const MUSIC_STATE_PATH = path.join(os.homedir(), '.jac', 'music-state.json');

    function scanDir(dir: string, results: Array<{ path: string; name: string; dir: string }> = []) {
        try {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                if (ent.name.startsWith('.')) continue;
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) { scanDir(full, results); }
                else if (AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) {
                    results.push({ path: full, name: ent.name, dir });
                }
            }
        } catch { /* skip unreadable dirs */ }
        return results;
    }

    ipcMain.handle('music-scan', (_e, dirPath: string) => scanDir(dirPath));
    ipcMain.handle('music-read-file', (_e, filePath: string) => {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().slice(1);
        const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'flac' ? 'audio/flac'
            : ext === 'wav' ? 'audio/wav' : ext === 'm4a' ? 'audio/mp4'
            : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
        return `data:${mime};base64,${data.toString('base64')}`;
    });
    ipcMain.handle('music-save-state', (_e, state: unknown) => {
        fs.writeFileSync(MUSIC_STATE_PATH, JSON.stringify(state));
    });
    ipcMain.handle('music-load-state', () => {
        try { return JSON.parse(fs.readFileSync(MUSIC_STATE_PATH, 'utf8')); }
        catch { return null; }
    });

    mainWindow = createWindow();

    // Start Ollama model polling (no-op if Ollama isn't running)
    pollOllamaModels();

    // Fetch OR models; push to webview once both fetch and page load are done
    if (config.openrouterApiKey) {
        // On every load (incl. hot reload) push OR models with a small delay
        // so main.js message handlers are registered before we fire
        mainWindow.webContents.on('did-finish-load', () => {
            const prefs = { type: 'model_prefs', favorites: config.favoriteModels || [], default: config.defaultModel || '' };
            setTimeout(() => mainWindow?.webContents.send('relay-message', prefs), 200);
            setTimeout(pushModelsToUI, 300);
        });
    } else {
        mainWindow.webContents.on('did-finish-load', () => {
            const prefs = { type: 'model_prefs', favorites: config.favoriteModels || [], default: config.defaultModel || '' };
            setTimeout(() => mainWindow?.webContents.send('relay-message', prefs), 200);
            if (ollamaModels.length > 0) setTimeout(pushModelsToUI, 300);
        });
    }

    if (config.openrouterApiKey) {
        fetchORModels(config.openrouterApiKey).then(models => {
            orModels = models;
            // Push after a tick — page is almost certainly loaded by now
            setTimeout(pushModelsToUI, 300);
        }).catch(() => { /* OR unavailable */ });
    }

    if (!app.isPackaged) {
        // Hot reload — watch dist/renderer and reload window when webpack writes
        const rendererDir = path.join(__dirname, '../renderer');
        let reloadTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleReload = () => {
            if (reloadTimer) clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => mainWindow?.webContents.reloadIgnoringCache(), 200);
        };
        try {
            fs.watch(rendererDir, { recursive: true }, scheduleReload);
        } catch {
            fs.watch(rendererDir, scheduleReload);
        }

        // Dev capture server — curl http://localhost:7654/capture → PNG of the JAC window
        //                      curl http://localhost:7654/debug  → JSON state dump
        http.createServer(async (req, res) => {
            if (req.url === '/inject-or') {
                // Push the real OR model list to the webview
                pushModelsToUI();
                res.writeHead(200); res.end('dispatched');
                return;
            }
            if (req.url === '/eval') {
                // POST body = JS to eval
                let body = '';
                req.on('data', d => body += d);
                req.on('end', async () => {
                    try {
                        const result = await mainWindow?.webContents.executeJavaScript(body);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ result }));
                    } catch (e) { res.writeHead(500); res.end(String(e)); }
                });
                return;
            }
            if (req.url === '/webview-state') {
                try {
                    const state = await mainWindow?.webContents.executeJavaScript(`
                        JSON.stringify({
                            modelBtn: document.getElementById('model-btn')?.textContent,
                            sessionDropdown: document.getElementById('session-dropdown')?.textContent,
                            appHtml: document.getElementById('app')?.innerHTML?.slice(0,200),
                            relayMsgCount: window.__relayMsgCount,
                            lastRelayMsgType: window.__lastRelayMsg?.type,
                            lastRelayMsgModelsLen: window.__lastRelayMsg?.models?.length,
                            lastRelayMsgCurrent: window.__lastRelayMsg?.current_model,
                            handlerCount: window.__messageHandlerCount?.(),
                        })
                    `);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(state || '{}');
                } catch (e) {
                    res.writeHead(500); res.end(String(e));
                }
                return;
            }
            if (req.url === '/debug') {
                const state = {
                    orModelsCount: orModels.length,
                    orModelsFirst3: orModels.slice(0, 3).map(m => m.id),
                    currentModel,
                    hasKey: !!config.openrouterApiKey,
                    keyPrefix: config.openrouterApiKey.slice(0, 12),
                    pushCount,
                    lastRelayModelsSent,
                    lastRelayModelsReceived,
                };
                const body = JSON.stringify(state, null, 2);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(body);
                return;
            }
            if (!mainWindow) { res.writeHead(503); res.end('no window'); return; }
            const img = await mainWindow.webContents.capturePage();
            const png = img.toPNG();
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
            res.end(png);
        }).on('error', () => { /* port already in use — skip capture server */ }).listen(7654);
    }

    scheduler = new AgentScheduler(
        path.join(os.homedir(), '.jac', 'research_tasks.yaml'),
        path.join(os.homedir(), '.jac', 'findings'),
    );
    scheduler.start();

    createTray();
    setupRelay();

    app.on('activate', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });
});

// ── Workflow window ───────────────────────────────────────────────────────────
let workflowWindow: BrowserWindowType | null = null;

ipcMain.handle('open-workflow', () => {
    if (workflowWindow && !workflowWindow.isDestroyed()) {
        workflowWindow.focus();
        return;
    }
    workflowWindow = new BrowserWindow({
        width: 1400, height: 900,
        minWidth: 800, minHeight: 600,
        title: 'JAC Workflow',
        backgroundColor: '#0d0d0f',
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    workflowWindow.loadFile(path.join(__dirname, '../renderer/workflow.html'));
    workflowWindow.on('closed', () => { workflowWindow = null; });
});

// Workflow storage
const WORKFLOW_DIR = path.join(os.homedir(), '.jac', 'workflows');

ipcMain.handle('workflow-save', (_e, name: string, data: string) => {
    fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKFLOW_DIR, `${name}.json`), data, 'utf-8');
});

ipcMain.handle('workflow-load', (_e, name: string) => {
    try { return fs.readFileSync(path.join(WORKFLOW_DIR, `${name}.json`), 'utf-8'); } catch { return null; }
});

ipcMain.handle('workflow-list', () => {
    try {
        return fs.readdirSync(WORKFLOW_DIR).filter((f: string) => f.endsWith('.json')).map((f: string) => f.replace('.json', ''));
    } catch { return []; }
});

ipcMain.handle('ollama-start', async () => {
    // Search common install paths on macOS/Linux before falling back to PATH
    const candidates = [
        '/usr/local/bin/ollama',
        '/opt/homebrew/bin/ollama',
        '/usr/bin/ollama',
        'ollama',
    ];
    const bin = candidates.find(c => {
        try { fs.accessSync(c, fs.constants.X_OK); return true; } catch { return false; }
    }) ?? 'ollama';

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        try {
            const child = spawn(bin, ['serve'], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env },
            });
            child.unref();
            child.on('error', (err) => resolve({ ok: false, error: err.message }));
            // Give it 500ms to fail on exec error; if no error, assume it launched
            setTimeout(() => resolve({ ok: true }), 500);
        } catch (err: any) {
            resolve({ ok: false, error: err.message });
        }
    });
});

app.on('before-quit', () => {
    mainWindow?.removeAllListeners('close');
    scheduler?.stop();
    wsClient?.disconnect();
});

app.on('window-all-closed', () => {
    // Don't quit on macOS — live in tray
    if (process.platform !== 'darwin') { app.quit(); }
});
