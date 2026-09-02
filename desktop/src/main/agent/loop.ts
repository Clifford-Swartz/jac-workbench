// Agentic tool-calling loop over any OpenAI-compatible /chat/completions endpoint.
// Streams assistant text (same events as queryOR) and, when the model requests tools,
// executes them via the supplied callTool and feeds results back until the model stops.
import { McpTool } from '../mcp/manager';

type SendFn = (msg: Record<string, unknown>) => void;
type CallToolFn = (qualifiedName: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
type PermitFn = (qualifiedName: string, args: Record<string, unknown>) => Promise<'allow' | 'deny'> | 'allow' | 'deny';

const MAX_ITERS = 50;   // tool-call rounds before the loop bails — agentic debugging needs many steps
const MAX_NUDGES = 2;   // consecutive "you said you would, now do it" pokes before we accept the answer

interface OAToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }

/** MCP tool list -> OpenAI `tools` array. */
export function toOpenAITools(tools: McpTool[]): Array<Record<string, unknown>> {
    return tools.map(t => ({
        type: 'function',
        function: { name: t.qualifiedName, description: t.description, parameters: t.inputSchema },
    }));
}

interface StreamResult { finishReason: string; toolCalls: OAToolCall[]; text: string; }

// A message that opens with one of these is (very likely) a tool call the server failed to parse
// into native `tool_calls` — a broken/undetected chat template. Local GGUFs vary wildly here
// (e.g. Qwen2.5-Coder-32B emits `<tools>{…}</tools>` instead of `<tool_call>…`, so llama.cpp's
// lazy grammar never triggers). We buffer such an opener instead of streaming it as visible text,
// then reparse it below — a model-agnostic safety net so local tools work regardless of template.
const TOOL_OPENER = /^(<tool_call>|<tools>|<function_call>|<function|\{\s*"name"\s*:)/i;

/** Extract tool calls from message content when the server returned them as text, not tool_calls. */
function parseInlineToolCalls(raw: string, tagsOnly = false): Array<{ name: string; arguments: string }> {
    const out: Array<{ name: string; arguments: string }> = [];
    const s = raw.replace(/```(?:json|xml|tool_call)?/gi, '').replace(/```/g, '').trim();
    const tryObj = (str: string): boolean => {
        const i = str.indexOf('{'), j = str.lastIndexOf('}');
        if (i < 0 || j <= i) return false;
        let o: { name?: unknown; arguments?: unknown; parameters?: unknown };
        try { o = JSON.parse(str.slice(i, j + 1)); } catch { return false; }
        if (!o || typeof o.name !== 'string') return false;
        const args = o.arguments ?? o.parameters ?? {};
        out.push({ name: o.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
        return true;
    };
    const tagRe = /<(tool_call|tools|function_call|function)>\s*([\s\S]*?)\s*<\/\1>/gi;
    let m: RegExpExecArray | null, sawTag = false;
    while ((m = tagRe.exec(s)) !== null) { sawTag = true; tryObj(m[2]); }

    // Llama-3.1 / Hermes attribute style, which carries NO json at all:
    //   <function=tool_name><parameter=key>value</parameter>…</function>
    // Ornith falls into this the moment a tool returns an error, so without it the
    // model retries forever in a format nothing executes and the turn looks hung.
    const fnRe = /<function\s*=\s*([A-Za-z0-9_.-]+)\s*>([\s\S]*?)(?:<\/function>|$)/gi;
    while ((m = fnRe.exec(s)) !== null) {
        const name = m[1];
        const args: Record<string, unknown> = {};
        const pRe = /<parameter\s*=\s*([A-Za-z0-9_.-]+)\s*>([\s\S]*?)(?:<\/parameter>|$)/gi;
        let p: RegExpExecArray | null;
        while ((p = pRe.exec(m[2])) !== null) {
            const v = p[2].trim();
            // numbers/bools arrive as bare text here; keep JSON types so schemas validate
            args[p[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v)
                : v === 'true' ? true : v === 'false' ? false : v;
        }
        if (Object.keys(args).length || name) { sawTag = true; out.push({ name, arguments: JSON.stringify(args) }); }
    }

    // The bare-JSON guess is only safe on CONTENT we already decided looks like a tool call.
    // Never on reasoning: chain-of-thought routinely contains JSON examples, and treating one
    // as a call invents a tool, gets "Unknown tool", and spins the loop to its iteration cap.
    if (!sawTag && !tagsOnly) tryObj(s);
    return out;
}

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
    let reasonBuf = '';      // reasoning is scanned for tool calls too — see the tail of this fn
    let finishReason = 'stop';

    // Reasoning models stream chain-of-thought as `reasoning_content` (llama.cpp) or
    // `reasoning` (OpenRouter), never as `content`. It used to be streamed as markdown
    // blockquote lines, which rendered at the same weight as the answer — the model's
    // throat-clearing outranking its conclusion. The webview already has a collapsed
    // <details> block for this, so send the dedicated event and let it own presentation.
    let inThink = false;
    const onReasoning = (r: string) => {
        inThink = true;
        send({ type: 'thinking', text: r });
    };
    /** Close the thought before anything visible follows it. Idempotent. */
    const closeThink = () => {
        if (!inThink) return;
        inThink = false;
        send({ type: 'thinking_end' });
    };

    // Content emission is deferred until we know whether the message is prose (stream it live) or a
    // mis-formatted tool call (buffer it, reparse at the end). `mode` starts undecided; we peek at the
    // leading non-whitespace chars. `emitted` tracks how much of `text` has been sent as visible.
    let mode: 'undecided' | 'prose' | 'toolbuf' = 'undecided';
    let emitted = 0;
    const flushProse = () => { const tail = text.slice(emitted); if (tail) { closeThink(); send({ type: 'assistant_text_delta', text: tail }); emitted = text.length; } };
    const onContent = () => {
        if (mode === 'prose') { flushProse(); return; }
        if (mode === 'toolbuf') return;
        const lead = text.replace(/^\s+/, '');
        if (!lead) return;                                   // only whitespace so far — wait
        if (lead[0] !== '<' && lead[0] !== '{') { mode = 'prose'; flushProse(); return; }  // clearly prose
        if (lead.length < 12) return;                        // maybe a tool opener split across deltas — peek more
        if (TOOL_OPENER.test(lead)) mode = 'toolbuf';
        else { mode = 'prose'; flushProse(); }
    };

    const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, tools, stream: true }),
        signal,
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        // The context-overflow 400 is common enough to deserve a sentence rather than a
        // JSON blob — it tells you what to do (raise the window) instead of what broke.
        let msg = `${resp.status}: ${body.slice(0, 300)}`;
        const over = body.match(/request \((\d+) tokens\) exceeds the available context size \((\d+)/);
        if (over) {
            msg = `This conversation reached the model's ${(+over[2] / 1024).toFixed(0)}k context window `
                + `(needed ${(+over[1] / 1024).toFixed(0)}k). Older tool output is dropped automatically, `
                + `but a single request can still be too large. Start a new conversation, or raise the `
                + `context size in Settings if there's VRAM spare.`;
        }
        send({ type: 'error', message: msg });
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
                let obj: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }> };
                try { obj = JSON.parse(payload); } catch { continue; }
                const choice = obj.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta;
                const reasoning = delta?.reasoning_content ?? delta?.reasoning;
                if (reasoning) { reasonBuf += reasoning; onReasoning(reasoning); }
                if (delta?.content) { text += delta.content; onContent(); }
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

    // Stream ended while still undecided (short message): decide now.
    if (mode === 'undecided') {
        const lead = text.replace(/^\s+/, '');
        if (lead && TOOL_OPENER.test(lead)) mode = 'toolbuf';
        else { mode = 'prose'; flushProse(); }
    }

    const toolCalls: OAToolCall[] = [...acc.values()]
        .filter(s => s.name)
        .map(s => ({ id: s.id || `call_${s.name}`, type: 'function', function: { name: s.name, arguments: s.arguments || '{}' } }));

    // Server gave no native tool_calls but the buffered content looks like a tool call — reparse it.
    if (toolCalls.length === 0 && mode === 'toolbuf') {
        const inline = parseInlineToolCalls(text);
        if (inline.length) {
            inline.forEach((c, i) => toolCalls.push({ id: `call_inline_${i}_${c.name}`.slice(0, 40), type: 'function', function: { name: c.name, arguments: c.arguments } }));
            closeThink();
            return { finishReason: 'tool_calls', toolCalls, text: '' };   // text was the tool call, not prose
        }
        flushProse();   // false alarm (opened with '<' or '{' but wasn't a tool call) — show it after all
    }
    // Last resort: the model put its tool call inside the REASONING stream and emitted no
    // usable content. Nothing downstream ever looks there, so the turn would end silently
    // and the user just sees the attempt quoted as prose — which reads as a hang.
    if (toolCalls.length === 0 && reasonBuf) {
        for (const c of parseInlineToolCalls(reasonBuf, true)) {
            toolCalls.push({ id: `call_reason_${toolCalls.length}_${c.name}`.slice(0, 40),
                type: 'function', function: { name: c.name, arguments: c.arguments } });
        }
        if (toolCalls.length) finishReason = 'tool_calls';
    }
    // A round that thought and then called a tool emits no prose at all — close the quote
    // here so the tool card that follows isn't swallowed into the blockquote.
    closeThink();
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
    /** Server context window in tokens. Local llama.cpp HARD-FAILS a request that exceeds
     *  it (400 exceed_context_size_error), so the loop must compact before that happens.
     *  Omit for providers that slide their own window. */
    contextTokens?: number;
}

