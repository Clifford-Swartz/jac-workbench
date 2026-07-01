import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, Notification } from 'electron';
import type { BrowserWindow as BrowserWindowType, Tray as TrayType } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import { spawn } from 'child_process';
import { autoUpdater } from 'electron-updater';
import { WSClient } from './wsClient';
import { AgentScheduler } from './agentScheduler';
import { fetchORModels, queryOR, ORModel } from './orClient';
import { McpManager, McpServerConfig, McpTool } from './mcp/manager';
import { runAgenticQuery } from './agent/loop';

const CONFIG_PATH = path.join(os.homedir(), '.jac', 'config.json');
const DEFAULT_CONFIG = {
    relayUrl: 'wss://mellow-backend.onrender.com',
    authToken: '',            // relay disabled — no shared secret shipped
    useRelay: false,          // local + OpenRouter only; no relay / Claude-bridge dependency
    preferredMachineId: '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openAtLogin: false,
    windowBounds: { width: 1000, height: 700 },
    favoriteModels: [] as string[],
    defaultModel: '',
    lastModel: '',   // last-selected model, restored on restart so OR/local routing survives
    localModelPath: '',  // GGUF the bundled jac-llm-server auto-serves (empty = none/auto-detect)
    // MCP: external tool servers, same shape as Claude Desktop. stdio: {command,args,env}; sse: {url}
    mcpServers: {} as Record<string, McpServerConfig>,
    // per-tool permission: 'mcp__<server>__<tool>' -> 'allow' | 'ask' | 'deny' (missing = 'ask')
    mcpToolPermissions: {} as Record<string, 'allow' | 'ask' | 'deny'>,
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
const mcpManager = new McpManager((m) => console.log(m));

// Pending MCP tool-permission prompts, keyed by request_id (resolved by 'permission_response').
let permSeq = 0;
const pendingPermissions = new Map<string, (r: { allow: boolean; remember: boolean }) => void>();

// Decide whether a tool may run: saved allow/deny short-circuits; otherwise prompt the UI and wait.
function decidePermission(name: string, args: Record<string, unknown>): Promise<'allow' | 'deny'> {
    const saved = config.mcpToolPermissions[name];
    if (saved === 'allow' || saved === 'deny') return Promise.resolve(saved);
    return new Promise((resolve) => {
        const request_id = `perm_${++permSeq}`;
        pendingPermissions.set(request_id, ({ allow, remember }) => {
            if (remember) { config.mcpToolPermissions[name] = allow ? 'allow' : 'deny'; saveConfig(config); }
            resolve(allow ? 'allow' : 'deny');
        });
        mainWindow?.webContents.send('relay-message', {
            type: 'permission_request',
            request_id,
            tool_name: name,
            tool_input: args,
            allowlist_suggestion: { scope: 'tool', match: name },
        });
    });
}

// JAC-native "meta" tools — always available to the agent alongside MCP tools, so the model can
// manage MCP servers conversationally. Namespaced jac__* and dispatched by callBuiltin (not the MCP manager).
const MCP_BUILTINS: McpTool[] = [
    {
        server: 'jac', name: 'add_mcp_server', qualifiedName: 'jac__add_mcp_server',
        description: 'Add (or update) and connect an MCP tool server in JAC. Runs the given command via stdio. Use for requests like "add the playwright MCP server".',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short unique id, e.g. "playwright"' },
                command: { type: 'string', description: 'Executable to run, e.g. "npx"' },
                args: { type: 'array', items: { type: 'string' }, description: 'Arguments, e.g. ["-y","@playwright/mcp@latest"]' },
                env: { type: 'object', description: 'Optional environment variables', additionalProperties: { type: 'string' } },
            },
            required: ['name', 'command'],
        },
    },
    {
        server: 'jac', name: 'list_mcp_servers', qualifiedName: 'jac__list_mcp_servers',
        description: 'List configured MCP servers with their connection status and tool counts.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'remove_mcp_server', qualifiedName: 'jac__remove_mcp_server',
        description: 'Remove a configured MCP server from JAC by its name.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
];

