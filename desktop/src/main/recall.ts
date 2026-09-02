import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Search past conversations.
 *
 * JAC already persists every conversation to ~/.jac/conversations, and the model already
 * has filesystem and shell tools, so it *could* grep them. It shouldn't have to: the store
 * is ~13 MB of JSON across 50 files, and any honest grep either floods the 24k-char tool
 * cap with raw JSON or truncates to uselessness. This returns dated snippets instead —
 * same answer, a hundredth of the context, and identical every time rather than whatever
 * pipeline the model improvises on the day.
 *
 * Worth knowing: compaction never touches these files. It trims the LIVE context only
 * (the loop works on a copy), so what is on disk is always the complete record — which is
 * exactly what makes recall a real substitute for a bigger context window.
 */

const CONV_DIR = path.join(os.homedir(), '.jac', 'conversations');
const MAX_OUT = 14000;          // stay well inside the 24k tool-result cap
const SNIPPET = 260;            // chars of context around a hit
const PER_CONV = 3;             // cap hits per conversation so one thread cannot crowd out others

interface Msg { role?: string; text?: string; content?: string; timestamp?: number }
interface Entry { id: string; title?: string; workspace?: string; timestamp?: number; model?: string }

function readIndex(): Entry[] {
    try { return JSON.parse(fs.readFileSync(path.join(CONV_DIR, 'index.json'), 'utf8')) as Entry[]; }
    catch { return []; }
}

function body(m: Msg): string {
    return String(m.text ?? m.content ?? '');
}

/** Folder name only — full paths are too long to scan down a list of results. */
function tag(ws?: string): string {
    if (!ws || ws === 'global') { return 'unfiled'; }
    return ws.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
}

const day = (t?: number): string =>
    (t ? new Date(t).toISOString().slice(0, 10) : '????-??-??');

/** One line of context around the first hit, with the message trimmed either side. */
function snippet(text: string, terms: string[]): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    const low = flat.toLowerCase();
    let at = -1;
    for (const t of terms) {
        const i = low.indexOf(t);
        if (i >= 0 && (at < 0 || i < at)) { at = i; }
    }
    if (at < 0) { return flat.slice(0, SNIPPET); }
    const from = Math.max(0, at - Math.floor(SNIPPET / 3));
    const out = flat.slice(from, from + SNIPPET);
    return (from > 0 ? '…' : '') + out + (from + SNIPPET < flat.length ? '…' : '');
}

export interface RecallArgs {
    query?: string;
    conversation?: string;
    scope?: string;
    limit?: number;
    context?: number;
}

interface Hit { id: string; title: string; ws: string; ts: number; role: string; text: string; after: string[] }

export function recall(a: RecallArgs, projectDir: string): string {
    if (!fs.existsSync(CONV_DIR)) { return 'No saved conversations yet.'; }
    const index = readIndex();
    const meta = new Map(index.map(e => [e.id, e]));
    const files = fs.readdirSync(CONV_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');

    // ── read one conversation whole ──────────────────────────────────────────
    if (a.conversation) {
        const id = a.conversation.replace(/\.json$/i, '');
        const f = path.join(CONV_DIR, id + '.json');
        if (!fs.existsSync(f)) { return `No conversation with id "${id}". Search first to get an id.`; }
        let msgs: Msg[] = [];
        try { msgs = JSON.parse(fs.readFileSync(f, 'utf8')) as Msg[]; } catch { return 'That conversation file is unreadable.'; }
        const e = meta.get(id);
        const head = `${day(e?.timestamp)}  ${e?.title ?? '(untitled)'}  [${tag(e?.workspace)}]  ${msgs.length} messages\n\n`;
        let out = head;
        for (const m of msgs) {
            const line = `${m.role ?? '?'}: ${body(m).replace(/\s+/g, ' ').trim()}\n`;
            if (out.length + line.length > MAX_OUT) {
                out += `\n…[truncated — ${msgs.length} messages total; search with a query to jump to a part]`;
                break;
            }
            out += line;
        }
        return out;
    }

    // ── search ───────────────────────────────────────────────────────────────
    const q = (a.query ?? '').trim();
    if (!q) { return 'recall needs either a query or a conversation id.'; }
    // All terms must appear in the same message. Quoted runs stay together.
    const terms = (q.match(/"[^"]+"|\S+/g) ?? [])
        .map(t => t.replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);

    const all = a.scope === 'all';
    const here = projectDir ? projectDir.replace(/[\\/]+$/, '').toLowerCase() : '';
    const hits: Hit[] = [];
    let scannedConvs = 0, scannedMsgs = 0, skipped = 0;

    for (const f of files) {
        const id = f.replace(/\.json$/i, '');
        const e = meta.get(id);
        const ws = (e?.workspace ?? '').replace(/[\\/]+$/, '').toLowerCase();
        // Default to this project, because "what did we decide" almost always means here.
        if (!all && here && ws !== here) { skipped++; continue; }

        let msgs: Msg[] = [];
        try { msgs = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8')) as Msg[]; } catch { continue; }
        if (!Array.isArray(msgs)) { continue; }
        scannedConvs++; scannedMsgs += msgs.length;

        let ts = e?.timestamp ?? 0;
        if (!ts) { try { ts = fs.statSync(path.join(CONV_DIR, f)).mtimeMs; } catch { ts = 0; } }
        const title = e?.title || body(msgs.find(m => m.role === 'user') ?? {}).slice(0, 56) || '(untitled)';

        let found = 0;
        for (let i = 0; i < msgs.length && found < PER_CONV; i++) {
            const text = body(msgs[i]);
            if (!text) { continue; }
            const low = text.toLowerCase();
            if (!terms.every(t => low.includes(t))) { continue; }
            found++;
            const ctx = Math.max(0, Math.min(3, Number(a.context) || 1));
            hits.push({
                id, title, ws: tag(e?.workspace), ts,
                role: String(msgs[i].role ?? '?'),
                text: snippet(text, terms),
                after: msgs.slice(i + 1, i + 1 + ctx)
                    .map(m => `${m.role ?? '?'}: ${body(m).replace(/\s+/g, ' ').trim().slice(0, 200)}`)
                    .filter(s => s.length > 6),
            });
        }
    }

    if (!hits.length) {
        const where = all ? 'any conversation' : `this project (${scannedConvs} conversations)`;
        return `No match for "${q}" in ${where}.`
            + (!all && skipped ? ` ${skipped} conversations from other folders were not searched — retry with scope="all".` : '')
            + ' Search terms are ANDed and matched literally; try fewer or broader words.';
    }

    // Newest first: recall is nearly always "what did we say about this", not "find the oldest".
    hits.sort((x, y) => y.ts - x.ts);
    const limit = Math.max(1, Math.min(25, Number(a.limit) || 8));
    const shown = hits.slice(0, limit);

    let out = `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${q}" `
        + `across ${scannedConvs} conversation${scannedConvs === 1 ? '' : 's'} (${scannedMsgs} messages)`
        + (!all && skipped ? `; ${skipped} from other folders skipped — scope="all" to include them` : '') + '\n';
    for (const h of shown) {
        const block = `\n[${day(h.ts)}] ${h.title}  ·  ${h.ws}  ·  id ${h.id}\n`
            + `  ${h.role}: ${h.text}\n`
            + h.after.map(s => `  ${s}\n`).join('');
        if (out.length + block.length > MAX_OUT) { out += '\n…[more matches truncated — narrow the query]'; break; }
        out += block;
    }
    if (shown.length < hits.length) { out += `\n(${hits.length - shown.length} further matches not shown)`; }
    out += '\n\nPass conversation="<id>" to read one in full.';
    return out;
}