/** Rough token count. Deliberately pessimistic — under-counting is what gets us a 400. */
function estimateTokens(messages: Array<Record<string, unknown>>): number {
    let chars = 0;
    for (const m of messages) {
        chars += String(m.content ?? '').length;
        if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
        chars += 16;                                  // per-message role/framing overhead
    }
    return Math.ceil(chars / 3.2);                    // ~3.2 chars/token on code-heavy text
}

/**
 * Drop the oldest tool exchanges until the conversation fits.
 *
 * A long agentic run accumulates one assistant+tool pair per round, each up to the 24k-char
 * tool cap, so it will always reach the window eventually — 50 rounds cannot fit in 64k.
 * The system prompt and the user's original request are never dropped; neither are the most
 * recent rounds, which is where the model's working state lives. Elided rounds leave a
 * marker so the model knows history is missing rather than assuming it never happened.
 */
async function compactHistory(convo: Array<Record<string, unknown>>, budget: number, opts: AgenticOpts): Promise<void> {
    if (estimateTokens(convo) <= budget) return;

    const firstUser = convo.findIndex(m => m.role === 'user');
    const keepHead = firstUser >= 0 ? firstUser + 1 : 1;   // system prompt + original request
    const KEEP_TAIL = 6;                                   // last few rounds stay intact

    const evicted: Array<Record<string, unknown>> = [];
    while (estimateTokens(convo) > budget && convo.length > keepHead + KEEP_TAIL) {
        evicted.push(convo.splice(keepHead, 1)[0]);
    }
    if (!evicted.length) return;

    opts.send({ type: 'thinking', text: `\nCompacting ${evicted.length} earlier messages…\n` });
    const digest = await summarize(evicted, opts);
    opts.send({ type: 'thinking_end' });

    convo.splice(keepHead, 0, {
        role: 'system',
        content: digest
            ? `[Summary of ${evicted.length} earlier messages, compacted to fit the context window. `
                + `Treat it as a record of what happened, not as verbatim tool output — re-read a file `
                + `if you need its exact contents.]\n\n${digest}`
            // Summarising is itself a model call and can fail; losing the detail is better
            // than losing the conversation, so fall back to saying it went.
            : `[${evicted.length} earlier tool exchanges were dropped to stay within the context window. `
                + `Re-read the file or re-run the command rather than relying on memory.]`,
    });
}

