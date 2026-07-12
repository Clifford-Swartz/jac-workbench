// In-memory schematic model + serialize to a VALID .kicad_sch (lib_symbols embedded from real libs).
import * as crypto from 'crypto';
import { extractSymbol, symbolPins, symbolGraphics, Pin } from './symbols';

const uuid = () => crypto.randomUUID();

export interface Component {
    id: string;
    libId: string;     // "Device:R"
    lib: string;       // abs path to the .kicad_sym containing it
    name: string;      // "R"
    ref: string;       // "R1"
    value: string;
    x: number; y: number; rot: number;   // sheet mm coords
}
export interface Wire { id: string; x1: number; y1: number; x2: number; y2: number; }
export interface Label { id: string; text: string; x: number; y: number; }

export class Schematic {
    components: Component[] = [];
    wires: Wire[] = [];
    labels: Label[] = [];
    sheetUuid = uuid();
    private seq = 0;
    private refCounters: Record<string, number> = {};

    private nextId() { return `it${++this.seq}`; }

    nextRef(prefix: string): string {
        const used = this.components.filter((c) => c.ref.startsWith(prefix)).map((c) => parseInt(c.ref.slice(prefix.length), 10)).filter((n) => !isNaN(n));
        const n = used.length ? Math.max(...used) + 1 : 1;
        return `${prefix}${n}`;
    }

    add(libId: string, lib: string, name: string, value: string, x: number, y: number, rot = 0, refPrefix = 'U'): Component {
        const c: Component = { id: this.nextId(), libId, lib, name, ref: this.nextRef(refPrefix), value, x, y, rot };
        this.components.push(c);
        return c;
    }
    find(idOrRef: string): Component | undefined {
        return this.components.find((c) => c.id === idOrRef || c.ref === idOrRef);
    }
    remove(idOrRef: string): boolean {
        const c = this.find(idOrRef);
        if (!c) return false;
        this.components = this.components.filter((x) => x !== c);
        return true;
    }
    reset() { this.components = []; this.wires = []; this.labels = []; this.refCounters = {}; this.seq = 0; }

    /** Symbol-local pin -> sheet mm coords (rotate CCW by rot, flip Y for the sheet). */
    pinPos(c: Component, pin: Pin): { x: number; y: number } {
        const r = (c.rot * Math.PI) / 180;
        const rx = pin.x * Math.cos(r) - pin.y * Math.sin(r);
        const ry = pin.x * Math.sin(r) + pin.y * Math.cos(r);
        return { x: +(c.x + rx).toFixed(4), y: +(c.y - ry).toFixed(4) };
    }
    pinsOf(c: Component): Pin[] {
        const sym = extractSymbol(c.lib, c.name);
        return sym ? symbolPins(sym) : [];
    }
    // Common functional aliases so agents can say "IN"/"OUT" instead of "VIN"/"VOUT"/"VO"/"VI".
    private static PIN_ALIASES: Record<string, string[]> = {
        IN:  ['VIN', 'VI', 'INPUT', 'VINPUT', 'VIN1'],
        OUT: ['VOUT', 'VO', 'OUTPUT', 'VOUT1'],
        GND: ['GND', 'VSS', 'AGND', 'PGND', 'SGND'],
        VCC: ['VCC', 'VDD', 'AVDD', 'PVDD', 'DVDD', '3V3', '5V', 'VSUP'],
    };

    resolvePin(idOrRef: string, query: string): Pin | null {
        const c = this.find(idOrRef);
        if (!c) return null;
        const pins = this.pinsOf(c);
        const q = query.trim();
        const qu = q.toUpperCase();
        // 1. Exact match on number or name
        let p = pins.find(pp => pp.number === q || pp.name === q);
        if (p) return p;
        // 2. Case-insensitive
        p = pins.find(pp => pp.number.toUpperCase() === qu || pp.name.toUpperCase() === qu);
        if (p) return p;
        // 3. Alias table (e.g. "IN" → try "VIN", "VI", ...)
        const aliases = Schematic.PIN_ALIASES[qu];
        if (aliases) { p = pins.find(pp => aliases.includes(pp.name.toUpperCase())); if (p) return p; }
        // 4. Reverse alias: strip leading V/A from stored name and compare (e.g. "VIN" stored, "IN" asked)
        p = pins.find(pp => pp.name.toUpperCase().replace(/^[VA]/, '') === qu.replace(/^[VA]/, ''));
        if (p) return p;
        // 5. Suffix match: stored "VIN" ends with asked "IN"
        p = pins.find(pp => pp.name.toUpperCase().endsWith(qu) && qu.length >= 2);
        if (p) return p;
        return null;
    }

    pinWorld(idOrRef: string, pinQuery: string): { x: number; y: number } | null {
        const c = this.find(idOrRef);
        if (!c) return null;
        const p = this.resolvePin(idOrRef, pinQuery);
        return p ? this.pinPos(c, p) : null;
    }

