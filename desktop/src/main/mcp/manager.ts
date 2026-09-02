// Minimal MCP client — JSON-RPC 2.0 over newline-delimited stdio.
// Hand-rolled (no @modelcontextprotocol/sdk) to avoid ESM-in-CJS webpack friction.
// Supports the stdio transport + initialize / tools/list / tools/call. SSE (url) is P4.
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';

export interface McpServerConfig {
    command?: string;               // stdio: executable (e.g. "npx")
    args?: string[];
    env?: Record<string, string>;
    url?: string;                   // sse/http transport — not yet implemented
    disabled?: boolean;
}

export interface McpTool {
    server: string;                 // config key
    name: string;                   // raw tool name as the server reports it
    qualifiedName: string;          // mcp__<server>__<tool>, sanitized to OpenAI's tool-name charset
    description: string;
    inputSchema: Record<string, unknown>;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 30_000;

// OpenAI tool names must match ^[A-Za-z0-9_-]{1,64}$
function sanitize(s: string): string { return s.replace(/[^A-Za-z0-9_-]/g, '_'); }
export function qualify(server: string, tool: string): string {
    return `mcp__${sanitize(server)}__${sanitize(tool)}`.slice(0, 64);
}

type ConnStatus = 'connecting' | 'ready' | 'error' | 'stopped';

// The roots every connection reports, kept module-level so a cwd change updates all
// servers at once. Set by McpManager.setRoots(); empty means "we have nothing to say",
// and a server then keeps whatever its argv gave it.
let _roots: string[] = [];
/** file:// URIs, as the roots spec requires — servers reject bare Windows paths. */
function currentRoots(): Array<{ uri: string; name: string }> {
    return _roots.map(p => ({ uri: pathToFileURL(p).href, name: path.basename(p) || p }));
}

class McpConnection {
    private child: ChildProcess | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private buf = '';
    tools: McpTool[] = [];
    status: ConnStatus = 'connecting';
    error = '';

    constructor(
        public readonly name: string,
        private readonly cfg: McpServerConfig,
        private readonly log: (m: string) => void,
    ) {}

    async start(): Promise<void> {
        if (!this.cfg.command) {
            this.status = 'error';
            this.error = 'only stdio (command) transport is supported for now';
            throw new Error(this.error);
        }
        // On Windows we run through the shell so npx/*.cmd shims resolve — but shell:true does NOT
        // quote args, so any arg with spaces (e.g. "C:\Users\Jane Doe\...") gets split. Pre-quote
        // them; Node spawns cmd with /s /c so the outer wrapper quote is stripped, inner ones kept.
        const isWin = process.platform === 'win32';
        const rawArgs = this.cfg.args ?? [];
        const args = isWin
            ? rawArgs.map(a => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
            : rawArgs;
        this.child = spawn(this.cfg.command, args, {
            env: { ...process.env, ...(this.cfg.env ?? {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: isWin,   // let cmd resolve npx / *.cmd shims
        });
        this.child.on('error', (e) => { this.fail('error', e); });
        this.child.on('exit', (code) => { this.fail('stopped', new Error(`mcp server "${this.name}" exited (code ${code})`)); });
        this.child.stderr?.on('data', (d) => this.log(`[mcp:${this.name}] ${String(d).trimEnd()}`));
        this.child.stdout?.on('data', (d) => this.onData(String(d)));

        // Declare the `roots` capability. Servers that honour it (the reference filesystem
        // server does) scope themselves to the roots WE report instead of the fixed
        // directory list baked into their argv — otherwise it logs "Client does not support
        // MCP Roots, using allowed directories set from server args" and every path outside
        // that one folder comes back "Access denied", which reads to the model as a write
        // that silently didn't land.
        await this.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { roots: { listChanged: true } },
            clientInfo: { name: 'JAC', version: '0.1.0' },
        });
        this.notify('notifications/initialized', {});
        await this.refreshTools();
        if (this.status === 'connecting') this.status = 'ready';
    }

    private onData(chunk: string): void {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            let msg: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
            try { msg = JSON.parse(line); } catch { continue; }
            // Server -> client REQUEST. Having declared the roots capability we must answer
            // roots/list, or the server blocks waiting and falls back to its argv directories.
            if (msg.method === 'roots/list' && typeof msg.id === 'number') {
                this.write({ jsonrpc: '2.0', id: msg.id, result: { roots: currentRoots() } });
                continue;
            }
            if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id)!;
                this.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
                else p.resolve(msg.result);
            }
            // other server-initiated notifications (tools/list_changed, etc.) ignored for now
        }
    }

    /** Tell the server its roots changed; it re-fetches via roots/list. */
    notifyRootsChanged(): void {
        this.notify('notifications/roots/list_changed', {});
    }

    private write(obj: unknown): void {
        try { this.child?.stdin?.write(JSON.stringify(obj) + '\n'); } catch { /* pipe closed */ }
    }