/**
 * Ask the model to turn the messages we are about to lose into a factual digest.
 * Non-streaming, no tools, small budget — this is a side call, not a turn.
 */
async function summarize(evicted: Array<Record<string, unknown>>, opts: AgenticOpts): Promise<string | null> {
    const raw = evicted.map((m) => {
        const role = String(m.role ?? '?');
        if (m.tool_calls) {
            const calls = (m.tool_calls as Array<{ function: { name: string; arguments: string } }>)
                .map(c => `${c.function.name}(${String(c.function.arguments).slice(0, 200)})`).join(', ');
            return `${role}: called ${calls}`;
        }
        return `${role}: ${String(m.content ?? '').slice(0, 1500)}`;
    }).join('\n');

    // Keep BOTH ends when the evicted block is itself too big to summarise in one go.
    // A plain slice(0, N) keeps the oldest and throws away the newest — which is backwards:
    // the most recent evicted rounds are the ones the model is still working from. (Caught
    // by a 40k-char test where the failing pytest result at the end vanished from the digest.)
    const CAP = 40000, HEAD = 8000;
    const transcript = raw.length <= CAP ? raw
        : raw.slice(0, HEAD) + '\n…[middle elided]…\n' + raw.slice(-(CAP - HEAD));

    try {
        const resp = await fetch(opts.url, {
            method: 'POST',
            headers: opts.headers,
            signal: opts.signal,
            body: JSON.stringify({
                model: opts.model,
                stream: false,
                temperature: 0,
                max_tokens: 700,
                messages: [
                    { role: 'system', content:
                        'You compact an agent transcript so work can continue after the detail is discarded. '
                        + 'Write terse factual notes under these headings, omitting any that do not apply: '
                        + 'Goal. Done. Learned (exact paths, values, IDs, error text worth keeping). '
                        + 'Failed (what was tried and why it did not work, so it is not retried). Open. '
                        + 'No preamble, no praise, no speculation.' },
                    { role: 'user', content: transcript },
                ],
            }),
        });
        if (!resp.ok) return null;
        const j = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        const out = j.choices?.[0]?.message?.content?.trim();
        return out || null;
    } catch { return null; }        // aborted or offline — caller falls back
}

