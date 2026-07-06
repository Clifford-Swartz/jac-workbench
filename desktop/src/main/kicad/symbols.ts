// KiCad install discovery + symbol-library catalog. Reads the real .kicad_sym libs shipped with KiCad.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { balanced, parse, kids, kid, num, Node } from './sexpr';

export interface KicadPaths { root: string; cli: string; symbolsDir: string; footprintsDir: string; }

/** Locate a KiCad install (per-user LocalAppData first, then Program Files). */
export function findKicad(): KicadPaths | null {
    const roots: string[] = [];
    const la = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'KiCad');
    for (const base of [la, 'C:\\Program Files\\KiCad', 'C:\\Program Files (x86)\\KiCad']) {
        try { for (const v of fs.readdirSync(base)) roots.push(path.join(base, v)); } catch { /* missing */ }
    }
    // also common non-Windows spots
    roots.push('/usr/bin', '/usr/local/bin', '/Applications/KiCad/KiCad.app/Contents/MacOS');
    for (const r of roots) {
        const cliWin = path.join(r, 'bin', 'kicad-cli.exe');
        const cliNix = path.join(r, 'bin', 'kicad-cli');
        const cliBare = path.join(r, 'kicad-cli');
        const cli = [cliWin, cliNix, cliBare].find((c) => fs.existsSync(c));
        if (!cli) continue;
        // symbols dir is under share/kicad/symbols relative to the install root (r may be the version dir)
        const shareCandidates = [
            path.join(r, 'share', 'kicad', 'symbols'),
            path.join(r, '..', 'share', 'kicad', 'symbols'),
            '/usr/share/kicad/symbols',
        ];
        const symbolsDir = shareCandidates.find((d) => fs.existsSync(d)) || '';
        return {
            root: r, cli,
            symbolsDir,
            footprintsDir: symbolsDir ? symbolsDir.replace(/symbols$/, 'footprints') : '',
        };
    }
    return null;
}

export interface CatalogEntry { libId: string; name: string; lib: string; libName: string; desc: string; keywords: string; }

let _catalog: CatalogEntry[] | null = null;

/** Scan every .kicad_sym once; index top-level symbols (name, description, keywords) for search. */
export function buildCatalog(symbolsDir: string): CatalogEntry[] {
    if (_catalog) return _catalog;
    const out: CatalogEntry[] = [];
    let files: string[] = [];
    try { files = fs.readdirSync(symbolsDir).filter((f) => f.endsWith('.kicad_sym')); } catch { return []; }
    for (const f of files) {
        const libName = f.replace(/\.kicad_sym$/, '');
        let text = '';
        try { text = fs.readFileSync(path.join(symbolsDir, f), 'utf8'); } catch { continue; }
        // top-level symbols are indented exactly one tab; unit sub-symbols are two.
        const re = /^\t\(symbol "([^"]+)"/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const name = m[1];
            const block = balanced(text, m.index + 1) || '';
            const desc = (block.match(/\(property "Description" "([^"]*)"/) || [, ''])[1] || '';
            const keywords = (block.match(/\(property "ki_keywords" "([^"]*)"/) || [, ''])[1] || '';
            out.push({ libId: `${libName}:${name}`, name, lib: path.join(symbolsDir, f), libName, desc, keywords });
        }
    }
    _catalog = out;
    return out;
}

