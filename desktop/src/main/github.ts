import { execFile } from 'child_process';

/**
 * GitHub access through the user's own `gh` CLI.
 *
 * JAC shipped with no GitHub tool at all, so when asked to look at a repo the model
 * correctly reported it had no credentials — while an authenticated `gh` sat on the
 * machine the whole time. Shelling out to it means JAC never handles a token: gh keeps
 * it in the OS keyring, and we inherit whatever login the user already has.
 *
 * Read-only by design. Every op is a GET; nothing here can open, close, merge or delete
 * anything, so an agent loop cannot mutate the user's repos as a side effect of looking.
 */

export class GhMissing extends Error {}
export class GhUnauthorized extends Error {}

const MAX_OUT = 20000;

function run(args: string[], timeoutMs = 45000): Promise<string> {
    return new Promise((resolve, reject) => {
        // execFile, not exec: args go across as an array, so a repo name or search query
        // containing shell metacharacters cannot break out into a command line.
        execFile('gh', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
                if (!err) { resolve(String(stdout || '')); return; }
                const msg = String(stderr || '').trim();
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    reject(new GhMissing('The GitHub CLI (gh) is not installed on this machine.'));
                } else if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(msg)) {
                    reject(new GhUnauthorized(msg));
                } else {
                    reject(new Error(msg || String(err.message)));
                }
            });
    });
}

type Row = Record<string, unknown>;

function parse(out: string): Row[] {
    const t = out.trim();
    if (!t) { return []; }
    const j = JSON.parse(t);
    return Array.isArray(j) ? j as Row[] : [j as Row];
}

/** First present, non-empty value among several candidate field names. */
function pick(r: Row, ...keys: string[]): string {
    for (const k of keys) {
        const v = r[k];
        if (v === null || v === undefined || v === '') { continue; }
        if (typeof v === 'object') {
            const o = v as Row;
            const n = o.name ?? o.login ?? o.nameWithOwner;
            if (n) { return String(n); }
            continue;
        }
        return String(v);
    }
    return '';
}

const day = (s: string): string => (s ? s.slice(0, 10) : '');

/**
 * Render rows as compact lines.
 *
 * `gh` names the same concept differently per subcommand — a repo is nameWithOwner in
 * `repo list` but fullName in `search repos` — so read every plausible key rather than
 * pinning one and silently printing blanks when the shape shifts.
 */
function table(rows: Row[], kind: string): string {
    if (!rows.length) { return 'No results.'; }
    return rows.map((r, i) => {
        const n = i + 1;
        if (kind === 'code') {
            return `${n}. ${pick(r, 'repository')}/${pick(r, 'path')}`;
        }
        if (kind === 'issue') {
            const repo = pick(r, 'repository');
            const head = `${n}. ${repo ? repo + ' ' : ''}#${pick(r, 'number')} ${pick(r, 'title')}`;
            const meta = [pick(r, 'state'), pick(r, 'author'), day(pick(r, 'updatedAt', 'createdAt'))]
                .filter(Boolean).join(' · ');
            const url = pick(r, 'url');
            return `${head}${meta ? '\n   ' + meta : ''}${url ? '\n   ' + url : ''}`;
        }
        const stars = pick(r, 'stargazerCount', 'stargazersCount');
        const bits = [
            pick(r, 'primaryLanguage', 'language'),
            r.isPrivate === true ? 'private' : '',
            stars && stars !== '0' ? stars + ' stars' : '',
            day(pick(r, 'updatedAt', 'pushedAt')),
        ].filter(Boolean).join(' · ');
        const desc = pick(r, 'description');
        return `${n}. ${pick(r, 'nameWithOwner', 'fullName', 'name')}${bits ? '  (' + bits + ')' : ''}`
            + `${desc ? '\n   ' + desc : ''}`;
    }).join('\n');
}

export interface GhArgs {
    op: string;
    query?: string;
    repo?: string;
    owner?: string;
    path?: string;
    ref?: string;
    state?: string;
    endpoint?: string;
    limit?: number;
}

export async function github(a: GhArgs): Promise<string> {
    const lim = String(Math.max(1, Math.min(100, Number(a.limit) || 20)));
    const q = (a.query || '').trim();
    const need = (v: string | undefined, what: string): string => {
        const s = (v || '').trim();
        if (!s) { throw new Error(`op "${a.op}" needs ${what}.`); }
        return s;
    };
    let out: string;

    switch (a.op) {
        case 'repos': {
            const args = ['repo', 'list'];
            if (a.owner) { args.push(a.owner); }
            args.push('--limit', lim, '--json',
                'nameWithOwner,description,isPrivate,primaryLanguage,updatedAt,stargazerCount');
            out = table(parse(await run(args)), 'repo');
            break;
        }
        case 'search_repos': {
            const args = ['search', 'repos', need(q, 'a query'), '--limit', lim,
                '--json', 'fullName,description,language,stargazersCount,updatedAt'];
            if (a.owner) { args.push('--owner', a.owner); }
            out = table(parse(await run(args)), 'repo');
            break;
        }
        case 'search_code': {
            const args = ['search', 'code', need(q, 'a query'), '--limit', lim, '--json', 'path,repository'];
            if (a.owner) { args.push('--owner', a.owner); }
            if (a.repo) { args.push('--repo', a.repo); }
            const rows = parse(await run(args));
            // GitHub code search only indexes pushed default branches, never local-only work.
            // Say that outright, or an empty list reads as "the code does not exist".
            out = rows.length ? table(rows, 'code')
                : 'No code results. GitHub code search only covers pushed default branches — '
                  + 'code that exists only on this machine will never appear here.';
            break;
        }
        case 'issues':
        case 'prs': {
            const args = ['search', a.op === 'prs' ? 'prs' : 'issues'];
            if (q) { args.push(q); }
            if (a.repo) { args.push('--repo', a.repo); }
            else if (a.owner) { args.push('--owner', a.owner); }
            const state = a.state === 'closed' ? 'closed' : a.state === 'all' ? 'all' : 'open';
            args.push('--limit', lim, '--state', state,
                '--json', 'number,title,state,repository,author,updatedAt,url');
            out = table(parse(await run(args)), 'issue');
            break;
        }
        case 'read': {
            const repo = need(a.repo, 'a repo as owner/name');
            const path = need(a.path, 'a path');
            const ep = `repos/${repo}/contents/${path}`
                + (a.ref ? `?ref=${encodeURIComponent(a.ref)}` : '');
            out = await run(['api', ep, '-H', 'Accept: application/vnd.github.raw']);
            break;
        }
        case 'api': {
            const ep = need(a.endpoint, 'an endpoint such as "user" or "repos/owner/name"')
                .replace(/^\/+/, '');
            out = await run(['api', ep]);
            break;
        }
        default:
            throw new Error(`Unknown op "${a.op}". `
                + 'Use: repos, search_repos, search_code, issues, prs, read, api.');
    }

    return out.length > MAX_OUT
        ? out.slice(0, MAX_OUT)
            + `\n...[truncated at ${MAX_OUT} chars — narrow the query or read one specific path]`
        : out;
}

/** Who gh is logged in as, so the tool can state it rather than the model guessing. */
export async function whoami(): Promise<string | null> {
    try { return (await run(['api', 'user', '--jq', '.login'], 8000)).trim() || null; }
    catch { return null; }
}
