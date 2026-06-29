// Renderer process — bridges window.jac (preload IPC) to the existing main.js webview UI.
// main.js expects a `vscode` global with postMessage/onDidReceiveMessage.
// We shim that interface here so main.js works unmodified.

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

// Messages FROM the webview UI (main.js postMessage calls) → relay or local handling
function handleOutboundMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    switch (type) {
        case 'query':
        case 'new_conversation':
        case 'abort_query':
        case 'set_model':
        case 'permission_response':
        case 'set_permission_mode':
        case 'tool_result_response':
            window.jac.send(msg);
            break;

        case 'set_cwd':
            currentWorkspace = (msg.cwd as string) || 'global';
            window.jac.sendRaw(msg);
            break;

        case 'save_conversation':
            window.jac.convSave(
                msg.messages as unknown[],
                msg.metadata as unknown,
                currentWorkspace,
            );
            break;

        case 'load_history':
            window.jac.convLoadIndex().then(index => {
                // Sort: current workspace first, then by recency
                const sorted = (index as Array<Record<string, unknown>>).sort((a, b) => {
                    const aMatch = a.workspace === currentWorkspace ? 0 : 1;
                    const bMatch = b.workspace === currentWorkspace ? 0 : 1;
                    if (aMatch !== bMatch) return aMatch - bMatch;
                    return (b.timestamp as number) - (a.timestamp as number);
                });
                dispatchToUI({ type: 'history_list', conversations: sorted });
            });
            break;

        case 'restore_conversation':
            window.jac.convLoad(msg.id as string).then(messages => {
                if (messages) dispatchToUI({ type: 'conversation_loaded', messages, meta: null });
            });
            break;

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
    dispatchToUI(msg);
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
