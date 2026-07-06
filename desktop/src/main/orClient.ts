export interface ORModel {
    id: string;
    label: string;
    provider_id: 'local-or';
    supportsTools?: boolean;   // model advertises OpenAI tool-calling (for MCP routing)
}

type SendFn = (msg: Record<string, unknown>) => void;

export interface ORCredits { totalCredits: number; totalUsage: number; remaining: number; }

// OpenRouter account balance: total purchased credits, total spent, and what's left.
export async function fetchORCredits(apiKey: string): Promise<ORCredits | null> {
    if (!apiKey) return null;
    try {
        const resp = await fetch('https://openrouter.ai/api/v1/credits', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!resp.ok) return null;
        const json = await resp.json() as { data?: { total_credits?: number; total_usage?: number } };
        const d = json.data ?? {};
        const totalCredits = typeof d.total_credits === 'number' ? d.total_credits : 0;
        const totalUsage = typeof d.total_usage === 'number' ? d.total_usage : 0;
        return { totalCredits, totalUsage, remaining: totalCredits - totalUsage };
    } catch {
        return null;
    }
}

export async function fetchORModels(apiKey: string): Promise<ORModel[]> {
    try {
        const resp = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!resp.ok) return [];
        const data = await resp.json() as { data: Array<{ id: string; name: string; supported_parameters?: string[] }> };
        return data.data.map(m => ({
            id: `or:${m.id}`,
            label: `${m.name} (OR)`,
            provider_id: 'local-or' as const,
            supportsTools: (m.supported_parameters ?? []).includes('tools'),
        }));
    } catch {
        return [];
    }
}

export async function queryOR(
    apiKey: string,
    modelId: string,
    messages: Array<{ role: string; content: string }>,
    send: SendFn,
    signal?: AbortSignal,
): Promise<void> {
    const strippedId = modelId.replace(/^or:/, '');

    let resp: Response;
    try {
        resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://jac.app',
                'X-Title': 'JAC',
            },
            body: JSON.stringify({ model: strippedId, messages, stream: true }),
            signal,
        });
    } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError') return;
        send({ type: 'error', message: `OR fetch failed: ${String(err)}` });
        return;
    }

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        send({ type: 'error', message: `OR ${resp.status}: ${body.slice(0, 200)}` });
        return;
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const chunk = line.slice(6).trim();
                if (chunk === '[DONE]') { send({ type: 'done' }); return; }
                try {
                    const parsed = JSON.parse(chunk) as { choices?: Array<{ delta?: { content?: string } }> };
                    const text = parsed.choices?.[0]?.delta?.content;
                    if (text) send({ type: 'assistant_text_delta', text });
                } catch { /* skip malformed SSE chunks */ }
            }
        }
    } catch (err: unknown) {
        if ((err as Error)?.name !== 'AbortError') {
            send({ type: 'error', message: `OR stream error: ${String(err)}` });
        }
    } finally {
        reader.releaseLock();
    }

    send({ type: 'done' });
}