async function callBuiltin(qualifiedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    try {
        if (qualifiedName === 'jac__add_mcp_server') {
            const name = String(args.name ?? '').trim();
            const command = String(args.command ?? '').trim();
            if (!name || !command) return { text: 'Both "name" and "command" are required.', isError: true };
            const serverArgs = Array.isArray(args.args) ? args.args.map(String) : [];
            const env = (args.env && typeof args.env === 'object') ? args.env as Record<string, string> : undefined;
            config.mcpServers = { ...config.mcpServers, [name]: { command, args: serverArgs, ...(env ? { env } : {}) } };
            saveConfig(config);
            await mcpManager.reload(config.mcpServers);
            await new Promise(r => setTimeout(r, 1800));   // give it a moment to hand-shake
            const st = mcpManager.status().find(s => s.name === name);
            const ok = st?.status === 'ready';
            return {
                text: `Server "${name}" saved. Status: ${st?.status ?? 'unknown'}${st?.error ? ` (${st.error})` : ''}, ${st?.toolCount ?? 0} tools.`,
                isError: !ok,
            };
        }
        if (qualifiedName === 'jac__list_mcp_servers') {
            return { text: JSON.stringify(mcpManager.status()), isError: false };
        }
        if (qualifiedName === 'jac__remove_mcp_server') {
            const name = String(args.name ?? '').trim();
            if (!(name in config.mcpServers)) return { text: `No configured server named "${name}".`, isError: true };
            const next = { ...config.mcpServers }; delete next[name];
            config.mcpServers = next; saveConfig(config);
            await mcpManager.reload(config.mcpServers);
            return { text: `Removed server "${name}".`, isError: false };
        }
        return { text: `Unknown built-in tool: ${qualifiedName}`, isError: true };
    } catch (e) {
        return { text: `Built-in error: ${String((e as Error).message ?? e)}`, isError: true };
    }
}

// OR state
let orModels: ORModel[] = [];
let currentModel = config.lastModel || config.defaultModel || '';   // restored across restarts
let orAbort: AbortController | null = null;
const CLAUDE_FALLBACK_IDS = new Set(['sonnet', 'opus', 'haiku']);

function isORModel(id: string): boolean { return id.startsWith('or:'); }

// Ollama state
let ollamaModels: ORModel[] = [];
let ollamaAbort: AbortController | null = null;
let ollamaPollTimer: ReturnType<typeof setTimeout> | null = null;
let lastOllamaLocalList: unknown[] = [];

function isOllamaModel(id: string): boolean { return id.startsWith('ollama:'); }

// Local jac-llm-server (OpenAI-compatible, :8787) state
const LOCAL_SERVER_URL = 'http://localhost:8787';
let lastLocalServerList: unknown[] = [];
let localSrvAbort: AbortController | null = null;
let localSrvPollTimer: ReturnType<typeof setTimeout> | null = null;
function isLocalServerModel(id: string): boolean { return id.startsWith('local:'); }

