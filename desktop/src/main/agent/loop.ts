// Agentic tool-calling loop over any OpenAI-compatible /chat/completions endpoint.
// Streams assistant text (same events as queryOR) and, when the model requests tools,
// executes them via the supplied callTool and feeds results back until the model stops.
import { McpTool } from '../mcp/manager';

type SendFn = (msg: Record<string, unknown>) => void;
type CallToolFn = (qualifiedName: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
type PermitFn = (qualifiedName: string, args: Record<string, unknown>) => Promise<'allow' | 'deny'> | 'allow' | 'deny';

const MAX_ITERS = 50;   // tool-call rounds before the loop bails — agentic debugging needs many steps

interface OAToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }

/** MCP tool list -> OpenAI `tools` array. */
export function toOpenAITools(tools: McpTool[]): Array<Record<string, unknown>> {
    return tools.map(t => ({
        type: 'function',
        function: { name: t.qualifiedName, description: t.description, parameters: t.inputSchema },
    }));
}

interface StreamResult { finishReason: string; toolCalls: OAToolCall[]; text: string; }

/** One streamed completion. Emits assistant_text_delta for content; accumulates any tool_calls. */
async function streamChat(
    url: string,
    headers: Record<string, string>,
    model: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<Record<string, unknown>>,
    send: SendFn,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const acc = new Map<number, { id: string; name: string; arguments: string }>();
    let text = '';
    let finishReason = 'stop';

    const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, tools, stream: true }),
        signal,
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        send({ type: 'error', message: `${resp.status}: ${body.slice(0, 300)}` });
        return { finishReason: 'error', toolCalls: [], text };
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
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
                if (payload === '[DONE]') continue;
                let obj: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }> };
                try { obj = JSON.parse(payload); } catch { continue; }
                const choice = obj.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta;
                if (delta?.content) { text += delta.content; send({ type: 'assistant_text_delta', text: delta.content }); }
                for (const tc of delta?.tool_calls ?? []) {
                    const slot = acc.get(tc.index) ?? { id: '', name: '', arguments: '' };
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.name = tc.function.name;
                    if (tc.function?.arguments) slot.arguments += tc.function.arguments;
                    acc.set(tc.index, slot);
                }
                if (choice.finish_reason) finishReason = choice.finish_reason;
            }
        }
    } finally {
        reader.releaseLock();
    }

    const toolCalls: OAToolCall[] = [...acc.values()]
        .filter(s => s.name)
        .map(s => ({ id: s.id || `call_${s.name}`, type: 'function', function: { name: s.name, arguments: s.arguments || '{}' } }));
    return { finishReason, toolCalls, text };
}

export interface AgenticOpts {
    url: string;
    headers: Record<string, string>;
    model: string;                                   // provider-native id (no `or:` prefix)
    messages: Array<Record<string, unknown>>;
    tools: McpTool[];
    callTool: CallToolFn;
    send: SendFn;
    signal?: AbortSignal;
    permit?: PermitFn;                               // per-tool gate; default allow (P3 adds prompts)
}

/** Run the tool-calling loop. Terminal events mirror queryOR: assistant_text_delta… then `done`. */
export async function runAgenticQuery(opts: AgenticOpts): Promise<void> {
    const oaTools = toOpenAITools(opts.tools);
    const convo = opts.messages.slice();
    const permit = opts.permit;

    try {
        let hitCap = true;
        for (let iter = 0; iter < MAX_ITERS; iter++) {
            const { toolCalls, text } = await streamChat(opts.url, opts.headers, opts.model, convo, oaTools, opts.send, opts.signal);
            if (opts.signal?.aborted) return;
            if (toolCalls.length === 0) { hitCap = false; break; }   // model produced a final answer

            convo.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });

            for (const tc of toolCalls) {
                const name = tc.function.name;
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* malformed args -> {} */ }
                opts.send({ type: 'tool_use', tool_use_id: tc.id, tool_name: name, args });

                const decision = permit ? await permit(name, args) : 'allow';
                if (opts.signal?.aborted) return;
                let content: string;
                let isError: boolean;
                if (decision === 'deny') {
                    content = 'Tool call denied by user.';
                    isError = true;
                } else {
                    const r = await opts.callTool(name, args);
                    content = r.text || (r.isError ? 'Tool returned an error.' : '(no output)');
                    isError = r.isError;
                    // Backstop: one tool result must never bloat the DOM/context to megabytes (a 15M-char
                    // conversation makes typing lag from GC/memory pressure). Cap it; slice a file for more.
                    if (content.length > 24000) {
                        content = content.slice(0, 24000) + `\n…[tool output truncated to 24000 chars — read a specific file/slice for the rest]`;
                    }
                }
                // renderToolResult expects { tool_use_id, content, is_error }
                opts.send({ type: 'tool_result', tool_use_id: tc.id, tool_name: name, content, is_error: isError });
                convo.push({ role: 'tool', tool_call_id: tc.id, content });
            }
        }
        // Don't stop silently mid-task at the cap — tell the user so they can continue.
        if (hitCap) opts.send({ type: 'assistant_text_delta', text: `\n\n_[Paused at the ${MAX_ITERS}-step tool limit — reply "continue" to keep going.]_` });
    } catch (err: unknown) {
        if ((err as Error)?.name !== 'AbortError') opts.send({ type: 'error', message: `agent loop: ${String((err as Error).message ?? err)}` });
    }
    opts.send({ type: 'done' });
}
