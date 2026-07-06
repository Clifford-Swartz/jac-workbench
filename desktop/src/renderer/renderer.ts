// Renderer process — bridges window.jac (preload IPC) to the existing main.js webview UI.
// main.js expects a `vscode` global with postMessage/onDidReceiveMessage.
// We shim that interface here so main.js works unmodified.
import './editor';   // registers window.jacCreateEditor (CodeMirror) for the file viewer

interface JacAPI {
    getConfig: () => Promise<Record<string, unknown>>;
    saveConfig: (u: Record<string, unknown>) => Promise<Record<string, unknown>>;
    getPlatform: () => Promise<string>;
    getHome: () => Promise<string>;
    openExternal: (url: string) => Promise<void>;
    send: (msg: unknown) => void;
    sendRaw: (msg: unknown) => void;
    onRelayMessage: (cb: (msg: unknown) => void) => () => void;
    onConnectionStatus: (cb: (status: string) => void) => () => void;
    getPendingFindings: () => Promise<Array<{ id: string; taskName: string; summary: string; read: boolean; timestamp: string }>>;
    clearFinding: (id: string) => Promise<void>;
    runTaskNow: (name: string) => Promise<void>;
    getTasks: () => Promise<unknown[]>;
    onTaskComplete: (cb: (finding: unknown) => void) => () => void;
    convSave: (messages: unknown[], meta: unknown, workspace: string) => Promise<string>;
    convLoadIndex: () => Promise<unknown[]>;
    convLoad: (id: string) => Promise<unknown[] | null>;
    convDelete: (id: string) => Promise<void>;
    listClaudeSessions: (cwd: string) => Promise<Array<{ id: string; title: string; timestamp: number; source: string }>>;
    loadClaudeSession: (cwd: string, id: string) => Promise<unknown[] | null>;
    getProjectHistory: (cwd: string) => Promise<Array<Record<string, unknown>>>;
    listDir: (dirPath: string) => Promise<Array<{ name: string; path: string; isDir: boolean }>>;
    openInFinder: (dirPath: string) => Promise<void>;
    openFolderDialog: () => Promise<string | null>;
}

declare global {
    interface Window {
        jac: JacAPI;
        acquireVsCodeApi?: () => unknown;
        vscode?: { postMessage: (msg: unknown) => void; getState: () => unknown; setState: (s: unknown) => void };
    }
}

export {};

// Intercept window.addEventListener before main.js runs to capture its 'message' handler.
// This mirrors how VSCode's internal webview bridge delivers messages — via direct invocation
// rather than window.postMessage. (window.postMessage didn't reach main.js's handler because
// a missing DOM element caused main.js to throw before registering it; direct dispatch is
// also more reliable and avoids origin/trust subtleties.)
const _messageHandlers: EventListenerOrEventListenerObject[] = [];
const _origAEL = window.addEventListener.bind(window);
(window as any).addEventListener = function(
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
) {
    if (type === 'message') _messageHandlers.push(handler);
    return _origAEL(type, handler as EventListenerOrEventListenerObject, options as AddEventListenerOptions);
};

// Shim vscode API so main.js doesn't need modification
window.acquireVsCodeApi = () => ({
    postMessage(msg: unknown) {
        handleOutboundMessage(msg as Record<string, unknown>);
    },
    getState() { return null; },
    setState(_s: unknown) {},
});

// Track the current working directory (set when user picks a folder in the explorer)
let currentWorkspace = 'global';
// Stable id for the active conversation so per-turn autosaves update in place instead of spawning files.
let currentConvId = '';
function freshConvId(): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
// How many leading messages of the current view are read-only Claude Code history stitched in "behind" the
// JAC conversation. They are stripped before persisting so the prefix is never baked into the saved conv
// (otherwise it would re-prepend and compound every time you reopened the chat).
let claudePrefixLen = 0;
const CLAUDE_PREFIX_CAP = 60;   // most-recent N Claude turns to stitch in — bounded so the view stays light

