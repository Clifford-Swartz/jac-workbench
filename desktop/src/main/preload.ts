import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jac', {
    // Config
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (updates: Record<string, unknown>) => ipcRenderer.invoke('save-config', updates),
    getPlatform: () => ipcRenderer.invoke('get-platform'),
    getHome: () => ipcRenderer.invoke('get-home'),
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

    // Relay communication
    send: (msg: unknown) => ipcRenderer.send('relay-send', msg),
    sendRaw: (msg: unknown) => ipcRenderer.send('relay-send-raw', msg),
    onRelayMessage: (cb: (msg: unknown) => void) => {
        const handler = (_: unknown, msg: unknown) => cb(msg);
        ipcRenderer.on('relay-message', handler);
        return () => ipcRenderer.removeListener('relay-message', handler);
    },
    onConnectionStatus: (cb: (status: string) => void) => {
        const handler = (_: unknown, status: string) => cb(status);
        ipcRenderer.on('connection-status', handler);
        return () => ipcRenderer.removeListener('connection-status', handler);
    },

    // Research findings
    getPendingFindings: () => ipcRenderer.invoke('get-pending-findings'),
    clearFinding: (id: string) => ipcRenderer.invoke('clear-finding', id),
    runTaskNow: (name: string) => ipcRenderer.invoke('run-task-now', name),
    getTasks: () => ipcRenderer.invoke('get-tasks'),
    onTaskComplete: (cb: (finding: unknown) => void) => {
        const handler = (_: unknown, finding: unknown) => cb(finding);
        ipcRenderer.on('task-complete', handler);
        return () => ipcRenderer.removeListener('task-complete', handler);
    },

    // Conversations
    convSave: (messages: unknown[], meta: unknown, workspace: string) =>
        ipcRenderer.invoke('conv-save', messages, meta, workspace),
    convLoadIndex: () => ipcRenderer.invoke('conv-load-index'),
    convLoad: (id: string) => ipcRenderer.invoke('conv-load', id),
    convDelete: (id: string) => ipcRenderer.invoke('conv-delete', id),

    // Workflow
    openWorkflow: () => ipcRenderer.invoke('open-workflow'),
    saveWorkflow: (name: string, data: string) => ipcRenderer.invoke('workflow-save', name, data),
    loadWorkflow: (name: string) => ipcRenderer.invoke('workflow-load', name),
    listWorkflows: () => ipcRenderer.invoke('workflow-list'),

    // Local models
    startOllama: () => ipcRenderer.invoke('ollama-start'),

    // Filesystem
    listDir: (dirPath: string) => ipcRenderer.invoke('fs-list-dir', dirPath),
    openInFinder: (dirPath: string) => ipcRenderer.invoke('fs-open-in-finder', dirPath),
    openFolderDialog: () => ipcRenderer.invoke('dialog-open-folder'),

    // History pagination
    loadMoreHistory: (cwd: string, offset: number) => ipcRenderer.invoke('history-load-more', cwd, offset),

    // Music
    scanMusic: (dirPath: string) => ipcRenderer.invoke('music-scan', dirPath),
    readAudioFile: (filePath: string) => ipcRenderer.invoke('music-read-file', filePath),
    saveMusicState: (state: unknown) => ipcRenderer.invoke('music-save-state', state),
    loadMusicState: () => ipcRenderer.invoke('music-load-state'),
});
