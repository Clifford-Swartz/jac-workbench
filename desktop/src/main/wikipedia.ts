// Offline Wikipedia for JAC, served from a local Kiwix ZIM.
//
// Why: factual lookups were going through a scraped search engine, which can break
// whenever the site changes markup — DuckDuckGo's /html/ endpoint already did exactly
// that (it now answers HTTP 202 with a bot challenge). A ZIM has no network
// dependency, no rate limit, and ships its own full-text index, so search is
// sub-millisecond over ~7M articles.
//
// GOTCHA: kiwix-serve refuses a forward-slash path on Windows — "Unable to add the
// ZIM file to the internal library" — and accepts the identical file with
// backslashes. Paths handed to it are normalised below.
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;

export interface WikiHit { title: string; link: string; snippet: string; }

/** Locate kiwix-serve and a ZIM, honouring explicit config over the default layout. */
export function locate(cfg?: { exe?: string; zim?: string }): { exe: string; zim: string } | null {
    const exe = cfg?.exe && fs.existsSync(cfg.exe) ? cfg.exe
        : ['E:\\kiwix\\tools\\kiwix-serve.exe',
           path.join(os.homedir(), '.jac', 'kiwix', 'kiwix-serve.exe')].find(p => fs.existsSync(p));
    if (!exe) return null;

    if (cfg?.zim && fs.existsSync(cfg.zim)) return { exe, zim: cfg.zim };
    // Otherwise take the largest .zim in the kiwix folder — the full dump, not a test file.
    for (const dir of ['E:\\kiwix', path.join(os.homedir(), '.jac', 'kiwix')]) {
        try {
            const zims = fs.readdirSync(dir)
                .filter(f => f.toLowerCase().endsWith('.zim'))
                .filter(f => looksComplete(path.join(dir, f)))
                .map(f => ({ f: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
                .sort((a, b) => b.size - a.size);
            if (zims.length) return { exe, zim: zims[0].f };
        } catch { /* dir absent */ }
    }
    return null;
}

/**
 * Cheap sanity check before handing a file to kiwix-serve: real ZIMs start with the
 * magic 5A 49 4D 04, and an in-progress download of a 49 GB dump will happily be the
 * largest .zim in the folder while being unusable.
 */
function looksComplete(file: string): boolean {
    try {
        if (fs.statSync(file).size < 1_000_000) return false;
        const fd = fs.openSync(file, 'r');
        const b = Buffer.alloc(4);
        fs.readSync(fd, b, 0, 4, 0);
        fs.closeSync(fd);
        if (!(b[0] === 0x5a && b[1] === 0x49 && b[2] === 0x4d)) return false;
        // Magic alone is not enough: a partial download starts with the right bytes
        // because it is written sequentially from byte 0. If the file was touched in
        // the last minute it is probably still growing, so leave it alone.
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs < 60_000) return false;
        return !fs.existsSync(file + '.part');
    } catch { return false; }
}

async function alive(): Promise<boolean> {
    try {
        const r = await fetch(`${BASE}/catalog/v2/entries`, { signal: AbortSignal.timeout(2500) });
        return r.ok;
    } catch { return false; }
}

/** Start kiwix-serve if it isn't already up. Safe to call concurrently. */
export async function ensureServer(cfg?: { exe?: string; zim?: string }): Promise<boolean> {
    if (await alive()) return true;
    if (starting) return starting;

    starting = (async () => {
        const found = locate(cfg);
        if (!found) return false;
        // Backslashes, or kiwix-serve rejects the file outright on Windows.
        const zimArg = found.zim.replace(/\//g, '\\');
        server = spawn(found.exe, ['--port', String(PORT), '--address', '127.0.0.1', zimArg],
            { windowsHide: true, stdio: 'ignore' });
        server.on('exit', () => { server = null; });
        server.on('error', () => { server = null; });
        for (let i = 0; i < 40; i++) {                 // ZIMs this size take a moment to index-map
            await new Promise(r => setTimeout(r, 500));
            if (await alive()) return true;
        }
        return false;
    })();
    try { return await starting; } finally { starting = null; }
}

export function stopServer(): void {
    if (server) { try { server.kill(); } catch { /* gone */ } server = null; }
}

function tag(xml: string, name: string): string {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
    return m ? decode(m[1]).trim() : '';
}
function decode(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
}

/** Full-text search across the ZIM. Uses the OpenSearch feed, not the HTML page. */
export async function search(query: string, limit = 8): Promise<{ hits: WikiHit[]; total: number }> {
    const url = `${BASE}/search?pattern=${encodeURIComponent(query)}&format=xml&pageLength=${limit}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`kiwix search returned ${r.status}`);
    const xml = await r.text();
    const total = Number(/<opensearch:totalResults>(\d+)</.exec(xml)?.[1] ?? 0);
    const hits = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
        title: tag(m[1], 'title'),
        link: tag(m[1], 'link'),
        snippet: tag(m[1], 'description'),
    })).filter(h => h.title);
    return { hits, total };
}

/**
 * Read one article as plain text. `link` is what search returns
 * (`/content/<book>/<Article>`); a bare title is also accepted.
 */
export async function read(link: string, maxChars = 12000, find?: string): Promise<{ title: string; text: string; matched: boolean }> {
    const p = link.startsWith('/') ? link : `/search?pattern=${encodeURIComponent(link)}&format=xml&pageLength=1`;
    let target = p;
    if (!link.startsWith('/')) {
        const s = await search(link, 1);
        if (!s.hits.length) throw new Error(`no article matching "${link}"`);
        target = s.hits[0].link;
    }
    const r = await fetch(BASE + target, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`article fetch returned ${r.status}`);
    const html = await r.text();

    const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim() ?? target;
    const body = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|li|tr|h[1-6]|section|br)\s*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n');
    let text = decodeBlock(body)
        .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean)
        .join('\n').replace(/\n{3,}/g, '\n\n');

    let matched = false;
    if (find) {
        // Last match, not the first: a table of contents always matches before the
        // real section does, and returning that window gives the contents list.
        const hay = text.toLowerCase(), needle = find.toLowerCase();
        const at: number[] = [];
        for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) at.push(i);
        if (at.length) {
            matched = true;
            const start = Math.max(0, at[at.length - 1] - Math.floor(maxChars * 0.1));
            text = text.slice(start, start + maxChars);
        } else { text = text.slice(0, maxChars); }
    } else { text = text.slice(0, maxChars); }

    return { title, text, matched };
}

function decodeBlock(s: string): string {
    return s.replace(/<[^>]*>/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