// Bundled jac-llm-server process management — auto-start so local models "just work".
let localServerChild: ReturnType<typeof spawn> | null = null;
function localServerDir(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'llama-server')
        : path.join(__dirname, '../../resources/llama-server');
}
function resolveLocalModel(): string {
    if (config.localModelPath && fs.existsSync(config.localModelPath)) return config.localModelPath;
    const dirs = [
        path.join(app.getPath('userData'), 'models'),                    // downloaded (first run)
        app.isPackaged ? path.join(process.resourcesPath, 'models')
                       : path.join(__dirname, '../../resources/models'),  // bundled (if any)
    ];
    for (const dir of dirs) {
        try {
            const g = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith('.gguf'));
            if (g) return path.join(dir, g);
        } catch { /* dir missing */ }
    }
    return '';
}
async function startLocalServer(): Promise<void> {
    // Already serving (e.g. a manually-started instance)? Reuse it.
    try {
        const r = await fetch(`${LOCAL_SERVER_URL}/v1/models`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) return;
    } catch { /* not up — start it */ }
    const exe = path.join(localServerDir(), process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    const model = resolveLocalModel();
    if (!fs.existsSync(exe) || !model) return; // no binary or no model → nothing to start yet
    try {
        localServerChild = spawn(exe,
            ['-m', model, '--port', '8787', '--host', '127.0.0.1', '-ngl', '999', '-c', '4096'],
            { cwd: localServerDir(), windowsHide: true, stdio: 'ignore' });
        localServerChild.on('exit', () => { localServerChild = null; });
    } catch { /* spawn failed */ }
}
function stopLocalServer(): void {
    if (localServerChild) { try { localServerChild.kill(); } catch { /* ignore */ } localServerChild = null; }
}

// Auto-update via electron-updater (GitHub Releases feed). Packaged builds only.
let updateReady = false;
function setupAutoUpdate(): void {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
        updateReady = true;
        try { new Notification({ title: 'JAC update ready', body: `Version ${info.version} downloaded — installs next time you quit JAC.` }).show(); } catch { /* ignore */ }
        mainWindow?.webContents.send('relay-message', { type: 'update_downloaded', version: info.version });
    });
    autoUpdater.on('error', () => { /* offline or no release yet — ignore */ });
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000); // re-check every 6h
}
function checkForUpdatesNow(): void {
    if (!app.isPackaged) { try { new Notification({ title: 'JAC', body: 'Updates only work in the installed app.' }).show(); } catch { /* ignore */ } return; }
    if (updateReady) { autoUpdater.quitAndInstall(); return; }
    autoUpdater.checkForUpdates().catch(() => {});
    try { new Notification({ title: 'JAC', body: 'Checking for updates…' }).show(); } catch { /* ignore */ }
}
function restartLocalServer(): void {
    stopLocalServer();
    setTimeout(() => { startLocalServer(); }, 600); // let :8787 free up
}

// First-run model acquisition (app ships without a model).
const CURATED_MODEL = {
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    filename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    label: 'Llama 3.2 3B Instruct (Q4)',
    sizeGB: 2.0,
};
function modelsDownloadDir(): string {
    const dir = path.join(app.getPath('userData'), 'models');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    return dir;
}
let modelDownloadAbort: AbortController | null = null;
async function downloadCuratedModel(): Promise<{ ok: boolean; path?: string; error?: string }> {
    modelDownloadAbort?.abort();
    modelDownloadAbort = new AbortController();
    const dest = path.join(modelsDownloadDir(), CURATED_MODEL.filename);
    const tmp = dest + '.part';
    const send = (p: Record<string, unknown>) => mainWindow?.webContents.send('model-download-progress', p);
    try {
        const res = await fetch(CURATED_MODEL.url, { signal: modelDownloadAbort.signal });
        if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
        const total = Number(res.headers.get('content-length')) || 0;
        const out = fs.createWriteStream(tmp);
        const reader = res.body.getReader();
        let received = 0, lastPct = -1;
        send({ status: 'start', total, label: CURATED_MODEL.label });
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            out.write(Buffer.from(value));
            received += value.length;
            const pct = total ? Math.floor((received / total) * 100) : 0;
            if (pct !== lastPct) { lastPct = pct; send({ status: 'progress', pct, received, total }); }
        }
        await new Promise<void>(r => out.end(() => r()));
        fs.renameSync(tmp, dest);
        config.localModelPath = dest; saveConfig(config);
        restartLocalServer();
        send({ status: 'done', path: dest });
        return { ok: true, path: dest };
    } catch (err: any) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
        if (err.name === 'AbortError') { send({ status: 'canceled' }); return { ok: false, error: 'canceled' }; }
        send({ status: 'error', error: String(err.message) });
        return { ok: false, error: String(err.message) };
    } finally { modelDownloadAbort = null; }
}

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

            pushLocalModels();
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

// Combined local-tab list = Ollama models + local jac-llm-server models.
function pushLocalModels(): void {
    const models = [...(lastOllamaLocalList as unknown[]), ...(lastLocalServerList as unknown[])];
    mainWindow?.webContents.send('relay-message', { type: 'local_models_list', models });
}

