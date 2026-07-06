// KiCad S-expression parse / serialize / balanced-extract. Universal across .kicad_sym / .kicad_sch / .kicad_pcb.

export type Atom = string | { s: string };          // { s } = quoted string
export type Node = Array<Atom | Node>;

export function tokenize(s: string): Array<Atom | '(' | ')'> {
    const t: Array<Atom | '(' | ')'> = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '(' || c === ')') { t.push(c); i++; }
        else if (c === '"') {
            let j = i + 1, str = '';
            while (j < s.length && s[j] !== '"') { if (s[j] === '\\') { str += s[j + 1]; j += 2; } else { str += s[j]; j++; } }
            t.push({ s: str }); i = j + 1;
        } else if (/\s/.test(c)) { i++; }
        else { let j = i; while (j < s.length && !/[\s()"]/.test(s[j])) j++; t.push(s.slice(i, j)); i = j; }
    }
    return t;
}

export function parse(text: string): Node {
    const toks = tokenize(text);
    let i = 0;
    function node(): Node {
        i++; // (
        const list: Node = [];
        while (i < toks.length && toks[i] !== ')') {
            if (toks[i] === '(') list.push(node());
            else list.push(toks[i++] as Atom);
        }
        i++; // )
        return list;
    }
    while (i < toks.length && toks[i] !== '(') i++;
    return node();
}

export const isStr = (x: unknown): x is { s: string } => !!x && typeof x === 'object' && 's' in (x as object);
export const val = (x: Atom | Node | undefined): string => (isStr(x) ? x.s : String(x ?? ''));
export const tag = (n: Atom | Node | undefined): string | null => (Array.isArray(n) ? val(n[0]) : null);
export const kids = (n: Node, t: string): Node[] => n.filter((x): x is Node => Array.isArray(x) && tag(x) === t);
export const kid = (n: Node, t: string): Node | undefined => kids(n, t)[0];
export const num = (x: Atom | Node | undefined): number => parseFloat(val(x));

/** Extract the balanced-paren block that starts at the '(' at index `start`. */
export function balanced(text: string, start: number): string | null {
    let depth = 0, inStr = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) { if (c === '"' && text[i - 1] !== '\\') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
}
