"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const wsClient_1 = require("./wsClient");
const agentScheduler_1 = require("./agentScheduler");
const orClient_1 = require("./orClient");
const CONFIG_PATH = path.join(os.homedir(), '.jac', 'config.json');
const DEFAULT_CONFIG = {
    relayUrl: 'wss://mellow-backend.onrender.com',
    authToken: '',
    preferredMachineId: 'Mac.attlocal.net',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openAtLogin: false,
    windowBounds: { width: 1000, height: 700 },
    favoriteModels: [],
    defaultModel: '',
};
function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
    catch {
        return { ...DEFAULT_CONFIG };
    }
}
function saveConfig(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let mainWindow = null;
let tray = null;
let wsClient = null;
let scheduler = null;
let config = loadConfig();
// OR state
let orModels = [];
let currentModel = ''; // tracks selected model across set_model messages
let orAbort = null;
const CLAUDE_FALLBACK_IDS = new Set(['sonnet', 'opus', 'haiku']);
function isORModel(id) { return id.startsWith('or:'); }
// Ollama state
let ollamaModels = [];
let ollamaAbort = null;
let ollamaPollTimer = null;
let lastOllamaLocalList = [];
function isOllamaModel(id) { return id.startsWith('ollama:'); }
function fmtBytes(b) {
    if (b >= 1e9)
        return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6)
        return (b / 1e6).toFixed(0) + ' MB';
    return b + ' B';
}
async function pollOllamaModels() {
    if (ollamaPollTimer)
        clearTimeout(ollamaPollTimer);
    try {
        const [tagsRes, psRes] = await Promise.all([
            fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) }),
            fetch('http://localhost:11434/api/ps', { signal: AbortSignal.timeout(2000) }),
        ]);
        if (tagsRes.ok) {
            const tags = await tagsRes.json();
            const ps = psRes.ok ? await psRes.json() : { models: [] };
            const hotNames = new Set((ps.models || []).map((m) => m.name));
            const prev = ollamaModels.map(m => m.id).join(',');
            ollamaModels = []; // cleared — Ollama models go to LOCAL tab only
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
    }
    catch { /* Ollama not running */ }
    ollamaPollTimer = setTimeout(pollOllamaModels, 10000);
}
async function handleOllamaQuery(msg, modelName) {
    ollamaAbort?.abort();
    ollamaAbort = new AbortController();
    const prompt = msg.prompt;
    const rawHistory = msg.history || [];
    const messages = [
        ...rawHistory.map(h => ({ role: h.role, content: h.text })),
        { role: 'user', content: prompt },
    ];
    const send = (delta) => mainWindow?.webContents.send('relay-message', delta);
    try {
        const res = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName, messages, stream: true }),
            signal: ollamaAbort.signal,
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        send({ type: 'stream_start' });
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const obj = JSON.parse(line);
                    if (obj.message?.content)
                        send({ type: 'stream_chunk', text: obj.message.content });
                    if (obj.done)
                        send({ type: 'stream_end' });
                }
                catch { /* skip malformed */ }
            }
        }
    }
    catch (err) {
        if (err.name !== 'AbortError')
            send({ type: 'error', message: String(err.message) });
    }
    ollamaAbort = null;
}
function mergeModelsForUI(relayModels) {
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
let lastRelayModelsSent = [];
let lastRelayModelsReceived = [];
function pushModelsToUI() {
    const { models, current_model } = mergeModelsForUI([]);
    if (models.length === 0)
        return;
    pushCount++;
    lastRelayModelsSent = models.slice(0, 3).map(m => m.id);
    mainWindow?.webContents.send('relay-message', { type: 'models_list', models, current_model });
}
async function handleORQuery(msg, modelId) {
    orAbort?.abort();
    orAbort = new AbortController();
    const prompt = msg.prompt;
    const rawHistory = msg.history || [];
    const messages = [
        ...rawHistory.map(h => ({ role: h.role, content: h.text })),
        { role: 'user', content: prompt },
    ];
    await (0, orClient_1.queryOR)(config.openrouterApiKey, modelId, messages, (delta) => mainWindow?.webContents.send('relay-message', delta), orAbort.signal);
    orAbort = null;
}
function createWindow() {
    const win = new electron_1.BrowserWindow({
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
function createTray() {
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    const icon = fs.existsSync(iconPath)
        ? electron_1.nativeImage.createFromPath(iconPath)
        : electron_1.nativeImage.createEmpty();
    tray = new electron_1.Tray(icon);
    tray.setToolTip('JAC');
    const updateMenu = () => {
        const pendingFindings = scheduler?.getPendingFindings() ?? [];
        const menu = electron_1.Menu.buildFromTemplate([
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
                { type: 'separator' },
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
                click: () => { electron_1.app.quit(); },
            },
        ]);
        tray.setContextMenu(menu);
    };
    tray.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });
    updateMenu();
    scheduler?.on('taskComplete', updateMenu);
    scheduler?.on('taskComplete', (finding) => {
        new electron_1.Notification({
            title: `JAC: ${finding.taskName}`,
            body: finding.summary.substring(0, 120),
        }).show();
    });
}
function toolResultText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map(c => c.type === 'text' ? String(c.text) : c.type === 'image' ? '[image]' : '')
            .filter(Boolean).join('\n');
    }
    return String(content ?? '');
}
function loadClaudeCodeHistory(cwd) {
    try {
        const encoded = cwd.replace(/[\/ ]/g, '-');
        const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
        if (!fs.existsSync(projectDir))
            return;
        const files = fs.readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => ({ f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        if (!files.length)
            return;
        const jsonlPath = path.join(projectDir, files[0].f);
        const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
        const messages = [];
        // Maps tool_use_id → the assistant SerializedMsg that owns it
        const pendingTools = new Map();
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj.type !== 'user' && obj.type !== 'assistant')
                    continue;
                const msg = obj.message;
                if (!msg)
                    continue;
                const role = msg.role;
                const content = msg.content;
                const ts = new Date(obj.timestamp).getTime() || Date.now();
                const blocks = typeof content === 'string'
                    ? [{ type: 'text', text: content }]
                    : (Array.isArray(content) ? content : []);
                const textParts = [];
                const toolUses = [];
                const toolResults = [];
                for (const block of blocks) {
                    if (block.type === 'text')
                        textParts.push(String(block.text ?? ''));
                    else if (block.type === 'tool_use') {
                        toolUses.push({ name: String(block.name), id: String(block.id), args: block.input ?? {} });
                    }
                    else if (block.type === 'tool_result') {
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
                if (!text && !toolUses.length)
                    continue;
                const serialized = { role, text, timestamp: ts };
                if (toolUses.length) {
                    serialized.tools = toolUses.map(tu => ({ name: tu.name, id: tu.id, args: tu.args }));
                    for (const tu of toolUses)
                        pendingTools.set(tu.id, serialized);
                }
                messages.push(serialized);
            }
            catch { /* skip malformed lines */ }
        }
        if (!messages.length)
            return;
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
    }
    catch { /* silently ignore — feature is best-effort */ }
}
const historyStore = new Map();
function setupRelay() {
    wsClient = new wsClient_1.WSClient(config.relayUrl, config.authToken, {
        onMessage: (msg) => {
            const m = msg;
            if (m.type === 'models_list') {
                const relayMods = m.models ?? [];
                lastRelayModelsReceived = relayMods.slice(0, 3).map(mm => mm.id);
                const { models, current_model } = mergeModelsForUI(relayMods);
                mainWindow?.webContents.send('relay-message', { ...m, models, current_model });
            }
            else if (m.type === 'local_models_list') {
                // Merge bridge's llama.cpp catalog with our Ollama models
                const bridgeModels = m.models ?? [];
                const ollamaList = lastOllamaLocalList;
                const merged = [...ollamaList, ...bridgeModels];
                mainWindow?.webContents.send('relay-message', { ...m, models: merged });
            }
            else {
                mainWindow?.webContents.send('relay-message', msg);
            }
        },
        onStatusChange: (status) => {
            mainWindow?.webContents.send('connection-status', status);
        },
    });
    wsClient.connect();
}
electron_1.app.whenReady().then(() => {
    // IPC handlers — must be registered after app is ready
    electron_1.ipcMain.handle('history-load-more', (_e, cwd, offset) => {
        const all = historyStore.get(cwd);
        if (!all || offset <= 0)
            return null;
        const PAGE = 50;
        const start = Math.max(0, offset - PAGE);
        return { messages: all.slice(start, offset), newOffset: start, historyTotal: all.length, historyCwd: cwd };
    });
    electron_1.ipcMain.handle('get-config', () => config);
    electron_1.ipcMain.handle('save-config', (_e, updates) => {
        config = { ...config, ...updates };
        saveConfig(config);
        return config;
    });
    electron_1.ipcMain.handle('get-platform', () => process.platform);
    electron_1.ipcMain.handle('get-home', () => os.homedir());
    electron_1.ipcMain.handle('open-external', (_e, url) => electron_1.shell.openExternal(url));
    electron_1.ipcMain.handle('get-pending-findings', () => scheduler?.getPendingFindings() ?? []);
    electron_1.ipcMain.handle('clear-finding', (_e, id) => scheduler?.clearFinding(id));
    electron_1.ipcMain.handle('run-task-now', (_e, name) => scheduler?.runNow(name));
    electron_1.ipcMain.handle('get-tasks', () => scheduler?.getTasks() ?? []);
    electron_1.ipcMain.on('relay-send', (_e, rawMsg) => {
        const msg = rawMsg;
        const type = msg.type;
        if (type === 'set_model') {
            currentModel = msg.model || '';
            if (isORModel(currentModel) || isOllamaModel(currentModel))
                return;
        }
        if (type === 'get_local_models') {
            pollOllamaModels();
            return;
        }
        if (type === 'set_model_favorites') {
            config.favoriteModels = msg.favorites || [];
            saveConfig(config);
            return;
        }
        if (type === 'set_default_model') {
            config.defaultModel = msg.model || '';
            saveConfig(config);
            return;
        }
        if (type === 'abort_query' && isORModel(currentModel)) {
            orAbort?.abort();
            orAbort = null;
            return;
        }
        if (type === 'query' && isORModel(currentModel)) {
            handleORQuery(msg, currentModel).catch(err => mainWindow?.webContents.send('relay-message', { type: 'error', message: String(err) }));
            return;
        }
        if (type === 'abort_query' && isOllamaModel(currentModel)) {
            ollamaAbort?.abort();
            ollamaAbort = null;
            return;
        }
        if (type === 'query' && isOllamaModel(currentModel)) {
            const modelName = currentModel.slice('ollama:'.length);
            handleOllamaQuery(msg, modelName).catch(err => mainWindow?.webContents.send('relay-message', { type: 'error', message: String(err) }));
            return;
        }
        wsClient?.send(msg);
    });
    electron_1.ipcMain.on('relay-send-raw', (_e, rawMsg) => {
        const m = rawMsg;
        if (m.type === 'set_cwd') {
            const cwd = m.cwd;
            if (cwd)
                loadClaudeCodeHistory(cwd);
        }
        wsClient?.sendRaw(m);
    });
    // Conversation history (persisted to ~/.jac/conversations/)
    const CONV_DIR = path.join(os.homedir(), '.jac', 'conversations');
    const CONV_INDEX = path.join(CONV_DIR, 'index.json');
    const MAX_PER_WORKSPACE = 50;
    function convReadIndex() {
        try {
            return JSON.parse(fs.readFileSync(CONV_INDEX, 'utf-8'));
        }
        catch {
            return [];
        }
    }
    function convWriteIndex(idx) {
        fs.mkdirSync(CONV_DIR, { recursive: true });
        fs.writeFileSync(CONV_INDEX, JSON.stringify(idx));
    }
    electron_1.ipcMain.handle('conv-save', (_e, messages, meta, workspace) => {
        if (!messages || !messages.length)
            return;
        const id = meta.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        fs.mkdirSync(CONV_DIR, { recursive: true });
        fs.writeFileSync(path.join(CONV_DIR, `${id}.json`), JSON.stringify(messages));
        let idx = convReadIndex();
        idx = idx.filter(c => c.id !== id);
        idx.unshift({ ...meta, id, workspace, timestamp: Date.now() });
        // Keep MAX_PER_WORKSPACE per folder, prune old
        const ws = idx.filter(c => c.workspace === workspace);
        if (ws.length > MAX_PER_WORKSPACE) {
            ws.slice(MAX_PER_WORKSPACE).forEach(old => {
                try {
                    fs.unlinkSync(path.join(CONV_DIR, `${old.id}.json`));
                }
                catch { }
            });
        }
        idx = idx.filter(c => c.workspace !== workspace || ws.indexOf(c) < MAX_PER_WORKSPACE);
        convWriteIndex(idx);
        return id;
    });
    electron_1.ipcMain.handle('conv-load-index', () => convReadIndex());
    electron_1.ipcMain.handle('conv-load', (_e, id) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(CONV_DIR, `${id}.json`), 'utf-8'));
        }
        catch {
            return null;
        }
    });
    electron_1.ipcMain.handle('conv-delete', (_e, id) => {
        try {
            fs.unlinkSync(path.join(CONV_DIR, `${id}.json`));
        }
        catch { }
        convWriteIndex(convReadIndex().filter(c => c.id !== id));
    });
    // Filesystem IPC for sidebar
    electron_1.ipcMain.handle('fs-list-dir', (_e, dirPath) => {
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
                if (a.isDir !== b.isDir)
                    return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
        }
        catch {
            return [];
        }
    });
    electron_1.ipcMain.handle('fs-open-in-finder', (_e, dirPath) => electron_1.shell.openPath(dirPath));
    electron_1.ipcMain.handle('dialog-open-folder', async () => {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
    });
    const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
    const MUSIC_STATE_PATH = path.join(os.homedir(), '.jac', 'music-state.json');
    function scanDir(dir, results = []) {
        try {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                if (ent.name.startsWith('.'))
                    continue;
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    scanDir(full, results);
                }
                else if (AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) {
                    results.push({ path: full, name: ent.name, dir });
                }
            }
        }
        catch { /* skip unreadable dirs */ }
        return results;
    }
    electron_1.ipcMain.handle('music-scan', (_e, dirPath) => scanDir(dirPath));
    electron_1.ipcMain.handle('music-read-file', (_e, filePath) => {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().slice(1);
        const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'flac' ? 'audio/flac'
            : ext === 'wav' ? 'audio/wav' : ext === 'm4a' ? 'audio/mp4'
                : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
        return `data:${mime};base64,${data.toString('base64')}`;
    });
    electron_1.ipcMain.handle('music-save-state', (_e, state) => {
        fs.writeFileSync(MUSIC_STATE_PATH, JSON.stringify(state));
    });
    electron_1.ipcMain.handle('music-load-state', () => {
        try {
            return JSON.parse(fs.readFileSync(MUSIC_STATE_PATH, 'utf8'));
        }
        catch {
            return null;
        }
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
    }
    else {
        mainWindow.webContents.on('did-finish-load', () => {
            const prefs = { type: 'model_prefs', favorites: config.favoriteModels || [], default: config.defaultModel || '' };
            setTimeout(() => mainWindow?.webContents.send('relay-message', prefs), 200);
            if (ollamaModels.length > 0)
                setTimeout(pushModelsToUI, 300);
        });
    }
    if (config.openrouterApiKey) {
        (0, orClient_1.fetchORModels)(config.openrouterApiKey).then(models => {
            orModels = models;
            // Push after a tick — page is almost certainly loaded by now
            setTimeout(pushModelsToUI, 300);
        }).catch(() => { });
    }
    if (!electron_1.app.isPackaged) {
        // Hot reload — watch dist/renderer and reload window when webpack writes
        const rendererDir = path.join(__dirname, '../renderer');
        let reloadTimer = null;
        const scheduleReload = () => {
            if (reloadTimer)
                clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => mainWindow?.webContents.reloadIgnoringCache(), 200);
        };
        try {
            fs.watch(rendererDir, { recursive: true }, scheduleReload);
        }
        catch {
            fs.watch(rendererDir, scheduleReload);
        }
        // Dev capture server — curl http://localhost:7654/capture → PNG of the JAC window
        //                      curl http://localhost:7654/debug  → JSON state dump
        http.createServer(async (req, res) => {
            if (req.url === '/inject-or') {
                // Push the real OR model list to the webview
                pushModelsToUI();
                res.writeHead(200);
                res.end('dispatched');
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
                    }
                    catch (e) {
                        res.writeHead(500);
                        res.end(String(e));
                    }
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
                }
                catch (e) {
                    res.writeHead(500);
                    res.end(String(e));
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
            if (!mainWindow) {
                res.writeHead(503);
                res.end('no window');
                return;
            }
            const img = await mainWindow.webContents.capturePage();
            const png = img.toPNG();
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
            res.end(png);
        }).on('error', () => { }).listen(7654);
    }
    scheduler = new agentScheduler_1.AgentScheduler(path.join(os.homedir(), '.jac', 'research_tasks.yaml'), path.join(os.homedir(), '.jac', 'findings'));
    scheduler.start();
    createTray();
    setupRelay();
    electron_1.app.on('activate', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });
});
// ── Workflow window ───────────────────────────────────────────────────────────
let workflowWindow = null;
electron_1.ipcMain.handle('open-workflow', () => {
    if (workflowWindow && !workflowWindow.isDestroyed()) {
        workflowWindow.focus();
        return;
    }
    workflowWindow = new electron_1.BrowserWindow({
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
electron_1.ipcMain.handle('workflow-save', (_e, name, data) => {
    fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKFLOW_DIR, `${name}.json`), data, 'utf-8');
});
electron_1.ipcMain.handle('workflow-load', (_e, name) => {
    try {
        return fs.readFileSync(path.join(WORKFLOW_DIR, `${name}.json`), 'utf-8');
    }
    catch {
        return null;
    }
});
electron_1.ipcMain.handle('workflow-list', () => {
    try {
        return fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    }
    catch {
        return [];
    }
});
electron_1.ipcMain.handle('ollama-start', async () => {
    // Search common install paths on macOS/Linux before falling back to PATH
    const candidates = [
        '/usr/local/bin/ollama',
        '/opt/homebrew/bin/ollama',
        '/usr/bin/ollama',
        'ollama',
    ];
    const bin = candidates.find(c => {
        try {
            fs.accessSync(c, fs.constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    }) ?? 'ollama';
    return new Promise((resolve) => {
        try {
            const child = (0, child_process_1.spawn)(bin, ['serve'], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env },
            });
            child.unref();
            child.on('error', (err) => resolve({ ok: false, error: err.message }));
            // Give it 500ms to fail on exec error; if no error, assume it launched
            setTimeout(() => resolve({ ok: true }), 500);
        }
        catch (err) {
            resolve({ ok: false, error: err.message });
        }
    });
});
electron_1.app.on('before-quit', () => {
    mainWindow?.removeAllListeners('close');
    scheduler?.stop();
    wsClient?.disconnect();
});
electron_1.app.on('window-all-closed', () => {
    // Don't quit on macOS — live in tray
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
//# sourceMappingURL=main.js.map