/** Fuzzy-search the catalog by name/desc/keywords. */
export function searchCatalog(symbolsDir: string, query: string, limit = 15): CatalogEntry[] {
    const cat = buildCatalog(symbolsDir);
    const q = query.toLowerCase().trim();
    const terms = q.split(/\s+/).filter(Boolean);
    const scored = cat.map((e) => {
        const hay = `${e.libId} ${e.desc} ${e.keywords}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
            if (e.name.toLowerCase() === t) score += 100;
            else if (e.name.toLowerCase().includes(t)) score += 40;
            if (e.libId.toLowerCase().includes(t)) score += 20;
            if (hay.includes(t)) score += 5;
        }
        return { e, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.e);
}

/** Exact catalog lookup by libId ("Device:R"). */
export function resolveLibId(symbolsDir: string, libId: string): CatalogEntry | undefined {
    return buildCatalog(symbolsDir).find((e) => e.libId === libId);
}

/** Pull the full (symbol "NAME" ...) block out of a lib file — for embedding in lib_symbols. */
export function extractSymbol(libFile: string, name: string): string | null {
    const text = fs.readFileSync(libFile, 'utf8');
    const idx = text.indexOf(`(symbol "${name}"`);
    if (idx < 0) return null;
    return balanced(text, idx);
}

/** The reference designator prefix (R, C, U, J, D…) declared by a symbol. */
export function symbolRefPrefix(libFile: string, name: string): string {
    const sym = extractSymbol(libFile, name);
    if (!sym) return 'U';
    const m = sym.match(/\(property "Reference" "([^"]*)"/);
    return (m && m[1]) || 'U';
}

/** Default value a symbol ships with (its Value property). */
export function symbolDefaultValue(libFile: string, name: string): string {
    const sym = extractSymbol(libFile, name);
    if (!sym) return '';
    const m = sym.match(/\(property "Value" "([^"]*)"/);
    return (m && m[1]) || '';
}

/** Default footprint a symbol ships with ("lib:name"), if any. */
export function symbolDefaultFootprint(libFile: string, name: string): string {
    const sym = extractSymbol(libFile, name);
    if (!sym) return '';
    const m = sym.match(/\(property "Footprint" "([^"]*)"/);
    return (m && m[1]) || '';
}

export interface Pin { number: string; name: string; x: number; y: number; angle: number; length: number; }

export interface SymGraphics {
    rects: Array<[number, number, number, number]>;       // x1,y1,x2,y2
    polylines: Array<Array<[number, number]>>;
    circles: Array<{ x: number; y: number; r: number }>;
    arcs: Array<{ sx: number; sy: number; mx: number; my: number; ex: number; ey: number }>;
}

const _graphicsCache: Record<string, SymGraphics> = {};

/** Drawable primitives of a symbol (symbol-local mm coords, Y up) — for rendering on our own canvas. */
export function symbolGraphics(libFile: string, name: string): SymGraphics {
    const key = libFile + '::' + name;
    if (_graphicsCache[key]) return _graphicsCache[key];
    const g: SymGraphics = { rects: [], polylines: [], circles: [], arcs: [] };
    const text = extractSymbol(libFile, name);
    if (!text) { _graphicsCache[key] = g; return g; }
    const root = parse(text);
    const walk = (n: Node) => {
        for (const r of kids(n, 'rectangle')) { const a = kid(r, 'start')!, b = kid(r, 'end')!; g.rects.push([num(a[1]), num(a[2]), num(b[1]), num(b[2])]); }
        for (const p of kids(n, 'polyline')) { const pts = kid(p, 'pts'); if (pts) g.polylines.push(kids(pts, 'xy').map((xy) => [num(xy[1]), num(xy[2])] as [number, number])); }
        for (const c of kids(n, 'circle')) { const ctr = kid(c, 'center')!; g.circles.push({ x: num(ctr[1]), y: num(ctr[2]), r: num(kid(c, 'radius')![1]) }); }
        for (const a of kids(n, 'arc')) { const s = kid(a, 'start')!, m = kid(a, 'mid')!, e = kid(a, 'end')!; g.arcs.push({ sx: num(s[1]), sy: num(s[2]), mx: num(m[1]), my: num(m[2]), ex: num(e[1]), ey: num(e[2]) }); }
        for (const su of kids(n, 'symbol')) walk(su);
    };
    walk(root);
    _graphicsCache[key] = g;
    return g;
}

/** Pins declared in a symbol block, with positions (symbol-local mm coords, Y up). */
export function symbolPins(symText: string): Pin[] {
    const pins: Pin[] = [];
    const re = /\(pin\s+\S+\s+\S+\s*\n?\s*\(at\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\)\s*\n?\s*\(length\s+(-?[\d.]+)\)([\s\S]*?)\(number "([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(symText))) {
        const nameMatch = m[5].match(/\(name "([^"]*)"/);
        pins.push({ x: +m[1], y: +m[2], angle: +m[3], length: +m[4], name: nameMatch ? nameMatch[1] : '', number: m[6] });
    }
    return pins;
}
