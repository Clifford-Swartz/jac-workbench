// Web search + page fetch for JAC.
//
// Why this exists: JAC had `playwright` but no search tool, so asking it to "google
// something" meant driving a real browser at google.com — straight into consent walls
// and bot detection. The model would report that results "didn't come back clearly",
// which was accurate and useless. A search API returns text in one call instead.
//
// DuckDuckGo's /lite/ endpoint is used: no API key, no account, and unlike
// html.duckduckgo.com it is not behind a bot challenge.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface SearchHit { title: string; url: string; snippet: string; }

function decodeEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
    return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Thrown when an engine REFUSES us, as distinct from genuinely having no results. */
/**
 * DuckDuckGo wraps every result href as /l/?uddg=<percent-encoded-target>. Unwrap it so
 * callers get a real URL they can hand straight to fetchUrl.
 */
function unwrap(href: string): string {
    try {
        const m = /[?&]uddg=([^&]+)/.exec(href);
        if (m) { return decodeURIComponent(m[1]); }
    } catch { /* malformed percent-encoding - fall through to the raw href */ }
    return href.startsWith("//") ? "https:" + href : href;
}

export class Blocked extends Error {
    constructor(public engine: string, public status: number) {
        // status 0 is the aggregate case (every engine refused) — that message is already
        // a full sentence, so do not bolt another clause onto it.
        super(status ? `${engine} refused the request (HTTP ${status})` : engine);
    }
}

/**
 * True when a response is a bot challenge rather than a result page.
 *
 * This distinction matters more than it looks. DuckDuckGo answers a throttled request
 * with HTTP 202 and a challenge page, which parses to zero results — and reporting that
 * as 'no results' tells the model the thing does not exist. That is exactly what sent it
 * off driving a browser by hand instead of waiting or trying another engine.
 */
function isChallenge(status: number, body: string): boolean {
    if (status === 202 || status === 429 || status === 403) { return true; }
    return /anomaly|captcha|unusual traffic|are you a robot/i.test(body)
        && !/result-link|class="ob"/.test(body);
}

async function ddgLite(query: string, limit: number): Promise<SearchHit[]> {
    const r = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query),
        { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await r.text();
    if (isChallenge(r.status, html)) { throw new Blocked('DuckDuckGo', r.status); }

    const links: Array<{ title: string; url: string }> = [];
    const linkRe = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(html)) !== null) {
        const url = unwrap(decodeEntities(lm[1]));
        const title = stripTags(lm[2]);
        if (title && /^https?:/i.test(url)) { links.push({ title, url }); }
    }
    const snippets: string[] = [];
    const snipRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = snipRe.exec(html)) !== null) { snippets.push(stripTags(sm[1])); }
    return links.slice(0, limit).map((l, i) => ({ ...l, snippet: snippets[i] ?? '' }));
}