// Cap each message's rendered text so reopening a huge conversation (one full of giant tool-output dumps)
// doesn't build a multi-megabyte DOM — that's what makes typing lag (GC/memory pressure), not the CSS. The
// full text stays on disk; this only trims what gets handed to the view.
const MSG_TEXT_CAP = 4000;
function trimForView(m: unknown): unknown {
    const clip = (s: string) => (s.length > MSG_TEXT_CAP
        ? s.slice(0, MSG_TEXT_CAP) + `\n…[${s.length - MSG_TEXT_CAP} chars hidden — full text on disk]` : s);
    const out: Record<string, unknown> = { ...(m as Record<string, unknown>) };
    for (const k of ['text', 'content', 'result', 'output']) {
        if (typeof out[k] === 'string') out[k] = clip(out[k] as string);
    }
    if (Array.isArray(out.tools)) {
        out.tools = (out.tools as Array<Record<string, unknown>>).map(t => {
            const tt: Record<string, unknown> = { ...t };
            for (const k of ['result', 'output', 'content']) if (typeof tt[k] === 'string') tt[k] = clip(tt[k] as string);
            return tt;
        });
    }
    return out;
}

// The explorer's "Start conversation" sends set_cwd via sendRaw (bypassing the case below), so let it
// record the workspace directly — otherwise every conversation is mis-filed under 'global'.
(window as unknown as { __setJacWorkspace: (w: string) => void }).__setJacWorkspace = (w: string) => {
    currentWorkspace = w || 'global';
};

// Build a folder's unified thread: its most-recent Claude Code session (read-only, tagged _cc) followed by
// the given JAC conversation's messages. Returns the view + how many leading msgs are Claude's. This is the
// "stitch" — a JAC chat in a folder always shows the Claude Code work behind it as one continuous thread.
async function buildUnifiedView(folder: string, jacId: string): Promise<{ view: unknown[]; prefixLen: number }> {
    let cMsgs: Array<Record<string, unknown>> = [];
    try {
        const hist = await window.jac.getProjectHistory(folder || '');
        const cc = hist.find(h => String(h.id).startsWith('cc:'));
        if (cc) {
            const loaded = (await window.jac.loadClaudeSession(folder, cc.id as string)) as Array<Record<string, unknown>> | null;
            cMsgs = (loaded || []).slice(-CLAUDE_PREFIX_CAP).map(m => ({ ...m, _cc: true }));
        }
    } catch { /* no Claude history for this folder */ }
    let jMsgs: unknown[] = [];
    if (jacId) { try { jMsgs = ((await window.jac.convLoad(jacId)) as unknown[]) || []; } catch { /* */ } }
    return { view: [...cMsgs, ...jMsgs].map(trimForView), prefixLen: cMsgs.length };
}

// Open a folder's LATEST chat as one unified thread (Claude history behind the newest JAC conversation).
// This is what the explorer's "Start conversation" does now — resume, not blank. New chats are via the dropdown.
async function openFolderLatest(folder: string): Promise<void> {
    let latestJacId = '';
    try {
        const hist = await window.jac.getProjectHistory(folder || '');
        const latest = hist.find(h => !String(h.id).startsWith('cc:'));   // most-recent JAC conv (list is time-desc)
        if (latest) latestJacId = String(latest.id);
    } catch { /* */ }
    const { view, prefixLen } = await buildUnifiedView(folder, latestJacId);
    currentConvId = latestJacId || freshConvId();
    claudePrefixLen = prefixLen;
    if (view.length > 0) dispatchToUI({ type: 'conversation_loaded', messages: view, meta: null });
    else dispatchToUI({ type: 'conversation_reset' });
}

// Explorer "Start conversation": save the current chat, anchor the folder, and RESUME the folder's latest
// unified thread (Claude Code history stitched behind the newest JAC conversation). Start a new one via the ▾ menu.
(window as unknown as { __jacStartConversation: (folder: string) => void }).__jacStartConversation = (folder: string) => {
    try { window.dispatchEvent(new Event('beforeunload')); } catch { /* persist current before switching */ }
    currentWorkspace = folder || 'global';
    window.jac.sendRaw({ type: 'set_cwd', cwd: folder });
    void openFolderLatest(folder);
};