    private request(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write({ jsonrpc: '2.0', id, method, params });
            setTimeout(() => {
                if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`mcp "${this.name}" ${method} timed out`)); }
            }, timeoutMs);
        });
    }

    private notify(method: string, params: unknown): void {
        this.write({ jsonrpc: '2.0', method, params });
    }

    private fail(status: ConnStatus, e: Error): void {
        this.status = status;
        this.error = e.message;
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
    }

    async refreshTools(): Promise<void> {
        const res = await this.request('tools/list', {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
        this.tools = (res?.tools ?? []).map(t => ({
            server: this.name,
            name: t.name,
            qualifiedName: qualify(this.name, t.name),
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        }));
    }

    async callTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
        // Tools legitimately run long (a build, a test suite, a 30s hardware poll). The 30s default is only
        // meant for the initialize / tools-list handshake — give tools/call a real budget: honor an explicit
        // timeout_ms arg (+15s margin so the tool's own timer fires first), else 10 minutes.
        const declared = typeof (args as { timeout_ms?: unknown })?.timeout_ms === 'number' ? (args as { timeout_ms: number }).timeout_ms : 0;
        const callTimeout = declared > 0 ? declared + 15_000 : 600_000;
        const res = await this.request('tools/call', { name: toolName, arguments: args ?? {} }, callTimeout) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
        const text = (res?.content ?? [])
            .map(c => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
            .join('\n');
        return { text, isError: Boolean(res?.isError) };
    }

    stop(): void {
        this.status = 'stopped';
        try { this.child?.kill(); } catch { /* */ }
        this.child = null;
    }
}

export class McpManager {
    private conns = new Map<string, McpConnection>();
    constructor(private readonly log: (m: string) => void = () => {}) {}

    /** Tear down all connections and (re)connect from a config map. Safe to call repeatedly. */
    async reload(servers: Record<string, McpServerConfig> | undefined): Promise<void> {
        this.stopAll();
        for (const [name, cfg] of Object.entries(servers ?? {})) {
            if (!cfg || cfg.disabled) continue;
            const conn = new McpConnection(name, cfg, this.log);
            this.conns.set(name, conn);
            // fire-and-forget: a slow/broken server shouldn't block the others or app startup
            conn.start().catch(e => this.log(`[mcp:${name}] connect failed: ${e}`));
        }
    }

    getTools(): McpTool[] {
        const out: McpTool[] = [];
        for (const c of this.conns.values()) if (c.status === 'ready') out.push(...c.tools);
        return out;
    }

    findTool(qualifiedName: string): McpTool | undefined {
        for (const c of this.conns.values()) {
            const t = c.tools.find(x => x.qualifiedName === qualifiedName);
            if (t) return t;
        }
        return undefined;
    }

    async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
        const tool = this.findTool(qualifiedName);
        if (!tool) return { text: `Unknown tool: ${qualifiedName}`, isError: true };
        const conn = this.conns.get(tool.server);
        if (!conn || conn.status !== 'ready') return { text: `MCP server not connected: ${tool.server}`, isError: true };
        try {
            const r = await conn.callTool(tool.name, args);
            // A path rejection is the single most confusing failure a model hits here: it reads
            // like the write "just didn't land" and the model starts inventing shell workarounds.
            // Say plainly what is reachable and how to change it.
            if (r.isError && /outside allowed directories|not in\b|Access denied/i.test(r.text)) {
                const reach = _roots.length ? _roots.join(', ') : '(none reported — server is using its own argv list)';
                return {
                    isError: true,
                    text: `${r.text}\n\nJAC currently exposes these folders to file tools: ${reach}. `
                        + `This is a sandbox boundary, not a missing file — the write did not happen. `
                        + `Ask the user to start a conversation anchored on the folder they want edited, `
                        + `or to add it to "mcpExtraRoots" in ~/.jac/config.json. Do not retry the same path.`,
                };
            }
            return r;
        }
        catch (e) { return { text: `Tool error: ${String((e as Error).message ?? e)}`, isError: true }; }
    }

    /** Point every connected server at these folders (the anchored working dir, plus any
     *  extras). Call on cwd change: servers honouring roots re-scope without a restart. */
    setRoots(dirs: string[]): void {
        const next = [...new Set(dirs.filter(Boolean))];
        if (next.length === _roots.length && next.every((d, i) => d === _roots[i])) return;
        _roots = next;
        for (const c of this.conns.values()) {
            if (c.status === 'ready') c.notifyRootsChanged();
        }
    }

    roots(): string[] { return [..._roots]; }

    status(): Array<{ name: string; status: ConnStatus; error: string; toolCount: number }> {
        return [...this.conns.entries()].map(([name, c]) => ({
            name, status: c.status, error: c.error, toolCount: c.tools.length,
        }));
    }

    async restartServer(name: string, cfg: McpServerConfig): Promise<void> {
        const existing = this.conns.get(name);
        if (existing) existing.stop();
        const conn = new McpConnection(name, cfg, this.log);
        this.conns.set(name, conn);
        conn.start().catch(e => this.log(`[mcp:${name}] restart failed: ${e}`));
    }

    stopAll(): void {
        for (const c of this.conns.values()) c.stop();
        this.conns.clear();
    }
}