async function pollLocalServerModels(): Promise<void> {
    if (localSrvPollTimer) clearTimeout(localSrvPollTimer);
    try {
        const res = await fetch(`${LOCAL_SERVER_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
            const data = await res.json() as { data?: Array<{ id: string }> };
            lastLocalServerList = (data.data || []).map(m => ({
                id: `local:${m.id}`,
                label: `${String(m.id).replace(/.*[\\/]/, '').replace(/\.gguf$/i, '')} (local)`,
                size: '',
                status: 'ready',
                provider_id: 'local-srv',
            }));
            pushLocalModels();
        }
    } catch { lastLocalServerList = []; }
    localSrvPollTimer = setTimeout(pollLocalServerModels, 10000);
}

async function handleLocalServerQuery(msg: Record<string, unknown>, modelId: string): Promise<void> {
    localSrvAbort?.abort();
    localSrvAbort = new AbortController();
    const prompt = msg.prompt as string;
    const rawHistory = (msg.history as Array<{ role: string; text: string }> | undefined) || [];
    const messages = [
        ...rawHistory.map(h => ({ role: h.role, content: h.text })),
        { role: 'user', content: prompt },
    ];
    const send = (delta: Record<string, unknown>) => mainWindow?.webContents.send('relay-message', delta);
    try {
        const res = await fetch(`${LOCAL_SERVER_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId, messages, stream: true }),
            signal: localSrvAbort.signal,
        });
        if (!res.ok) { send({ type: 'error', message: `Local server ${res.status}: ${await res.text()}` }); localSrvAbort = null; return; }
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
                const t = line.trim();
                if (!t.startsWith('data:')) continue;
                const payload = t.slice(5).trim();
                if (payload === '[DONE]') { send({ type: 'stream_end' }); continue; }
                try {
                    const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
                    const txt = obj.choices?.[0]?.delta?.content;
                    if (txt) send({ type: 'stream_chunk', text: txt });
                } catch { /* skip malformed SSE */ }
            }
        }
        send({ type: 'stream_end' });
    } catch (err: any) {
        if (err.name !== 'AbortError') send({ type: 'error', message: String(err.message) });
    }
    localSrvAbort = null;
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
    const send = (delta: Record<string, unknown>) => mainWindow?.webContents.send('relay-message', delta);

    // Tools = live MCP tools + JAC-native meta-tools (always present). Route tool-capable models
    // through the agentic loop; plain chat otherwise.
    const tools = [...mcpManager.getTools(), ...MCP_BUILTINS];
    const model = orModels.find(m => m.id === modelId);
    if (model?.supportsTools) {
        await runAgenticQuery({
            url: 'https://openrouter.ai/api/v1/chat/completions',
            headers: {
                'Authorization': `Bearer ${config.openrouterApiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://jac.app',
                'X-Title': 'JAC',
            },
            model: modelId.replace(/^or:/, ''),
            messages, tools,
            callTool: (n, a) => (n.startsWith('jac__') ? callBuiltin(n, a) : mcpManager.callTool(n, a)),
            send, signal: orAbort.signal,
            permit: (name, a) => decidePermission(name, a),
        });
    } else {
        await queryOR(config.openrouterApiKey, modelId, messages, send, orAbort.signal);
    }
    orAbort = null;
}

function createWindow(): BrowserWindowType {
    const win = new BrowserWindow({
        width: config.windowBounds.width,
        height: config.windowBounds.height,
        minWidth: 480,
        minHeight: 400,
        title: 'JAC',
        icon: path.join(__dirname, '../../assets/icon.png'),
        backgroundColor: '#1e1e1e',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        titleBarOverlay: { color: '#191919', symbolColor: '#cccccc', height: 32 },
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile(path.join(__dirname, '../renderer/index.html'));

    // TEMP DIAG: forward renderer console to the main log so we can see explorer errors
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        console.log(`[rndr:${level}] ${message} @ ${sourceId}:${line}`);
    });

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
                label: 'Check for Updates…',
                click: () => { checkForUpdatesNow(); },
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
        // Encode cwd the way Claude Code names its project dirs: every path separator
        // (/, \, :) and space → '-'. Works on Windows (C:\a b\c) and Unix (/a/b).
        const encoded = cwd.replace(/[\\/: ]/g, '-');
        const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
        let projectDir = path.join(projectsRoot, encoded);
        if (!fs.existsSync(projectDir)) {
            // drive-letter case differs between sessions (C:\ vs c:\) — match case-insensitively
            try {
                const match = fs.readdirSync(projectsRoot).find(dir => dir.toLowerCase() === encoded.toLowerCase());
                if (match) projectDir = path.join(projectsRoot, match);
            } catch { /* projects dir missing */ }
        }
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
                // The relay emits "No provider connected" whenever there's no bridge online.
                // On a local/OR model nothing is ever routed to a provider, so that error is
                // pure noise — swallow it. Keep it for Claude models, where it's legitimate.
                if (m.type === 'error' && m.message === 'No provider connected'
                    && (isORModel(currentModel) || isOllamaModel(currentModel))) {
                    return;
                }
                mainWindow?.webContents.send('relay-message', msg);
            }
        },
        onStatusChange: (status) => {
            mainWindow?.webContents.send('connection-status', status);
        },
    });
    wsClient.connect();
}

// ── PCB / CAD Python backends (spawned like the bundled llama server) ─────────
let pcbServerChild: ReturnType<typeof spawn> | null = null;
const PCB_SERVER_URL = 'http://127.0.0.1:5051';

/** Resolve a real Python interpreter (the PATH `python` is often the MS Store stub). */
function pythonExe(): string {
    const home = os.homedir();
    const bundled = path.join(process.resourcesPath, 'python', 'python.exe');   // packaged
    const candidates = [
        bundled,
        path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
        path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
    ];
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
    return 'python';
}

/** Directory holding the Python tool servers (dev: jac/server, packaged: resources/server). */
function serverDir(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'server')
        : path.join(__dirname, '..', '..', '..', 'server');
}

async function startPcbServer(): Promise<void> {
    try {
        const r = await fetch(`${PCB_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;   // already running (reuse)
    } catch { /* not up yet */ }
    const script = path.join(serverDir(), 'pcb_tools.py');
    if (!fs.existsSync(script)) { console.log(`[pcb] server script not found: ${script}`); return; }
    try {
        pcbServerChild = spawn(pythonExe(), [script, '5051'], { stdio: 'ignore' });
        pcbServerChild.on('exit', () => { pcbServerChild = null; });
        console.log('[pcb] server starting on :5051');
    } catch (e) { console.log(`[pcb] spawn failed: ${e}`); }
}

function stopPcbServer(): void {
    try { pcbServerChild?.kill(); } catch { /* */ }
    pcbServerChild = null;
}

let cadServerChild: ReturnType<typeof spawn> | null = null;
const CAD_SERVER_URL = 'http://127.0.0.1:5050';

async function startCadServer(): Promise<void> {
    try {
        const r = await fetch(`${CAD_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;
    } catch { /* not up yet */ }
    const script = path.join(serverDir(), 'cad_tools.py');
    if (!fs.existsSync(script)) { console.log(`[cad] server script not found: ${script}`); return; }
    try {
        cadServerChild = spawn(pythonExe(), [script, '5050'], { stdio: 'ignore' });
        cadServerChild.on('exit', () => { cadServerChild = null; });
        console.log('[cad] server starting on :5050 (build123d)');
    } catch (e) { console.log(`[cad] spawn failed: ${e}`); }
}

function stopCadServer(): void {
    try { cadServerChild?.kill(); } catch { /* */ }
    cadServerChild = null;
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);   // drop the default File/Edit/View/Window/Help bar
    if (process.platform === 'win32') app.setAppUserModelId('com.clifford.jac'); // match electron-builder appId
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
        const mcpChanged = 'mcpServers' in updates
            && JSON.stringify(updates.mcpServers) !== JSON.stringify(config.mcpServers);
        config = { ...config, ...updates };
        saveConfig(config);
        if (mcpChanged) mcpManager.reload(config.mcpServers);
        return config;
    });
    // MCP: server connection status + flattened tool list (for the settings panel)
    ipcMain.handle('mcp-status', () => mcpManager.status());
    ipcMain.handle('mcp-tools', () => mcpManager.getTools().map(t => ({
        server: t.server, name: t.name, qualifiedName: t.qualifiedName, description: t.description,
    })));
    ipcMain.handle('mcp-reload', () => { mcpManager.reload(config.mcpServers); return mcpManager.status(); });
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

        // MCP tool-permission prompt reply — resolve the waiting decidePermission() promise.
        if (type === 'permission_response') {
            const rid = msg.request_id as string;
            const resolver = pendingPermissions.get(rid);
            if (resolver) { pendingPermissions.delete(rid); resolver({ allow: Boolean(msg.allow), remember: Boolean(msg.remember) }); }
            return;
        }

        if (type === 'set_model') {
            currentModel = (msg.model as string) || '';
            config.lastModel = currentModel; saveConfig(config);   // persist so it survives restart
            if (isORModel(currentModel) || isOllamaModel(currentModel) || isLocalServerModel(currentModel)) return;
        }

        if (type === 'get_local_models') {
            pollOllamaModels();
            pollLocalServerModels();
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

        if (type === 'abort_query' && isLocalServerModel(currentModel)) {
            localSrvAbort?.abort();
            localSrvAbort = null;
            return;
        }

        if (type === 'query' && isLocalServerModel(currentModel)) {
            handleLocalServerQuery(msg, currentModel.slice('local:'.length)).catch(err =>
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

    ipcMain.handle('fs-mkdir', (_e, dir: string, name: string) => {
        try {
            const clean = String(name).trim().replace(/[\\/:*?"<>|]/g, '');
            if (!clean) return { ok: false, error: 'Invalid name' };
            const target = path.join(dir, clean);
            if (fs.existsSync(target)) return { ok: false, error: 'Already exists' };
            fs.mkdirSync(target);
            return { ok: true, path: target };
        } catch (err) { return { ok: false, error: String(err) }; }
    });

    ipcMain.handle('fs-rename', (_e, oldPath: string, newName: string) => {
        try {
            const clean = String(newName).trim().replace(/[\\/:*?"<>|]/g, '');
            if (!clean) return { ok: false, error: 'Invalid name' };
            const target = path.join(path.dirname(oldPath), clean);
            if (fs.existsSync(target)) return { ok: false, error: 'Already exists' };
            fs.renameSync(oldPath, target);
            return { ok: true, path: target };
        } catch (err) { return { ok: false, error: String(err) }; }
    });

    ipcMain.handle('fs-trash', async (_e, target: string) => {
        try {
            const { dialog } = require('electron');
            const home = os.homedir();
            const resolved = path.resolve(target);
            // Safety: only trash things inside the user's home, and never home itself.
            if (resolved === home || !resolved.toLowerCase().startsWith(home.toLowerCase() + path.sep)) {
                return { ok: false, error: 'Refused: outside home directory' };
            }
            const choice = await dialog.showMessageBox(mainWindow!, {
                type: 'warning',
                buttons: ['Move to Recycle Bin', 'Cancel'],
                defaultId: 1, cancelId: 1,
                message: `Move "${path.basename(resolved)}" to the Recycle Bin?`,
                detail: resolved,
            });
            if (choice.response !== 0) return { ok: false, canceled: true };
            await shell.trashItem(resolved);
            return { ok: true };
        } catch (err) { return { ok: false, error: String(err) }; }
    });

    // ── Local model acquisition (download recommended / pick a GGUF) ──
    ipcMain.handle('get-recommended-model', () => CURATED_MODEL);
    ipcMain.handle('model-download', () => downloadCuratedModel());
    ipcMain.handle('model-download-cancel', () => { modelDownloadAbort?.abort(); });
    ipcMain.handle('model-pick', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openFile'],
            filters: [{ name: 'GGUF models', extensions: ['gguf'] }],
        });
        if (r.canceled || !r.filePaths[0]) return { ok: false };
        config.localModelPath = r.filePaths[0]; saveConfig(config);
        restartLocalServer();
        return { ok: true, path: r.filePaths[0] };
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

    // Auto-start the bundled jac-llm-server (serves the configured model), then poll for it.
    startLocalServer();
    app.on('before-quit', stopLocalServer);
    setupAutoUpdate();
    // Connect any configured MCP servers; tear them down on quit.
    mcpManager.reload(config.mcpServers);
    app.on('before-quit', () => mcpManager.stopAll());
    // Start the PCB/schematic tool server (Python stdlib, :5051) + CAD server (build123d, :5050).
    startPcbServer();
    startCadServer();
    app.on('before-quit', stopPcbServer);
    app.on('before-quit', stopCadServer);
    pollOllamaModels();
    pollLocalServerModels();

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
    if (config.useRelay && config.authToken) setupRelay();
    else mainWindow?.webContents.send('connection-status', 'local'); // local-only mode

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