/** Run the tool-calling loop. Terminal events mirror queryOR: assistant_text_delta… then `done`. */
/**
 * True when the model announced an action but never emitted the call for it.
 *
 * Open-weight models trained to narrate before acting will sometimes end the turn on the
 * narration alone — "Let me check the actual state of this machine" — and stop. The loop
 * reads zero tool calls as a finished answer and hands control back, leaving the user
 * holding an intention that never happened, having to prompt again for the call that was
 * already promised.
 *
 * Deliberately narrow: an intent phrase followed by an ACTION verb, in the last sentence
 * only. "I will call you Clifford" states no action, a closing "let me know" is a sign-off,
 * and a trailing question is addressed to the user — all three are real ends of turn.
 */
function announcedAction(text: string): boolean {
    const t = text.trimEnd();
    if (!t || /\?$/.test(t)) { return false; }
    const last = t.split(/(?<=[.!?])\s+/).pop() ?? t;
    const INTENT = /\b(?:let me|let us|let's|i'll|i will|i am going to|i'm going to|going to|one (?:sec|second|moment))\b[^.!?]{0,20}?\b(check|look|read|search|find|see|grab|pull|fetch|get|run|scan|inspect|verify|confirm|dig|explore|review|examine|list|open|load|start|try|test|query|write|save|create|update|build|make|add|fix|do)\b(?!\s+you\b)/i;
    return INTENT.test(last);
}
export async function runAgenticQuery(opts: AgenticOpts): Promise<void> {
    const oaTools = toOpenAITools(opts.tools);
    const convo = opts.messages.slice();
    const permit = opts.permit;

    // Signatures of tool calls that already came back as errors. A model that ignores the
    // error text and reissues the identical call will otherwise burn every iteration on it
    // (observed: Ornith retrying read_text_file with head AND tail after being told it can't
    // use both). Second time round we refuse it and say so, which is cheaper than 50 rounds.
    const failed = new Set<string>();
    try {
        let hitCap = true;
        let nudges = 0;
        // Leave a quarter of the window for the reply and the tool schemas; the request must
        // fit the whole thing, not just the prompt.
        const budget = opts.contextTokens ? Math.floor(opts.contextTokens * 0.72) : 0;
        for (let iter = 0; iter < MAX_ITERS; iter++) {
            if (budget) await compactHistory(convo, budget, opts);
            const { toolCalls, text, finishReason } = await streamChat(opts.url, opts.headers, opts.model, convo, oaTools, opts.send, opts.signal);
            if (opts.signal?.aborted) { return; }
            if (toolCalls.length === 0) {
                // An empty tool-call list is NOT automatically a finished answer. A turn ends
                // with the work still undone in two ways: the response was cut off mid-call, or
                // the model described the action and stopped without making it. Both used to hand
                // back a dangling intention and make the user type "continue" to get what was
                // already promised. Nudge it back on task — bounded, so a genuinely final answer
                // that merely sounds like a plan cannot spin in here.
                const truncated = finishReason === 'length';
                if (finishReason !== 'error' && (truncated || announcedAction(text)) && nudges < MAX_NUDGES) {
                    nudges++;
                    convo.push({ role: 'assistant', content: text || '(no output)' });
                    convo.push({ role: 'user', content: truncated
                        ? 'Your previous message was cut off mid-sentence. Continue from exactly where you stopped.'
                        : 'You described an action but never performed it. Make that tool call now — do not restate the plan.' });
                    continue;
                }
                hitCap = false; break;
            }
            nudges = 0;   // real progress; a later stall in the same task gets its own nudges

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
                } else if (failed.has(name + ' ' + tc.function.arguments)) {
                    content = `You already called ${name} with exactly these arguments and it failed. `
                        + `Do not repeat it — change the arguments or use a different approach.`;
                    isError = true;
                } else {
                    const r = await opts.callTool(name, args);
                    content = r.text || (r.isError ? 'Tool returned an error.' : '(no output)');
                    isError = r.isError;
                    if (isError) failed.add(name + ' ' + tc.function.arguments);
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