    pinNames(idOrRef: string): string {
        const c = this.find(idOrRef);
        if (!c) return '(component not found)';
        return this.pinsOf(c).map(p => `${p.name}(${p.number})`).join(', ') || '(no pins)';
    }

    addWire(x1: number, y1: number, x2: number, y2: number): Wire {
        const w: Wire = { id: this.nextId(), x1, y1, x2, y2 };
        this.wires.push(w);
        return w;
    }
    addLabel(text: string, x: number, y: number): Label {
        const l: Label = { id: this.nextId(), text, x, y };
        this.labels.push(l);
        return l;
    }

    /** Serialize to a KiCad-valid .kicad_sch. */
    emit(): string {
        const libSyms: Record<string, string> = {};
        for (const c of this.components) {
            if (libSyms[c.libId]) continue;
            let sym = extractSymbol(c.lib, c.name);
            if (!sym) throw new Error(`symbol ${c.name} not found in ${c.lib}`);
            sym = sym.replace(`(symbol "${c.name}"`, `(symbol "${c.libId}"`);
            libSyms[c.libId] = sym.split('\n').map((l) => '\t\t' + l).join('\n');
        }
        const instances = this.components.map((c) => {
            const pins = this.pinsOf(c).map((p) => `\t\t(pin "${p.number}"\n\t\t\t(uuid "${uuid()}")\n\t\t)`).join('\n');
            return `\t(symbol
\t\t(lib_id "${c.libId}")
\t\t(at ${c.x} ${c.y} ${c.rot || 0})
\t\t(unit 1)
\t\t(exclude_from_sim no)
\t\t(in_bom yes)
\t\t(on_board yes)
\t\t(dnp no)
\t\t(uuid "${uuid()}")
\t\t(property "Reference" "${c.ref}"
\t\t\t(at ${c.x + 2.54} ${c.y - 1.27} 0)
\t\t\t(effects (font (size 1.27 1.27)))
\t\t)
\t\t(property "Value" "${c.value}"
\t\t\t(at ${c.x + 2.54} ${c.y + 1.27} 0)
\t\t\t(effects (font (size 1.27 1.27)))
\t\t)
\t\t(property "Footprint" ""
\t\t\t(at ${c.x} ${c.y} 0)
\t\t\t(effects (font (size 1.27 1.27)) (hide yes))
\t\t)
\t\t(property "Datasheet" "~"
\t\t\t(at ${c.x} ${c.y} 0)
\t\t\t(effects (font (size 1.27 1.27)) (hide yes))
\t\t)
${pins}
\t\t(instances
\t\t\t(project ""
\t\t\t\t(path "/${this.sheetUuid}"
\t\t\t\t\t(reference "${c.ref}")
\t\t\t\t\t(unit 1)
\t\t\t\t)
\t\t\t)
\t\t)
\t)`;
        }).join('\n');

        const wires = this.wires.map((w) =>
            `\t(wire\n\t\t(pts\n\t\t\t(xy ${w.x1} ${w.y1}) (xy ${w.x2} ${w.y2})\n\t\t)\n\t\t(stroke (width 0) (type default))\n\t\t(uuid "${w.id}")\n\t)`).join('\n');
        const labels = this.labels.map((l) =>
            `\t(label "${l.text}"\n\t\t(at ${l.x} ${l.y} 0)\n\t\t(effects (font (size 1.27 1.27)) (justify left bottom))\n\t\t(uuid "${l.id}")\n\t)`).join('\n');

        return `(kicad_sch
\t(version 20250114)
\t(generator "jac")
\t(generator_version "10.0")
\t(uuid "${uuid()}")
\t(paper "A4")
\t(lib_symbols
${Object.values(libSyms).join('\n')}
\t)
${wires}
${labels}
${instances}
\t(sheet_instances
\t\t(path "/"
\t\t\t(page "1")
\t\t)
\t)
\t(embedded_fonts no)
)
`;
    }

    /** Compact context for the chat — includes pin names so the agent can wire without guessing. */
    context(): string {
        if (!this.components.length) return 'Empty schematic.';
        const lines = [`Schematic: ${this.components.length} components, ${this.wires.length} wires, ${this.labels.length} labels`];
        for (const c of this.components) {
            const pins = this.pinsOf(c).map(p => `${p.name}(${p.number})`).join(', ');
            lines.push(`  ${c.ref} (${c.libId}) = ${c.value}  pins: ${pins}`);
        }
        return lines.join('\n');
    }
    /** Render-ready payload for the native canvas: components with symbol graphics + world pins. */
    renderData() {
        return {
            components: this.components.map((c) => {
                const pins = this.pinsOf(c).map((p) => {
                    const w = this.pinPos(c, p);
                    return { number: p.number, name: p.name, x: w.x, y: w.y };
                });
                return {
                    id: c.id, ref: c.ref, value: c.value, libId: c.libId,
                    x: c.x, y: c.y, rot: c.rot,
                    graphics: symbolGraphics(c.lib, c.name),
                    pins,
                };
            }),
            wires: this.wires,
            labels: this.labels,
        };
    }
}