// Messages FROM the webview UI (main.js postMessage calls) → relay or local handling
function handleOutboundMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    switch (type) {
        case 'query':
        case 'abort_query':
        case 'set_model':
        case 'permission_response':
        case 'set_permission_mode':
        case 'tool_result_response':
            window.jac.send(msg);
            break;

        case 'new_conversation':
            currentConvId = freshConvId();   // fresh file id; this turn's autosaves accrue to it
            window.jac.send(msg);
            // A new conversation still shows the folder's Claude Code history behind it (unified thread).
            buildUnifiedView(currentWorkspace, '').then(({ view, prefixLen }) => {
                claudePrefixLen = prefixLen;
                if (view.length > 0) setTimeout(() => dispatchToUI({ type: 'conversation_loaded', messages: view, meta: null }), 30);
            });
            break;

        case 'set_cwd':
            currentWorkspace = (msg.cwd as string) || 'global';
            window.jac.sendRaw(msg);
            break;

        case 'save_conversation': {
            if (!currentConvId) currentConvId = freshConvId();
            let msgs = (msg.messages as Array<Record<string, unknown>>) || [];
            // Strip the read-only Claude Code prefix so it's never baked into the saved JAC conv. Prefer the
            // _cc marker (survives if the bundle keeps extra fields); fall back to slicing the known prefix length.
            if (claudePrefixLen > 0 && msgs.length) {
                const filtered = msgs.filter(m => !(m && (m as Record<string, unknown>)._cc));
                msgs = filtered.length < msgs.length ? filtered
                     : (msgs.length > claudePrefixLen ? msgs.slice(claudePrefixLen) : msgs);
            }
            window.jac.convSave(
                msgs,
                { ...((msg.metadata as Record<string, unknown>) || {}), id: currentConvId },
                currentWorkspace,
            );
            break;
        }

        case 'load_history': {
            // Per-project history (main scopes BOTH Claude sessions and JAC convs to the resolved project,
            // so a project's real chats aren't buried under every other conversation).
            const browsed = (window as unknown as { __jacExplorerCwd?: string }).__jacExplorerCwd || '';
            window.jac.getProjectHistory(browsed).then((list) => {
                dispatchToUI({ type: 'history_list', conversations: list as unknown[] });
            });
            break;
        }

        case 'restore_conversation': {
            const rid = msg.id as string;
            if (rid && rid.startsWith('cc:')) {
                // A Claude Code session opened directly from the menu — read-only, no stitched prefix.
                window.jac.loadClaudeSession(currentWorkspace, rid).then(messages => {
                    const arr = (messages as unknown[]) || [];
                    claudePrefixLen = 0;
                    const view = (arr.length > 800 ? arr.slice(-800) : arr).map(trimForView);   // cap count + per-msg text
                    if (view.length > 0) dispatchToUI({ type: 'conversation_loaded', messages: view, meta: null });
                });
            } else {
                // A JAC conversation → stitch the folder's Claude history behind it and make it the live conv.
                buildUnifiedView(currentWorkspace, rid).then(({ view, prefixLen }) => {
                    currentConvId = rid;
                    claudePrefixLen = prefixLen;
                    (window as unknown as { __lastRestore: unknown }).__lastRestore = { id: rid, ws: currentWorkspace, count: view.length, prefix: prefixLen };
                    if (view.length > 0) dispatchToUI({ type: 'conversation_loaded', messages: view, meta: null });
                });
            }
            break;
        }

        case 'delete_conversation':
            window.jac.convDelete(msg.id as string).then(() => {
                window.jac.convLoadIndex().then(index => {
                    dispatchToUI({ type: 'history_list', conversations: index });
                });
            });
            break;

        case 'tool_execute_result':
            window.jac.sendRaw(msg);
            break;

        case 'set_model_favorites':
        case 'set_default_model':
        case 'get_local_models':
        case 'browse_local_models':
            window.jac.send(msg);
            break;

        case 'open_external':
            window.jac.openExternal(msg.url as string);
            break;

        case 'get_findings':
            window.jac.getPendingFindings().then(findings => {
                dispatchToUI({ type: 'pending_findings', findings });
            });
            break;

        case 'clear_finding':
            window.jac.clearFinding(msg.id as string);
            break;

        case 'run_task_now':
            window.jac.runTaskNow(msg.name as string);
            break;

        default:
            window.jac.sendRaw(msg);
    }
}

// Messages FROM relay/main → webview UI.
// Directly invoke captured handlers (mirrors VSCode's internal webview bridge mechanism).
function dispatchToUI(msg: unknown): void {
    const event = new MessageEvent('message', { data: msg });
    for (const h of _messageHandlers) {
        try {
            if (typeof h === 'function') h(event);
            else h.handleEvent(event);
        } catch (_) { /* isolate per-handler errors */ }
    }
}

