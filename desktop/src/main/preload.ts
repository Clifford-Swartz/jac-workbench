import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jac', {
    // Config
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (updates: Record<string, unknown>) => ipcRenderer.invoke('save-config', updates),
    getOrUsage: () => ipcRenderer.invoke('get-or-usage'),
    getPlatform: () => ipcRenderer.invoke('get-platform'),
    getHome: () => ipcRenderer.invoke('get-home'),
    openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
    setTitleBarOverlay: (color: string, symbolColor: string) => ipcRenderer.invoke('set-titlebar-overlay', color, symbolColor),

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
    listClaudeSessions: (cwd: string) => ipcRenderer.invoke('list-claude-sessions', cwd),
    loadClaudeSession: (cwd: string, id: string) => ipcRenderer.invoke('load-claude-session', cwd, id),
    getProjectHistory: (cwd: string) => ipcRenderer.invoke('get-project-history', cwd),
    convDelete: (id: string) => ipcRenderer.invoke('conv-delete', id),

    // Workflow
    openWorkflow: () => ipcRenderer.invoke('open-workflow'),
    saveWorkflow: (name: string, data: string) => ipcRenderer.invoke('workflow-save', name, data),
    loadWorkflow: (name: string) => ipcRenderer.invoke('workflow-load', name),
    listWorkflows: () => ipcRenderer.invoke('workflow-list'),

    // Local models
    startOllama: () => ipcRenderer.invoke('ollama-start'),
    getRecommendedModel: () => ipcRenderer.invoke('get-recommended-model'),
    downloadModel: () => ipcRenderer.invoke('model-download'),
    cancelModelDownload: () => ipcRenderer.invoke('model-download-cancel'),
    pickModel: () => ipcRenderer.invoke('model-pick'),
    onModelDownloadProgress: (cb: (p: unknown) => void) => {
        const h = (_: unknown, p: unknown) => cb(p);
        ipcRenderer.on('model-download-progress', h);
        return () => ipcRenderer.removeListener('model-download-progress', h);
    },

    // MCP servers
    mcpStatus: () => ipcRenderer.invoke('mcp-status'),
    mcpTools: () => ipcRenderer.invoke('mcp-tools'),
    mcpReload: () => ipcRenderer.invoke('mcp-reload'),

    // Filesystem
    listDir: (dirPath: string) => ipcRenderer.invoke('fs-list-dir', dirPath),
    readFile: (filePath: string) => ipcRenderer.invoke('fs-read-file', filePath),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs-write-file', filePath, content),
    openGlb: (filePath?: string) => ipcRenderer.invoke('cad-open-glb', filePath),
    saveModel: (b64: string, defaultName: string) => ipcRenderer.invoke('cad-save-model', b64, defaultName),
    openExternalFile: (filePath: string) => ipcRenderer.invoke('fs-open-external-file', filePath),
    openInFinder: (dirPath: string) => ipcRenderer.invoke('fs-open-in-finder', dirPath),
    openFolderDialog: () => ipcRenderer.invoke('dialog-open-folder'),
    projectSaveDialog: () => ipcRenderer.invoke('project-save-dialog'),
    projectOpenDialog: () => ipcRenderer.invoke('project-open-dialog'),
    mkdir: (dir: string, name: string) => ipcRenderer.invoke('fs-mkdir', dir, name),
    trash: (target: string) => ipcRenderer.invoke('fs-trash', target),
    renamePath: (oldPath: string, newName: string) => ipcRenderer.invoke('fs-rename', oldPath, newName),

    // History pagination
    loadMoreHistory: (cwd: string, offset: number) => ipcRenderer.invoke('history-load-more', cwd, offset),

    // Music
    scanMusic: (dirPath: string) => ipcRenderer.invoke('music-scan', dirPath),
    readAudioFile: (filePath: string) => ipcRenderer.invoke('music-read-file', filePath),
    saveMusicState: (state: unknown) => ipcRenderer.invoke('music-save-state', state),
    loadMusicState: () => ipcRenderer.invoke('music-load-state'),

    // KiCad WASM router (real push-and-shove engine ported to WASM)
    kicadRouteDemo: (withObstacle: boolean, mode: string) =>
        ipcRenderer.invoke('kicad-route-demo', withObstacle, mode),
    // Interactive routing session (coords in nanometres)
    kicadRouteSetup: (obstacles: unknown[], segments: unknown[], mode: string, trackWidth: number, clearance: number) =>
        ipcRenderer.invoke('kicad-route-setup', obstacles, segments, mode, trackWidth, clearance),
    kicadRouteStart: (x: number, y: number, layer: number) =>
        ipcRenderer.invoke('kicad-route-start', x, y, layer),
    kicadRouteMove: (x: number, y: number) => ipcRenderer.invoke('kicad-route-move', x, y),
    kicadRouteFinish: (x: number, y: number) => ipcRenderer.invoke('kicad-route-finish', x, y),
    kicadRouteAB: (x1: number, y1: number, x2: number, y2: number, layer: number) =>
        ipcRenderer.invoke('kicad-route-ab', x1, y1, x2, y2, layer),
    kicadFabricate: (pcbPath: string, bomPath?: string) => ipcRenderer.invoke('kicad-fabricate', pcbPath, bomPath),
    kicadDrc: (pcbPath: string) => ipcRenderer.invoke('kicad-drc', pcbPath),
    kicadSymbolSearch: (query: string) => ipcRenderer.invoke('kicad-symbol-search', query),
    kicadSymbolGet: (libId: string) => ipcRenderer.invoke('kicad-symbol-get', libId),
});