async function mojeek(query: string, limit: number): Promise<SearchHit[]> {
    const r = await fetch('https://www.mojeek.com/search?q=' + encodeURIComponent(query),
        { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await r.text();
    if (isChallenge(r.status, html)) { throw new Blocked('Mojeek', r.status); }

    // <li class="rN"> ... <h2><a class="title" href=URL>Title</a></h2> ... <p class="s">snippet</p>
    const out: SearchHit[] = [];
    const liRe = /<li[^>]+class="r\d+"[^>]*>([\s\S]*?)<\/li>/gi;
    let m: RegExpExecArray | null;
    while ((m = liRe.exec(html)) !== null && out.length < limit) {
        const a = /<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(m[1]);
        if (!a) { continue; }
        const snip = /<p[^>]+class="s"[^>]*>([\s\S]*?)<\/p>/i.exec(m[1]);
        const url = decodeEntities(a[1]);
        if (!/^https?:/i.test(url)) { continue; }
        out.push({ title: stripTags(a[2]), url, snippet: snip ? stripTags(snip[1]) : '' });
    }
    return out;
}

/** Brave's real API — used only when a key is configured. No scraping, no challenge. */
async function brave(query: string, limit: number, key: string): Promise<SearchHit[]> {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?q='
        + encodeURIComponent(query) + '&count=' + limit,
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': key } });
    if (r.status === 429 || r.status === 403) { throw new Blocked('Brave', r.status); }
    if (!r.ok) { throw new Error('Brave returned ' + r.status); }
    const j = await r.json() as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
    return (j.web?.results ?? []).slice(0, limit)
        .map(x => ({ title: x.title, url: x.url, snippet: stripTags(x.description ?? '') }));
}

// Per-engine cooldowns and a minimum gap between requests.
//
// The model fires searches in bursts — five back-to-back while collecting a tracklist —
// and that burst is what trips the throttles in the first place. Once an engine has
// refused, hammering it again keeps the ban alive, so park it for a while and space
// requests out rather than racing.
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 90_000;
const MIN_GAP_MS = 1200;
let lastRequestAt = 0;

async function pace(): Promise<void> {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) { await new Promise(r => setTimeout(r, wait)); }
    lastRequestAt = Date.now();
}

/** Seconds until every engine is out of cooldown, for a useful error message. */
function coolingFor(names: string[]): number {
    const now = Date.now();
    const waits = names.map(n => Math.max(0, (cooldownUntil.get(n) ?? 0) - now));
    return Math.ceil(Math.min(...waits) / 1000);
}

/**
 * Search the web, trying engines in order until one answers.
 *
 * Scraped engines throttle under sustained use: DuckDuckGo's /html/ endpoint sits behind
 * a permanent challenge, and /lite/ starts refusing after a burst of queries — which is
 * what made this tool look 'intermittently flaky'. One backend is not dependable, so try
 * the next; and if EVERY engine refuses, throw rather than return an empty list that
 * reads as 'nothing exists'.
 */
export async function webSearch(query: string, limit = 8, braveKey?: string): Promise<SearchHit[]> {
    const engines: Array<[string, () => Promise<SearchHit[]>]> = [];
    if (braveKey) { engines.push(['Brave', () => brave(query, limit, braveKey)]); }
    engines.push(['DuckDuckGo', () => ddgLite(query, limit)]);
    engines.push(['Mojeek', () => mojeek(query, limit)]);

    const refused: string[] = [];
    const now = Date.now();
    for (const [name, run] of engines) {
        // Still parked from a previous refusal — do not poke it, that only extends the ban.
        if ((cooldownUntil.get(name) ?? 0) > now) { refused.push(name + ' (cooling down)'); continue; }
        try {
            await pace();
            const hits = await run();
            if (hits.length) { return hits; }
            // A clean response with nothing in it is a real empty result for that engine;
            // keep going, since engines disagree, but do not count it as a refusal.
        } catch (e) {
            if (e instanceof Blocked) { cooldownUntil.set(name, Date.now() + COOLDOWN_MS); }
            refused.push(e instanceof Blocked ? name : name + ' (' + (e as Error).message + ')');
        }
    }
    if (refused.length === engines.length) {
        const secs = coolingFor(engines.map(([n]) => n));
        throw new Blocked('every engine refused: ' + refused.join(', ')
            + (secs > 0 ? '. Retry in about ' + secs + ' seconds.' : '.'), 0);
    }
    return [];
}

/**
 * Fetch a page and reduce it to readable text.
 *
 * `find` matters more than it looks: long pages (a Wikipedia article, a changelog)
 * push the interesting part well past any sane character cap, so a plain truncation
 * returns the intro and drops what was actually being looked for. Given `find`, the
 * window is centred on the first match instead of the top of the document.
 */
export async function fetchUrl(url: string, maxChars = 12000, find?: string): Promise<{ text: string; finalUrl: string; type: string; matched: boolean }> {
    if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
    const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow',
    });
    const type = (resp.headers.get('content-type') || '').split(';')[0].trim();
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} — ${raw.slice(0, 200)}`);

    // Non-HTML (JSON, plain text, markdown) is already what we want.
    if (type && !/html/i.test(type)) {
        const w = window(raw, maxChars, find);
        return { text: w.text, finalUrl: resp.url, type, matched: w.matched };
    }

    const body = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        // keep block boundaries as newlines so lists and tables stay readable
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n');

    const text = decodeEntities(body.replace(/<[^>]*>/g, ' '))
        .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        // Strip template noise — MediaWiki renders {{cite ...}} and {"wt":...} parser
        // data as visible text, which buries the real content.
        .filter(l => !/\{\{cite|\{"wt"\s*:|"wt"\s*:\s*"/.test(l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');

    const w = window(text, maxChars, find);
    return { text: w.text, finalUrl: resp.url, type: type || 'text/html', matched: w.matched };
}

/**
 * Centre the returned slice on `find`, else take it from the top.
 *
 * Picks the LAST occurrence rather than the first: on any page with a table of
 * contents the nav entry matches before the real section, and returning that window
 * gives you the contents list instead of the content.
 */
function window(text: string, maxChars: number, find?: string): { text: string; matched: boolean } {
    if (!find) return { text: text.slice(0, maxChars), matched: false };
    const hay = text.toLowerCase();
    const needle = find.toLowerCase();
    const at: number[] = [];
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) at.push(i);
    if (!at.length) return { text: text.slice(0, maxChars), matched: false };
    // Last match, unless that would start past the end of the useful text.
    const chosen = at[at.length - 1];
    // Bias the window forward — what you want sits below the heading you matched.
    const start = Math.max(0, chosen - Math.floor(maxChars * 0.1));
    return { text: text.slice(start, start + maxChars), matched: true };
}