// Wire up relay → UI
window.jac.onRelayMessage((msg) => {
    (window as any).__lastRelayMsg = msg;
    (window as any).__relayMsgCount = ((window as any).__relayMsgCount || 0) + 1;
    // Chat drove the CAD kernel: focus the CAD tab and refresh its viewer. Control message, not chat content.
    if (msg && (msg as any).type === 'cad_activity') {
        try { (window as any).jacOpenView?.('cad'); } catch { /* view not ready */ }
        try {
            const f = Array.from(document.querySelectorAll('iframe'))
                .find((x) => (x as HTMLIFrameElement).src.endsWith('cad.html')) as HTMLIFrameElement | undefined;
            f?.contentWindow?.postMessage({ type: 'cad_refresh' }, '*');
        } catch { /* iframe not ready */ }
        return;
    }
    // Chat/edit drove the KiCad schematic: focus the tab, push native render-data to the canvas.
    if (msg && ((msg as any).type === 'sch_activity' || (msg as any).type === 'sch_kicad_svg')) {
        const m = msg as any;
        if (m.type === 'sch_activity') { try { (window as any).jacOpenView?.('schematic'); } catch { /* not ready */ } }
        try {
            const f = Array.from(document.querySelectorAll('iframe'))
                .find((x) => (x as HTMLIFrameElement).src.endsWith('schematic.html')) as HTMLIFrameElement | undefined;
            const payload = m.type === 'sch_kicad_svg' ? { type: 'sch_kicad_svg', svg: m.svg }
                : m.error ? { type: 'sch_error', error: m.error }
                : { type: 'sch_data', data: m.data };
            f?.contentWindow?.postMessage(payload, '*');
        } catch { /* iframe not ready */ }
        return;
    }
    // Chat drove the PCB/schematic kernel: focus the PCB tab and refresh its viewer.
    if (msg && (msg as any).type === 'pcb_activity') {
        try { (window as any).jacOpenView?.('pcb'); } catch { /* view not ready */ }
        try {
            const f = Array.from(document.querySelectorAll('iframe'))
                .find((x) => (x as HTMLIFrameElement).src.endsWith('pcb.html')) as HTMLIFrameElement | undefined;
            f?.contentWindow?.postMessage({ type: 'pcb_refresh' }, '*');
        } catch { /* iframe not ready */ }
        return;
    }
    // Chat generated/imported a mesh: focus CAD tab, read the GLB via openGlb, load it into the viewer.
    if (msg && (msg as any).type === 'cad_load_glb') {
        try { (window as any).jacOpenView?.('cad'); } catch { /* view not ready */ }
        (async () => {
            try {
                const r = await (window.jac as any).openGlb((msg as any).path);
                if (!r || !r.ok) return;
                const f = Array.from(document.querySelectorAll('iframe'))
                    .find((x) => (x as HTMLIFrameElement).src.endsWith('cad.html')) as HTMLIFrameElement | undefined;
                f?.contentWindow?.postMessage({ type: 'load_glb_base64', data: r.b64, name: (msg as any).name || r.name }, '*');
            } catch { /* iframe/openGlb not ready */ }
        })();
        return;
    }
    dispatchToUI(msg);
    // JAC otherwise only saves on window unload; also persist after each completed turn so a crash,
    // force-kill, or power loss can't lose more than the in-flight message. The bundle's beforeunload
    // handler builds the current messages and posts save_conversation, which we route to convSave.
    const _t = (msg as { type?: string })?.type;
    if (_t === 'done' || _t === 'stream_end') {   // OpenRouter/agent = 'done'; local/Ollama = 'stream_end'
        setTimeout(() => { try { window.dispatchEvent(new Event('beforeunload')); } catch { /* */ } }, 60);
    }
});

// Wire up connection status → UI
window.jac.onConnectionStatus((status) => {
    dispatchToUI({ type: 'connection_status', status });
});

// Wire up task completions → UI
window.jac.onTaskComplete((finding) => {
    dispatchToUI({ type: 'new_finding', finding });
});

// On load, push config to UI
window.addEventListener('DOMContentLoaded', () => {
    window.jac.getConfig().then(config => {
        dispatchToUI({
            type: 'config',
            preferredMachineId: config.preferredMachineId,
            relayUrl: config.relayUrl,
        });
    });
});
