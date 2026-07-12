import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, Notification, net } from 'electron';
import type { BrowserWindow as BrowserWindowType, Tray as TrayType } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import { spawn } from 'child_process';
import { autoUpdater } from 'electron-updater';
import { WSClient } from './wsClient';
import { AgentScheduler } from './agentScheduler';
import { fetchORModels, fetchORCredits, queryOR, ORModel } from './orClient';
import { McpManager, McpServerConfig, McpTool } from './mcp/manager';
import { runAgenticQuery } from './agent/loop';
import { Schematic } from './kicad/schematic';
import { findKicad, searchCatalog, resolveLibId, symbolRefPrefix, symbolDefaultValue,
    symbolDefaultFootprint, symbolPins, symbolGraphics, extractSymbol } from './kicad/symbols';
import { routeDemo, routeSetup, routeStart, routeMove, routeFinish, routeAB, Obstacle, SegObstacle } from './kicad/router';

const CONFIG_PATH = path.join(os.homedir(), '.jac', 'config.json');
const DEFAULT_CONFIG = {
    relayUrl: 'wss://mellow-backend.onrender.com',
    authToken: '',            // relay disabled — no shared secret shipped
    useRelay: false,          // local + OpenRouter only; no relay / Claude-bridge dependency
    preferredMachineId: '',
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openAtLogin: false,
    windowBounds: { width: 1000, height: 700 },
    favoriteModels: [] as string[],
    defaultModel: '',
    lastModel: '',   // last-selected model, restored on restart so OR/local routing survives
    localModelPath: '',  // GGUF the bundled jac-llm-server auto-serves (empty = none/auto-detect)
    localDraftModelPath: '',  // small draft GGUF (same tokenizer) for speculative decoding (empty = auto/off)
    // MCP: external tool servers, same shape as Claude Desktop. stdio: {command,args,env}; sse: {url}
    mcpServers: {} as Record<string, McpServerConfig>,
    // per-tool permission: 'mcp__<server>__<tool>' -> 'allow' | 'ask' | 'deny' (missing = 'ask')
    mcpToolPermissions: {} as Record<string, 'allow' | 'ask' | 'deny'>,
    editorTheme: 'One Dark',   // CodeMirror theme for the file editor
    lastCwd: '',               // last project folder — restores the history scope across restarts
    // Behavior steering — control vectors applied to the local llama-server at launch.
    // steerVectors: named directions the user has generated; steerScales: active scale per vector id
    // (0 = off). At spawn we append one --control-vector-scaled flag per non-zero scale.
    steerVectors: [] as Array<{ id: string; name: string; path: string }>,
    steerScales: {} as Record<string, number>,
    steerPresets: [] as Array<{ name: string; scales: Record<string, number> }>,  // named personality slider combos
    steerHfModelPath: '',   // HF-format weights repeng reads to generate vectors (empty = not set up)
    localNgl: 999,          // GPU layers to offload for the local model (0 = CPU-only; some laptop GPUs OOM at 999)
};

function loadConfig(): typeof DEFAULT_CONFIG {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg: typeof DEFAULT_CONFIG): void {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let mainWindow: BrowserWindowType | null = null;
let tray: TrayType | null = null;
let wsClient: WSClient | null = null;
let scheduler: AgentScheduler | null = null;
let config = loadConfig();
const mcpManager = new McpManager((m) => console.log(m));

// Pending MCP tool-permission prompts, keyed by request_id (resolved by 'permission_response').
let permSeq = 0;
const pendingPermissions = new Map<string, (r: { allow: boolean; remember: boolean }) => void>();

// Decide whether a tool may run: saved allow/deny short-circuits; otherwise prompt the UI and wait.
function decidePermission(name: string, args: Record<string, unknown>): Promise<'allow' | 'deny'> {
    const saved = config.mcpToolPermissions[name];
    if (saved === 'allow' || saved === 'deny') return Promise.resolve(saved);
    return new Promise((resolve) => {
        const request_id = `perm_${++permSeq}`;
        pendingPermissions.set(request_id, ({ allow, remember }) => {
            if (remember) { config.mcpToolPermissions[name] = allow ? 'allow' : 'deny'; saveConfig(config); }
            resolve(allow ? 'allow' : 'deny');
        });
        mainWindow?.webContents.send('relay-message', {
            type: 'permission_request',
            request_id,
            tool_name: name,
            tool_input: args,
            allowlist_suggestion: { scope: 'tool', match: name },
        });
    });
}

// JAC-native "meta" tools — always available to the agent alongside MCP tools, so the model can
// manage MCP servers conversationally. Namespaced jac__* and dispatched by callBuiltin (not the MCP manager).
const MCP_BUILTINS: McpTool[] = [
    {
        server: 'jac', name: 'add_mcp_server', qualifiedName: 'jac__add_mcp_server',
        description: 'Add (or update) and connect an MCP tool server in JAC. Runs the given command via stdio. Use for requests like "add the playwright MCP server".',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short unique id, e.g. "playwright"' },
                command: { type: 'string', description: 'Executable to run, e.g. "npx"' },
                args: { type: 'array', items: { type: 'string' }, description: 'Arguments, e.g. ["-y","@playwright/mcp@latest"]' },
                env: { type: 'object', description: 'Optional environment variables', additionalProperties: { type: 'string' } },
            },
            required: ['name', 'command'],
        },
    },
    {
        server: 'jac', name: 'list_mcp_servers', qualifiedName: 'jac__list_mcp_servers',
        description: 'List configured MCP servers with their connection status and tool counts.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'remove_mcp_server', qualifiedName: 'jac__remove_mcp_server',
        description: 'Remove a configured MCP server from JAC by its name.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    // ── CAD control: let the chat drive the build123d CAD kernel (:5050) and its live viewer ──
    {
        server: 'jac', name: 'cad_execute', qualifiedName: 'jac__cad_execute',
        description:
            'Create or modify precise/parametric 3D CAD geometry by running build123d Python. It renders live in the CAD tab. ' +
            'Assign the final solid (or list of solids) to a variable named RESULT. build123d is auto-imported. ' +
            'Builders: Box(l,w,h), Cylinder(radius,height), Sphere(r), Cone(bottom,top,height), Torus(major,minor). ' +
            'Combine with + (union), - (cut), & (intersect). Edit edges with .fillet(radius) / .chamfer(size). ' +
            'IMPORTANT: RESULT replaces the WHOLE scene by default. Two variables are pre-bound so you can build on existing geometry: ' +
            'INPUT_SHAPES (list of all current solids) and TARGET_PART (the solid at target_index, if given). ' +
            'To ADD a part while keeping the rest: RESULT = INPUT_SHAPES + [Box(10,10,10)]. ' +
            'Use this for mechanical/precise/printable parts. For organic/artistic shapes, use the (separate) 3D-generation tools instead.',
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'build123d Python. Must assign the shape(s) to RESULT.' },
                target_index: { type: 'number', description: 'Optional: bind TARGET_PART and replace only the part at this index.' },
            },
            required: ['code'],
        },
    },
    {
        server: 'jac', name: 'cad_list_parts', qualifiedName: 'jac__cad_list_parts',
        description: 'List the current CAD parts with their index, dimensions (mm), volume and center. Read-only; use to inspect geometry before editing.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'cad_transform', qualifiedName: 'jac__cad_transform',
        description: 'Move, rotate, or scale a CAD part by its index.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'number', description: 'Part index (see cad_list_parts).' },
                transform: { type: 'string', enum: ['translate', 'rotate', 'scale'] },
                vector: { type: 'array', items: { type: 'number' }, description: 'For translate: [dx,dy,dz] in mm.' },
                axis: { type: 'string', enum: ['X', 'Y', 'Z'], description: 'For rotate: axis (default Z).' },
                angle: { type: 'number', description: 'For rotate: degrees.' },
                factor: { type: 'number', description: 'For scale: multiplier.' },
            },
            required: ['target', 'transform'],
        },
    },
    {
        server: 'jac', name: 'cad_boolean', qualifiedName: 'jac__cad_boolean',
        description: 'Boolean-combine two CAD parts by index: union (fuse), cut (subtract b from a), or intersect. Both originals are replaced by the result.',
        inputSchema: {
            type: 'object',
            properties: {
                op: { type: 'string', enum: ['union', 'cut', 'intersect'] },
                target_a: { type: 'number' },
                target_b: { type: 'number' },
            },
            required: ['op', 'target_a', 'target_b'],
        },
    },
    {
        server: 'jac', name: 'cad_delete', qualifiedName: 'jac__cad_delete',
        description: 'Delete CAD parts by index.',
        inputSchema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'number' } } }, required: ['targets'] },
    },
    {
        server: 'jac', name: 'cad_export_stl', qualifiedName: 'jac__cad_export_stl',
        description: 'Export a CAD part to an STL file (for 3D printing). Saves to ~/.jac/cad_out unless an absolute path is given.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'number', description: 'Part index to export.' },
                filename: { type: 'string', description: 'File name or absolute path, e.g. "bracket.stl".' },
            },
            required: ['target'],
        },
    },
    {
        server: 'jac', name: 'cad_duplicate', qualifiedName: 'jac__cad_duplicate',
        description: 'Duplicate a CAD part by index, offset by [dx,dy,dz] mm (default [20,0,0]). The copy is added as a new part.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'number' },
                offset: { type: 'array', items: { type: 'number' }, description: 'Copy offset [dx,dy,dz] in mm.' },
            },
            required: ['target'],
        },
    },
    {
        server: 'jac', name: 'cad_mirror', qualifiedName: 'jac__cad_mirror',
        description: 'Mirror a CAD part across a plane (YZ, XZ, or XY). By default keeps the original and adds the mirrored copy — set keep_original false to replace in place.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'number' },
                plane: { type: 'string', enum: ['YZ', 'XZ', 'XY'] },
                keep_original: { type: 'boolean' },
            },
            required: ['target'],
        },
    },
    {
        server: 'jac', name: 'cad_reset', qualifiedName: 'jac__cad_reset',
        description: 'Clear all CAD geometry from the scene. Destructive.',
        inputSchema: { type: 'object', properties: {} },
    },
    // ── 3D generation: turn an image (or, later, text) into a mesh via the local gen server (:5052) ──
    {
        server: 'jac', name: 'gen3d_from_image', qualifiedName: 'jac__gen3d_from_image',
        description:
            'Generate an organic/artistic 3D model (a mesh) from a single input image using the local 3D-gen AI, ' +
            'and load it into the CAD viewer. Use for figurines, creatures, props, scanned-look objects — anything ' +
            'sculptural rather than mechanical. For precise/parametric parts (brackets, holes, exact dimensions) use ' +
            'cad_execute instead. Two quality tiers: "fast" (TripoSR, untextured, ~5s) and "best" (Hunyuan3D 2.1, ' +
            'clean geometry + real PBR textures, ~10 min on the local GPU). Default fast.',
        inputSchema: {
            type: 'object',
            properties: {
                image_path: { type: 'string', description: 'Path to the input image (PNG/JPG). A single clear subject on a plain background works best.' },
                quality: { type: 'string', enum: ['fast', 'best'], description: '"fast" = TripoSR (~5s, untextured). "best" = Hunyuan3D 2.1 with PBR textures (~10 min). Default fast; use best when the user wants high quality / textures.' },
                seed: { type: 'number', description: 'Optional random seed for reproducibility.' },
                free_gpu_after: { type: 'boolean', description: 'Unload the 3D model from the GPU right after this generation (use when a local LLM needs the VRAM back). Costs a reload (~30s) next time.' },
            },
            required: ['image_path'],
        },
    },
    {
        server: 'jac', name: 'gen3d_release_gpu', qualifiedName: 'jac__gen3d_release_gpu',
        description: 'Unload the 3D-generation model from the GPU immediately, freeing its VRAM (e.g. so a local LLM has the full card). The model reloads automatically on the next generation.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'gen3d_from_text', qualifiedName: 'jac__gen3d_from_text',
        description: 'Generate a 3D model from a text prompt. NOTE: text→3D needs the text-to-image stage which is not enabled yet — this currently returns guidance to use an image instead.',
        inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    },
    {
        server: 'jac', name: 'cad_import_model', qualifiedName: 'jac__cad_import_model',
        description: 'Load an existing 3D model file (GLB/GLTF) from disk into the CAD viewer.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to a .glb/.gltf file.' } }, required: ['path'] },
    },
    // ── PCB / schematic capture: let the chat build circuit schematics in the PCB tab (:5051) ──
    {
        server: 'jac', name: 'pcb_add_component', qualifiedName: 'jac__pcb_add_component',
        description:
            'Place a component on the schematic. It gets an auto reference designator (R1, C1, U1…) and renders live in the PCB tab. ' +
            'Available types: resistor, capacitor, cap_polar, inductor, led, diode, npn, pnp, ic_generic, 555, esp32, connector_2pin, usb_c, vcc, gnd, 3v3. ' +
            'Call pcb_library to see each type\'s pin names before wiring. Lay parts out on a grid (e.g. x/y in multiples of ~60) so wires route cleanly.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', description: 'Component type (see list above).' },
                x: { type: 'number', description: 'X position (schematic units).' },
                y: { type: 'number', description: 'Y position.' },
                rotation: { type: 'number', description: 'Rotation in degrees (0/90/180/270).' },
                properties: { type: 'object', description: 'Optional overrides, e.g. {"value":"4.7k"}.', additionalProperties: true },
            },
            required: ['type'],
        },
    },
    {
        server: 'jac', name: 'pcb_add_wire', qualifiedName: 'jac__pcb_add_wire',
        description: 'Connect two component pins with an auto-routed wire (A* around other parts). Components are named by ref (R1) or id; pins by name (see pcb_library). Give the net a meaningful name (VCC, GND, SIG) so it groups correctly.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Source component ref or id (e.g. "R1").' },
                from_pin: { type: 'string', description: 'Source pin name (e.g. "1", "A", "GPIO0").' },
                to: { type: 'string', description: 'Target component ref or id.' },
                to_pin: { type: 'string', description: 'Target pin name.' },
                net: { type: 'string', description: 'Optional net name (e.g. "VCC", "GND", "LED_SIG").' },
            },
            required: ['from', 'from_pin', 'to', 'to_pin'],
        },
    },
    {
        server: 'jac', name: 'pcb_move_component', qualifiedName: 'jac__pcb_move_component',
        description: 'Move a component (by ref or id) to a new position.',
        inputSchema: { type: 'object', properties: { target: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['target', 'x', 'y'] },
    },
    {
        server: 'jac', name: 'pcb_remove_component', qualifiedName: 'jac__pcb_remove_component',
        description: 'Remove a component (by ref or id) and its connections.',
        inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    },
    {
        server: 'jac', name: 'pcb_list', qualifiedName: 'jac__pcb_list',
        description: 'List the current schematic: components (ref, type, position, value) and nets. Read-only.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'pcb_library', qualifiedName: 'jac__pcb_library',
        description: 'List the available component types with their PIN NAMES and default value/footprint. Call this before wiring so you use correct pin names.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'pcb_reset', qualifiedName: 'jac__pcb_reset',
        description: 'Clear the whole schematic. Destructive.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'pcb_export_kicad', qualifiedName: 'jac__pcb_export_kicad',
        description: 'Export the schematic to a KiCad .kicad_sch file (so it can be opened in KiCad for PCB layout).',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Optional output path; defaults to ~/.jac/cad_out/schematic.kicad_sch.' } } },
    },
    // ── KiCad-native schematic capture: real symbol libraries, valid .kicad_sch, real ERC ──
    {
        server: 'jac', name: 'sch_search_library', qualifiedName: 'jac__sch_search_library',
        description: 'Search KiCad\'s real symbol libraries (thousands of parts) for a component. Returns lib_ids like "Device:R", "Regulator_Linear:AMS1117-3.3", "MCU_Module:Arduino_UNO_R3". Call this to find the exact lib_id before adding a part.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'e.g. "resistor", "555 timer", "esp32", "usb c", "ldo 3.3v".' } }, required: ['query'] },
    },
    {
        server: 'jac', name: 'sch_add_component', qualifiedName: 'jac__sch_add_component',
        description: 'Place a real KiCad component on the schematic by its lib_id (from sch_search_library). Auto-numbers the reference (R1, C1, U1…). Renders live via KiCad.',
        inputSchema: {
            type: 'object',
            properties: {
                lib_id: { type: 'string', description: 'Exact KiCad lib_id, e.g. "Device:R".' },
                value: { type: 'string', description: 'Optional value, e.g. "10k", "100nF".' },
                x: { type: 'number', description: 'Sheet X in mm (optional; auto-placed on a grid otherwise).' },
                y: { type: 'number', description: 'Sheet Y in mm (optional).' },
                rotation: { type: 'number', description: 'Rotation degrees (0/90/180/270).' },
            },
            required: ['lib_id'],
        },
    },
    {
        server: 'jac', name: 'sch_add_wire', qualifiedName: 'jac__sch_add_wire',
        description: 'Connect two component pins by reference + pin number/name (KiCad pin numbers, e.g. "1","2","VCC","GND"). Optionally name the net.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Source component ref, e.g. "R1".' },
                from_pin: { type: 'string', description: 'Source pin number or name.' },
                to: { type: 'string', description: 'Target component ref.' },
                to_pin: { type: 'string', description: 'Target pin number or name.' },
                net: { type: 'string', description: 'Optional net label (VCC/GND/…).' },
            },
            required: ['from', 'from_pin', 'to', 'to_pin'],
        },
    },
    {
        server: 'jac', name: 'sch_move_component', qualifiedName: 'jac__sch_move_component',
        description: 'Move a component (by ref) to a new sheet position (mm).',
        inputSchema: { type: 'object', properties: { target: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['target', 'x', 'y'] },
    },
    {
        server: 'jac', name: 'sch_remove_component', qualifiedName: 'jac__sch_remove_component',
        description: 'Remove a component (by ref) from the schematic.',
        inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    },
    {
        server: 'jac', name: 'sch_list', qualifiedName: 'jac__sch_list',
        description: 'List the current KiCad schematic: components (ref, lib_id, value) and wire/label counts.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'sch_reset', qualifiedName: 'jac__sch_reset',
        description: 'Clear the schematic. Destructive.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'sch_export', qualifiedName: 'jac__sch_export',
        description: 'Write the current schematic to a real .kicad_sch file that opens directly in KiCad.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Optional output path.' } } },
    },
    {
        server: 'jac', name: 'sch_erc', qualifiedName: 'jac__sch_erc',
        description: 'Run KiCad\'s real Electrical Rule Check on the current schematic and return the report.',
        inputSchema: { type: 'object', properties: {} },
    },
    // ── PCB physical layout: arrange footprints, route traces, add copper pours ──
    {
        server: 'jac', name: 'pcb_auto_arrange', qualifiedName: 'jac__pcb_auto_arrange',
        description: 'Auto-arrange all component footprints into a tidy grid on the PCB board. Call this before routing. Moves pcb_x/pcb_y positions; does not affect schematic positions.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'sch_arrange', qualifiedName: 'jac__sch_arrange',
        description: 'Tidy the SCHEMATIC: spread parts on the sheet with proper spacing (connected parts kept close, decoupling caps by their IC) so symbols do not overlap, then re-route every wire so nets flow around parts instead of through them. ALWAYS call this after building or editing a schematic (adding parts + wiring) so it is readable — a freshly built schematic is packed too tightly otherwise. Moves schematic x/y only; PCB layout is untouched.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'pcb_auto_route', qualifiedName: 'jac__pcb_auto_route',
        description: 'Auto-route ALL unconnected nets on the PCB using A* pathfinding. Auto-arranges footprints first if not already placed. Returns number of routes added and any nets that failed. Call pcb_ground_plane after to add a GND pour.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'pcb_ground_plane', qualifiedName: 'jac__pcb_ground_plane',
        description: 'Add a GND copper pour (ground plane) on F.Cu covering the entire board. Best called after routing.',
        inputSchema: { type: 'object', properties: { net: { type: 'string', description: 'Net name for the pour. Default: GND.' } } },
    },
    {
        server: 'jac', name: 'pcb_export_board', qualifiedName: 'jac__pcb_export_board',
        description: 'Export the fully routed board to a .kicad_pcb file ready for Gerber generation.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Optional output path.' } } },
    },
    {
        server: 'jac', name: 'pcb_board_state', qualifiedName: 'jac__pcb_board_state',
        description: 'Get current PCB layout state: placed footprint positions, routed track count, unrouted net count, zones. Read-only.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        server: 'jac', name: 'ui_open_panel', qualifiedName: 'jac__ui_open_panel',
        description: 'Open or split a JAC panel. Use to show the user relevant views — open schematic after placing components, PCB after routing, CAD after modeling, stocks for market data, etc. ALWAYS include direction="right" to split the panel alongside chat unless the user says otherwise. Panel names: chat, schematic, pcb, cad, music, capture, mcp, models, workflow, stocks, zeldovich, settings.',
        inputSchema: {
            type: 'object',
            properties: {
                panel: { type: 'string', description: 'Panel to open: chat | schematic | pcb | cad | music | capture | mcp | models | workflow | stocks | zeldovich | settings' },
                direction: { type: 'string', description: 'Split direction: right | left | above | below | tab. Default: right (splits panel alongside chat). Use tab only if the user explicitly asks for a new tab.' },
            },
            required: ['panel'],
        },
    },
];

// CAD kernel bridge (:5050). The chat mutates geometry here; the viewer is told to refresh + focus.
async function cadPost(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch(`${CAD_SERVER_URL}/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args }), signal: AbortSignal.timeout(30000),
    });
    return await r.json() as Record<string, unknown>;
}
async function cadContext(): Promise<string> {
    try {
        const r = await fetch(`${CAD_SERVER_URL}/context`, { signal: AbortSignal.timeout(5000) });
        const j = await r.json() as { context?: string };
        return j.context || '';
    } catch { return ''; }
}
// Tell the renderer to focus the CAD tab and refresh its viewer after an out-of-band mutation.
function notifyCadActivity(): void {
    mainWindow?.webContents.send('relay-message', { type: 'cad_activity' });
}

async function callCadBuiltin(qualifiedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const clip = (s: string, n = 1500) => (s.length > n ? s.slice(-n) : s);
    try {
        if (qualifiedName === 'jac__cad_list_parts') {
            const ctx = await cadContext();
            return { text: ctx || 'No geometry loaded.', isError: false };
        }
        let res: Record<string, unknown>;
        if (qualifiedName === 'jac__cad_execute') {
            const code = String(args.code ?? '');
            if (!code.trim()) return { text: '`code` is required — build123d Python that assigns to RESULT.', isError: true };
            res = await cadPost('cad_execute', { code, ...(args.target_index != null ? { target_index: args.target_index } : {}) });
        } else if (qualifiedName === 'jac__cad_transform') {
            res = await cadPost('transform_part', args);
        } else if (qualifiedName === 'jac__cad_boolean') {
            res = await cadPost('boolean_op', args);
        } else if (qualifiedName === 'jac__cad_delete') {
            res = await cadPost('delete_parts', { targets: args.targets });
        } else if (qualifiedName === 'jac__cad_duplicate') {
            res = await cadPost('duplicate_part', { target: args.target, ...(args.offset != null ? { offset: args.offset } : {}) });
        } else if (qualifiedName === 'jac__cad_mirror') {
            res = await cadPost('mirror_part', { target: args.target, plane: args.plane ?? 'YZ', keep_original: args.keep_original ?? true });
        } else if (qualifiedName === 'jac__cad_export_stl') {
            res = await cadPost('export_stl', { target: args.target, filename: String(args.filename ?? 'export.stl') });
            if (res.ok) return { text: `Saved STL → ${res.path} (${res.size_kb} KB)`, isError: false };
        } else if (qualifiedName === 'jac__cad_reset') {
            res = await cadPost('reset', {});
            notifyCadActivity();
            return { text: 'CAD scene cleared.', isError: false };
        } else {
            return { text: `Unknown CAD tool: ${qualifiedName}`, isError: true };
        }
        notifyCadActivity();
        if (!res.ok) return { text: `CAD error:\n${clip(String(res.error ?? 'unknown'))}`, isError: true };
        const ctx = await cadContext();
        const n = res.n_parts ?? '';
        return { text: `OK.${n !== '' ? ` ${n} part(s).` : ''}\n${ctx}`.trim(), isError: false };
    } catch (e) {
        return { text: `CAD backend unreachable on :5050 — is Python + build123d installed and the CAD server running? (${String((e as Error).message ?? e)})`, isError: true };
    }
}

// 3D-gen bridge (:5052, runs in WSL). Kick a job, poll to completion, load the GLB into the viewer.
const GEN3D_SERVER_URL = 'http://127.0.0.1:5052';
async function gen3dPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch(`${GEN3D_SERVER_URL}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return await r.json() as Record<string, unknown>;
}
// Load a GLB (Windows path or \\wsl.localhost UNC) into the CAD viewer. Ship the PATH, not the bytes —
// the renderer reads it via the proven openGlb IPC (avoids pushing multi-MB base64 through the relay bus).
function loadGlbIntoViewer(filePath: string, name: string): boolean {
    const fwd = filePath.replace(/\\/g, '/');   // forward-slash UNC reads cleanly on Windows Node
    if (!fs.existsSync(fwd)) return false;
    mainWindow?.webContents.send('relay-message', { type: 'cad_load_glb', path: fwd, name });
    return true;
}

async function callGen3dBuiltin(qualifiedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    try {
        if (qualifiedName === 'jac__gen3d_from_text') {
            return { text: 'Text→3D is not enabled yet (needs the text-to-image stage). Provide an image and use gen3d_from_image instead.', isError: true };
        }
        if (qualifiedName === 'jac__gen3d_release_gpu') {
            try {
                const r = await gen3dPost('/unload', {});
                return { text: r.freed ? 'Released the 3D model from the GPU — VRAM is free.' : 'Nothing was loaded; GPU already free.', isError: false };
            } catch { return { text: 'The 3D-gen server (:5052) is not running.', isError: true }; }
        }
        if (qualifiedName === 'jac__cad_import_model') {
            const p = String(args.path ?? '');
            if (!p) return { text: '`path` to a .glb/.gltf is required.', isError: true };
            const name = p.split(/[\\/]/).pop() || 'model';
            return loadGlbIntoViewer(p, name)
                ? { text: `Loaded ${name} into the CAD viewer.`, isError: false }
                : { text: `Could not read model file: ${p}`, isError: true };
        }
        if (qualifiedName === 'jac__gen3d_from_image') {
            const imagePath = String(args.image_path ?? '');
            if (!imagePath) return { text: '`image_path` is required.', isError: true };
            // health check → clearer error than a failed POST if the server/installer isn't up
            try { await fetch(`${GEN3D_SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) }); }
            catch { return { text: 'The 3D-gen server (:5052) is not running — it needs to be set up first (P2 installer).', isError: true }; }
            const quality = String(args.quality ?? 'fast').toLowerCase();
            const backend = quality === 'best' ? 'hunyuan' : 'triposr';
            const opts: Record<string, unknown> = {};
            if (args.seed != null) opts.seed = args.seed;
            if (args.free_gpu_after) opts.unload_after = true;
            const started = await gen3dPost('/generate', { mode: 'image', image: imagePath, backend, ...(Object.keys(opts).length ? { opts } : {}) });
            if (started.error) return { text: `Generation rejected: ${started.error}`, isError: true };
            const jobId = String(started.job_id ?? '');
            if (!jobId) return { text: 'No job id returned from the gen server.', isError: true };
            // "best" (Hunyuan shape+paint) runs ~10 min; give it generous headroom. "fast" ~seconds.
            const deadline = Date.now() + (backend === 'hunyuan' ? 25 : 10) * 60 * 1000;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 1500));
                let job: Record<string, unknown>;
                try {
                    const jr = await fetch(`${GEN3D_SERVER_URL}/job/${jobId}`, { signal: AbortSignal.timeout(5000) });
                    job = await jr.json() as Record<string, unknown>;
                } catch { continue; }
                if (job.state === 'error') return { text: `Generation failed: ${String(job.error ?? 'unknown').slice(0, 400)}`, isError: true };
                if (job.state === 'done') {
                    const win = String(job.glb_win || job.glb || '');
                    const name = `gen-${jobId}.glb`;
                    const ok = loadGlbIntoViewer(win, name);
                    return ok
                        ? { text: `Generated a 3D model from ${imagePath.split(/[\\/]/).pop()} and loaded it into the CAD viewer.`, isError: false }
                        : { text: `Model generated (${win}) but could not be read into the viewer.`, isError: true };
                }
            }
            return { text: 'Generation timed out after 10 minutes.', isError: true };
        }
        return { text: `Unknown gen3d tool: ${qualifiedName}`, isError: true };
    } catch (e) {
        return { text: `3D-gen error: ${String((e as Error).message ?? e)}`, isError: true };
    }
}

// PCB/schematic bridge (:5051). The chat mutates the schematic; the viewer is told to refresh + focus.
async function pcbPost(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch(`${PCB_SERVER_URL}/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args }), signal: AbortSignal.timeout(15000),
    });
    return await r.json() as Record<string, unknown>;
}
async function pcbContext(): Promise<string> {
    try {
        const r = await fetch(`${PCB_SERVER_URL}/context`, { signal: AbortSignal.timeout(5000) });
        const j = await r.json() as { context?: string };
        return j.context || '';
    } catch { return ''; }
}
function notifyPcbActivity(): void {
    mainWindow?.webContents.send('relay-message', { type: 'pcb_activity' });
}

async function callPcbBuiltin(qualifiedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    try {
        if (qualifiedName === 'jac__pcb_list') {
            const ctx = await pcbContext();
            return { text: ctx || 'Empty schematic.', isError: false };
        }
        if (qualifiedName === 'jac__pcb_library') {
            const res = await pcbPost('get_library', {});
            const lib = (res.library ?? {}) as Record<string, { name?: string; pins?: Record<string, unknown>; properties?: { value?: string; footprint?: string } }>;
            const lines = Object.entries(lib).map(([type, v]) =>
                `${type} (${v.name ?? type}): pins [${Object.keys(v.pins ?? {}).join(', ')}]${v.properties?.value ? ` default=${v.properties.value}` : ''}`);
            return { text: lines.join('\n') || 'No components.', isError: false };
        }
        let res: Record<string, unknown>;
        if (qualifiedName === 'jac__pcb_add_component') {
            const type = String(args.type ?? '');
            if (!type) return { text: '`type` is required (see pcb_library for types).', isError: true };
            res = await pcbPost('add_component', { type, x: args.x ?? 0, y: args.y ?? 0, rotation: args.rotation ?? 0, ...(args.properties ? { properties: args.properties } : {}) });
        } else if (qualifiedName === 'jac__pcb_add_wire') {
            res = await pcbPost('add_wire', { from_comp: args.from, from_pin: args.from_pin, to_comp: args.to, to_pin: args.to_pin, ...(args.net ? { net: args.net } : {}) });
        } else if (qualifiedName === 'jac__pcb_move_component') {
            res = await pcbPost('move_component', { id: args.target, x: args.x, y: args.y });
        } else if (qualifiedName === 'jac__pcb_remove_component') {
            res = await pcbPost('remove_component', { id: args.target });
        } else if (qualifiedName === 'jac__pcb_reset') {
            res = await pcbPost('reset', {});
            notifyPcbActivity();
            return { text: 'Schematic cleared.', isError: false };
        } else if (qualifiedName === 'jac__pcb_export_kicad') {
            res = await pcbPost('export_kicad', { ...(args.path ? { path: args.path } : {}) });
            if (res.ok) return { text: `Exported KiCad schematic → ${res.path}`, isError: false };
        } else if (qualifiedName === 'jac__pcb_auto_arrange') {
            res = await pcbPost('auto_place_pcb', {});
            notifyPcbActivity();
            if (!res.ok) return { text: `PCB arrange error: ${res.error}`, isError: true };
            return { text: `Arranged ${(res as Record<string, unknown>).placed ?? '?'} footprints on the board. Open the PCB panel to see the layout.`, isError: false };
        } else if (qualifiedName === 'jac__sch_arrange') {
            res = await pcbPost('auto_place_sch', {});
            notifyPcbActivity();
            if (!res.ok) return { text: `Schematic arrange error: ${res.error}`, isError: true };
            return { text: `Tidied the schematic: spread ${(res as Record<string, unknown>).placed ?? '?'} parts and re-routed the wires. Open the schematic panel to see it.`, isError: false };
        } else if (qualifiedName === 'jac__pcb_auto_route') {
            res = await pcbPost('auto_route_all', {});
            notifyPcbActivity();
            if (!res.ok) return { text: `Routing error: ${res.error}`, isError: true };
            const routed = (res as Record<string, unknown>).routed ?? 0;
            const failed = (res as Record<string, unknown>).failed as string[] ?? [];
            const failMsg = failed.length ? ` (${failed.length} nets failed: ${failed.slice(0, 5).join(', ')})` : '';
            return { text: `Routed ${routed} net connections.${failMsg} Open the PCB panel to see traces. Call pcb_ground_plane next to add a GND pour.`, isError: false };
        } else if (qualifiedName === 'jac__pcb_ground_plane') {
            const net = String(args.net || 'GND');
            res = await pcbPost('add_zone', { layer: 0, net });
            notifyPcbActivity();
            if (!res.ok) return { text: `Zone error: ${res.error}`, isError: true };
            return { text: `Added ${net} copper pour on F.Cu.`, isError: false };
        } else if (qualifiedName === 'jac__pcb_export_board') {
            res = await pcbPost('export_pcb', { ...(args.path ? { path: args.path } : {}) });
            if (res.ok) return { text: `Exported board → ${res.path}`, isError: false };
        } else if (qualifiedName === 'jac__pcb_board_state') {
            const ctx = await pcbContext();
            return { text: ctx || 'Empty board.', isError: false };
        } else {
            return { text: `Unknown PCB tool: ${qualifiedName}`, isError: true };
        }
        notifyPcbActivity();
        if (!res.ok) return { text: `PCB error: ${String(res.error ?? 'unknown').slice(0, 300)}`, isError: true };
        const added = res.component ? `Added ${(res.component as { ref?: string }).ref}. ` : '';
        const ctx = await pcbContext();
        return { text: `${added}${ctx}`.trim(), isError: false };
    } catch (e) {
        return { text: `PCB backend unreachable on :5051 — is the PCB server running? (${String((e as Error).message ?? e)})`, isError: true };
    }
}

// ── KiCad schematic (native): real symbol libs + valid .kicad_sch, rendered by bundled kicad-cli ──
const schematic = new Schematic();
let kicadPaths = findKicad();
async function renderSchematicSvg(): Promise<void> {
    if (!kicadPaths?.cli) { mainWindow?.webContents.send('relay-message', { type: 'sch_activity', error: 'KiCad not installed' }); return; }
    try {
        const dir = path.join(os.tmpdir(), 'jac-sch'); fs.mkdirSync(dir, { recursive: true });
        const schPath = path.join(dir, 'schematic.kicad_sch');
        fs.writeFileSync(schPath, schematic.emit());
        await new Promise<void>((resolve) => {
            const p = spawn(kicadPaths!.cli, ['sch', 'export', 'svg', '--output', dir, '--exclude-drawing-sheet', schPath], { windowsHide: true, stdio: 'ignore' });
            p.on('exit', () => resolve()); p.on('error', () => resolve());
        });
        let svg = ''; try { svg = fs.readFileSync(path.join(dir, 'schematic.svg'), 'utf8'); } catch { /* no svg */ }
        mainWindow?.webContents.send('relay-message', { type: 'sch_kicad_svg', svg });
    } catch (e) { mainWindow?.webContents.send('relay-message', { type: 'sch_activity', error: String((e as Error).message ?? e) }); }
}
/** Push the native render-data (symbol graphics + wires) to the schematic editor canvas. */
function pushSchematic(): void {
    try { mainWindow?.webContents.send('relay-message', { type: 'sch_activity', data: schematic.renderData() }); }
    catch (e) { mainWindow?.webContents.send('relay-message', { type: 'sch_activity', error: String((e as Error).message ?? e) }); }
}

async function callSchBuiltin(qualifiedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (!kicadPaths) kicadPaths = findKicad();
    if (!kicadPaths?.symbolsDir) return { text: 'KiCad not found — it needs to be installed for the schematic tools.', isError: true };
    const sdir = kicadPaths.symbolsDir;
    try {
        if (qualifiedName === 'jac__sch_search_library') {
            const res = searchCatalog(sdir, String(args.query ?? ''));
            return { text: res.length ? res.map((e) => `${e.libId}${e.desc ? ' — ' + e.desc : ''}`).join('\n') : 'No matching parts.', isError: false };
        }
        if (qualifiedName === 'jac__sch_list') return { text: schematic.context(), isError: false };
        if (qualifiedName === 'jac__sch_reset') { schematic.reset(); pushSchematic(); return { text: 'Schematic cleared.', isError: false }; }
        if (qualifiedName === 'jac__sch_add_component') {
            const libId = String(args.lib_id ?? '');
            const e = resolveLibId(sdir, libId);
            if (!e) return { text: `Unknown lib_id '${libId}'. Use sch_search_library first.`, isError: true };
            const prefix = symbolRefPrefix(e.lib, e.name);
            const value = String(args.value ?? '') || symbolDefaultValue(e.lib, e.name) || e.name;
            const n = schematic.components.length;
            const x = args.x != null ? Number(args.x) : 60 + (n % 6) * 25.4;
            const y = args.y != null ? Number(args.y) : 60 + Math.floor(n / 6) * 25.4;
            const c = schematic.add(libId, e.lib, e.name, value, x, y, Number(args.rotation ?? 0), prefix);
            pushSchematic();
            const pins = schematic.pinNames(c.ref);
            return { text: `Added ${c.ref} (${libId}) = ${value}  pins: ${pins}\n${schematic.context()}`, isError: false };
        }
        if (qualifiedName === 'jac__sch_add_wire') {
            const a = schematic.pinWorld(String(args.from), String(args.from_pin));
            const b = schematic.pinWorld(String(args.to), String(args.to_pin));
            if (!a) return { text: `Could not resolve pin ${args.from}.${args.from_pin}. Available pins: ${schematic.pinNames(String(args.from))}`, isError: true };
            if (!b) return { text: `Could not resolve pin ${args.to}.${args.to_pin}. Available pins: ${schematic.pinNames(String(args.to))}`, isError: true };
            schematic.addWire(a.x, a.y, b.x, b.y);
            if (args.net) schematic.addLabel(String(args.net), a.x, a.y);
            pushSchematic();
            return { text: `Wired ${args.from}.${args.from_pin} → ${args.to}.${args.to_pin}${args.net ? ' (' + args.net + ')' : ''}.`, isError: false };
        }
        if (qualifiedName === 'jac__sch_move_component') {
            const c = schematic.find(String(args.target));
            if (!c) return { text: `No component ${args.target}.`, isError: true };
            c.x = Number(args.x); c.y = Number(args.y); pushSchematic();
            return { text: `Moved ${c.ref} to (${c.x},${c.y}).`, isError: false };
        }
        if (qualifiedName === 'jac__sch_remove_component') {
            const ok = schematic.remove(String(args.target)); pushSchematic();
            return { text: ok ? `Removed ${args.target}.` : `No component ${args.target}.`, isError: !ok };
        }
        if (qualifiedName === 'jac__sch_export') {
            const outDir = path.join(os.homedir(), '.jac', 'cad_out'); fs.mkdirSync(outDir, { recursive: true });
            const p = String(args.path ?? path.join(outDir, 'schematic.kicad_sch'));
            fs.writeFileSync(p, schematic.emit());
            return { text: `Exported valid KiCad schematic → ${p} (opens in KiCad).`, isError: false };
        }
        if (qualifiedName === 'jac__sch_erc') {
            const dir = path.join(os.tmpdir(), 'jac-sch'); fs.mkdirSync(dir, { recursive: true });
            const schPath = path.join(dir, 'erc.kicad_sch'); fs.writeFileSync(schPath, schematic.emit());
            const rpt = path.join(dir, 'erc.rpt');
            await new Promise<void>((resolve) => {
                const pr = spawn(kicadPaths!.cli, ['sch', 'erc', '--output', rpt, schPath], { windowsHide: true, stdio: 'ignore' });
                pr.on('exit', () => resolve()); pr.on('error', () => resolve());
            });
            let report = ''; try { report = fs.readFileSync(rpt, 'utf8'); } catch { /* */ }
            return { text: report ? report.slice(0, 2000) : 'ERC ran (no issues reported).', isError: false };
        }
        return { text: `Unknown schematic tool: ${qualifiedName}`, isError: true };
    } catch (e) {
        return { text: `Schematic error: ${String((e as Error).message ?? e)}`, isError: true };
    }
}

async function callBuiltin(qualifiedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    if (qualifiedName.startsWith('jac__sch_')) return callSchBuiltin(qualifiedName, args);
    if (qualifiedName.startsWith('jac__pcb_')) return callPcbBuiltin(qualifiedName, args);
    if (qualifiedName.startsWith('jac__cad_import_model') || qualifiedName.startsWith('jac__gen3d_')) return callGen3dBuiltin(qualifiedName, args);
    if (qualifiedName.startsWith('jac__cad_')) return callCadBuiltin(qualifiedName, args);
    try {
        if (qualifiedName === 'jac__add_mcp_server') {
            const name = String(args.name ?? '').trim();
            const command = String(args.command ?? '').trim();
            if (!name || !command) return { text: 'Both "name" and "command" are required.', isError: true };
            const serverArgs = Array.isArray(args.args) ? args.args.map(String) : [];
            const env = (args.env && typeof args.env === 'object') ? args.env as Record<string, string> : undefined;
            config.mcpServers = { ...config.mcpServers, [name]: { command, args: serverArgs, ...(env ? { env } : {}) } };
            saveConfig(config);
            await mcpManager.reload(config.mcpServers);
            await new Promise(r => setTimeout(r, 1800));   // give it a moment to hand-shake
            const st = mcpManager.status().find(s => s.name === name);
            const ok = st?.status === 'ready';
            return {
                text: `Server "${name}" saved. Status: ${st?.status ?? 'unknown'}${st?.error ? ` (${st.error})` : ''}, ${st?.toolCount ?? 0} tools.`,
                isError: !ok,
            };
        }
        if (qualifiedName === 'jac__list_mcp_servers') {
            return { text: JSON.stringify(mcpManager.status()), isError: false };
        }
        if (qualifiedName === 'jac__remove_mcp_server') {
            const name = String(args.name ?? '').trim();
            if (!(name in config.mcpServers)) return { text: `No configured server named "${name}".`, isError: true };
            const next = { ...config.mcpServers }; delete next[name];
            config.mcpServers = next; saveConfig(config);
            await mcpManager.reload(config.mcpServers);
            return { text: `Removed server "${name}".`, isError: false };
        }
        if (qualifiedName === 'jac__ui_open_panel') {
            const valid = ['chat','schematic','pcb','cad','music','capture','mcp','models','workflow','stocks','neuro','settings'];
            const validDirs = ['right','left','above','below','tab'];
            const panel = String(args.panel ?? '').trim().toLowerCase();
            const direction = args.direction ? String(args.direction).trim().toLowerCase() : 'right';
            if (!valid.includes(panel)) return { text: `Unknown panel "${panel}". Valid: ${valid.join(', ')}`, isError: true };
            if (!validDirs.includes(direction)) return { text: `Unknown direction "${direction}". Valid: ${validDirs.join(', ')}`, isError: true };
            mainWindow?.webContents.send('relay-message', { type: 'ui_open_panel', panel, direction });
            return { text: `Opened panel: ${panel}${direction !== 'tab' ? ` (split ${direction})` : ''}`, isError: false };
        }
        return { text: `Unknown built-in tool: ${qualifiedName}`, isError: true };
    } catch (e) {
        return { text: `Built-in error: ${String((e as Error).message ?? e)}`, isError: true };
    }
}

// OR state
let orModels: ORModel[] = [];
// The folder the current chat is anchored to (from the renderer's set_cwd). Injected into
// every model query so tool-capable models know where to look instead of scanning whole drives.
let activeCwd = '';
// The current PROJECT the history dropdown is scoped to (persisted across restarts). Updated as the
// user browses into a project or starts a conversation in one; stays put over non-project browsing.
let lastProject = config.lastCwd || '';
let currentModel = config.lastModel || config.defaultModel || '';   // restored across restarts
let orAbort: AbortController | null = null;
const CLAUDE_FALLBACK_IDS = new Set(['sonnet', 'opus', 'haiku']);

function isORModel(id: string): boolean { return id.startsWith('or:'); }

function buildSystemMessage(cwd: string): string {
    return (
        `You are JAC, an AI assistant inside a full-featured hardware + software IDE.\n` +
        (cwd ? `Working directory: ${cwd}\nResolve relative paths against it; begin file searches there.\n` : '') +
        `\nJAC capabilities:\n` +
        `- Software: read/write/edit files, run shell commands, search code, debug, refactor.\n` +
        `- Schematic capture (tools: pcb_*, sch_*): place components, wire nets, run ERC, export .kicad_sch. Use sch_* tools for real KiCad parts.\n` +
        `- PCB layout (interactive UI in the PCB panel — NOT via AI tools): drag-and-drop footprint placement, interactive trace routing (KiCad WASM router, multi-layer, vias), copper pours/ground planes, DRC with violations on canvas, Gerber/BOM export for JLCPCB/PCBWay. After you build the schematic, tell the user to switch to the PCB panel for physical layout.\n` +
        `- 3D CAD (tools: cad_*): parametric solid modeling via build123d.\n` +
        `- To open a panel: use the ui_open_panel tool with direction="right" to split alongside chat (panels: chat, schematic, pcb, cad, music, capture, stocks, mcp, models, workflow, settings).\n` +
        `IMPORTANT: Do NOT say PCB layout is unavailable — it is fully supported in JAC's PCB panel; you just can't drive it through tools. Direct the user there.`
    );
}

// Ollama state
let ollamaModels: ORModel[] = [];
let ollamaAbort: AbortController | null = null;
let ollamaPollTimer: ReturnType<typeof setTimeout> | null = null;
let lastOllamaLocalList: unknown[] = [];

function isOllamaModel(id: string): boolean { return id.startsWith('ollama:'); }

// Local jac-llm-server (OpenAI-compatible, :8787) state
const LOCAL_SERVER_URL = 'http://localhost:8787';
let lastLocalServerList: unknown[] = [];
let localSrvAbort: AbortController | null = null;
let localSrvPollTimer: ReturnType<typeof setTimeout> | null = null;
function isLocalServerModel(id: string): boolean { return id.startsWith('local:'); }

// Bundled jac-llm-server process management — auto-start so local models "just work".
let localServerChild: ReturnType<typeof spawn> | null = null;
function localServerDir(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'llama-server')
        : path.join(__dirname, '../../resources/llama-server');
}
// Behavior-steering control vectors live here; the generator runs in a dedicated venv
// (the global Python's torch/safetensors are unusable on this setup).
const STEER_DIR = path.join(os.homedir(), '.jac', 'steer');
function steerPython(): string {
    const venv = path.join(os.homedir(), '.jac', 'steer-venv', 'Scripts', 'python.exe');
    return fs.existsSync(venv) ? venv : pythonExe();
}
function resolveLocalModel(): string {
    if (config.localModelPath && fs.existsSync(config.localModelPath)) return config.localModelPath;
    const dirs = [
        path.join(app.getPath('userData'), 'models'),                    // downloaded (first run)
        app.isPackaged ? path.join(process.resourcesPath, 'models')
                       : path.join(__dirname, '../../resources/models'),  // bundled (if any)
    ];
    for (const dir of dirs) {
        try {
            const g = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith('.gguf'));
            if (g) return path.join(dir, g);
        } catch { /* dir missing */ }
    }
    return '';
}
// Small draft model for speculative decoding — must share the main model's tokenizer. Explicit config
// wins; otherwise auto-detect a small GGUF (name-hinted) sitting next to the models.
function resolveDraftModel(): string {
    if (config.localDraftModelPath && fs.existsSync(config.localDraftModelPath)) return config.localDraftModelPath;
    const main = resolveLocalModel();
    const dirs = [
        path.join(app.getPath('userData'), 'models'),
        main ? path.dirname(main) : '',
        app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, '../../resources/models'),
    ].filter(Boolean);
    for (const dir of dirs) {
        try {
            const cand = fs.readdirSync(dir).find(f =>
                f.toLowerCase().endsWith('.gguf') &&
                path.join(dir, f) !== main &&
                /draft|1b|0\.5b|-3\.2-1|1\.5b/i.test(f));
            if (cand) return path.join(dir, cand);
        } catch { /* dir missing */ }
    }
    return '';
}
async function startLocalServer(): Promise<void> {
    // Already serving (e.g. a manually-started instance)? Reuse it.
    try {
        const r = await fetch(`${LOCAL_SERVER_URL}/v1/models`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) return;
    } catch { /* not up — start it */ }
    const exe = path.join(localServerDir(), process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    const model = resolveLocalModel();
    if (!fs.existsSync(exe) || !model) return; // no binary or no model → nothing to start yet
    try {
        const args = ['-m', model, '--port', '8787', '--host', '127.0.0.1', '-ngl', String(config.localNgl ?? 999), '-c', '4096'];
        // Speculative decoding only pays off when the main is slow-per-token, i.e. big enough to PAGE off
        // NVMe (measured ~2× there). On a model that FITS VRAM it's a wash — the draft's own passes cancel
        // the gain — so don't add the overhead. Honor an explicit draft always; auto-detect only for paged mains.
        let mainGB = 0; try { mainGB = fs.statSync(model).size / 1073741824; } catch { /* stat failed */ }
        const draft = (config.localDraftModelPath && fs.existsSync(config.localDraftModelPath))
            ? config.localDraftModelPath
            : (mainGB > 22 ? resolveDraftModel() : '');
        if (draft) {
            // Draft proposes up to 16 tokens; the paged main verifies a block per (expensive) forward pass.
            // -ngld 999 = draft fully on GPU; --draft-p-min is a probability accept-gate (lightweight stand-in
            // for DSpark's trained confidence head).
            args.push('-md', draft, '-ngld', '999', '--draft-max', '16', '--draft-min', '1', '--draft-p-min', '0.75');
        }
        // Behavior steering: apply active control vectors. llama.cpp's --control-vector-scaled
        // takes ONE arg "FNAME:SCALE,..." and splits on the first ':', which collides with the
        // Windows drive-colon — so we run from STEER_DIR and reference vectors by basename.
        let spawnCwd = localServerDir();
        const activeVecs = (config.steerVectors || [])
            .filter(v => (config.steerScales?.[v.id] ?? 0) && v.path && fs.existsSync(v.path));
        if (activeVecs.length) {
            const spec = activeVecs.map(v => `${path.basename(v.path)}:${config.steerScales[v.id]}`).join(',');
            args.push('--control-vector-scaled', spec);
            spawnCwd = STEER_DIR;   // exe-dir DLLs still load regardless of cwd
        }
        localServerChild = spawn(exe, args, { cwd: spawnCwd, windowsHide: true, stdio: 'ignore' });
        localServerChild.on('exit', () => { localServerChild = null; });
    } catch { /* spawn failed */ }
}
function stopLocalServer(): void {
    if (localServerChild) { try { localServerChild.kill(); } catch { /* ignore */ } localServerChild = null; }
}

// Auto-update via electron-updater (GitHub Releases feed). Packaged builds only.
let updateReady = false;
function setupAutoUpdate(): void {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
        updateReady = true;
        try { new Notification({ title: 'JAC update ready', body: `Version ${info.version} downloaded — installs next time you quit JAC.` }).show(); } catch { /* ignore */ }
        mainWindow?.webContents.send('relay-message', { type: 'update_downloaded', version: info.version });
    });
    autoUpdater.on('error', () => { /* offline or no release yet — ignore */ });
    let lastCheck = 0;
    const check = () => { lastCheck = Date.now(); autoUpdater.checkForUpdates().catch(() => {}); };
    check();                                            // on launch
    setInterval(check, 15 * 60 * 1000);                 // …then every 15 min
    app.on('browser-window-focus', () => {              // …and whenever JAC regains focus (throttled to 5 min)
        if (Date.now() - lastCheck > 5 * 60 * 1000) check();
    });
}
function checkForUpdatesNow(): void {
    if (!app.isPackaged) { try { new Notification({ title: 'JAC', body: 'Updates only work in the installed app.' }).show(); } catch { /* ignore */ } return; }
    if (updateReady) { autoUpdater.quitAndInstall(); return; }
    autoUpdater.checkForUpdates().catch(() => {});
    try { new Notification({ title: 'JAC', body: 'Checking for updates…' }).show(); } catch { /* ignore */ }
}
function restartLocalServer(): void {
    stopLocalServer();
    setTimeout(() => { startLocalServer(); }, 600); // let :8787 free up
}

// First-run model acquisition (app ships without a model).
const CURATED_MODEL = {
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    filename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    label: 'Llama 3.2 3B Instruct (Q4)',
    sizeGB: 2.0,
};
function modelsDownloadDir(): string {
    const dir = path.join(app.getPath('userData'), 'models');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    return dir;
}
let modelDownloadAbort: AbortController | null = null;
async function downloadCuratedModel(): Promise<{ ok: boolean; path?: string; error?: string }> {
    modelDownloadAbort?.abort();
    modelDownloadAbort = new AbortController();
    const dest = path.join(modelsDownloadDir(), CURATED_MODEL.filename);
    const tmp = dest + '.part';
    const send = (p: Record<string, unknown>) => mainWindow?.webContents.send('model-download-progress', p);
    try {
        const res = await fetch(CURATED_MODEL.url, { signal: modelDownloadAbort.signal });
        if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
        const total = Number(res.headers.get('content-length')) || 0;
        const out = fs.createWriteStream(tmp);
        const reader = res.body.getReader();
        let received = 0, lastPct = -1;
        send({ status: 'start', total, label: CURATED_MODEL.label });
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            out.write(Buffer.from(value));
            received += value.length;
            const pct = total ? Math.floor((received / total) * 100) : 0;
            if (pct !== lastPct) { lastPct = pct; send({ status: 'progress', pct, received, total }); }
        }
        await new Promise<void>(r => out.end(() => r()));
        fs.renameSync(tmp, dest);
        config.localModelPath = dest; saveConfig(config);
        restartLocalServer();
        send({ status: 'done', path: dest });
        return { ok: true, path: dest };
    } catch (err: any) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
        if (err.name === 'AbortError') { send({ status: 'canceled' }); return { ok: false, error: 'canceled' }; }
        send({ status: 'error', error: String(err.message) });
        return { ok: false, error: String(err.message) };
    } finally { modelDownloadAbort = null; }
}

function fmtBytes(b: number): string {
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
    return b + ' B';
}

async function pollOllamaModels(): Promise<void> {
    if (ollamaPollTimer) clearTimeout(ollamaPollTimer);
    try {
        const [tagsRes, psRes] = await Promise.all([
            fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) }),
            fetch('http://localhost:11434/api/ps',   { signal: AbortSignal.timeout(2000) }),
        ]);
        if (tagsRes.ok) {
            const tags = await tagsRes.json() as { models: Array<{ name: string; size: number; details?: { parameter_size?: string } }> };
            const ps   = psRes.ok ? (await psRes.json() as { models: Array<{ name: string }> }) : { models: [] };
            const hotNames = new Set((ps.models || []).map((m: { name: string }) => m.name));

            const prev = ollamaModels.map(m => m.id).join(',');
            ollamaModels = [];   // cleared — Ollama models go to LOCAL tab only

            lastOllamaLocalList = (tags.models || []).map(m => ({
                id: `ollama:${m.name}`,
                label: m.name,
                size: fmtBytes(m.size),
                status: 'ready',
                est_tok_s: hotNames.has(m.name) ? 40 : undefined,
            }));

            pushLocalModels();
        }
    } catch { /* Ollama not running */ }
    ollamaPollTimer = setTimeout(pollOllamaModels, 10000);
}

async function handleOllamaQuery(msg: Record<string, unknown>, modelName: string): Promise<void> {
    ollamaAbort?.abort();
    ollamaAbort = new AbortController();

    const prompt = msg.prompt as string;
    const rawHistory = (msg.history as Array<{ role: string; text: string }> | undefined) || [];
    const cwd = (msg.cwd as string) || activeCwd;
    const messages = [
        { role: 'system', content: buildSystemMessage(cwd) },
        ...rawHistory.map(h => ({ role: h.role, content: h.text })),
        { role: 'user', content: prompt },
    ];

    const send = (delta: Record<string, unknown>) => mainWindow?.webContents.send('relay-message', delta);

    try {
        const res = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName, messages, stream: true }),
            signal: ollamaAbort.signal,
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        send({ type: 'stream_start' });

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
                    if (obj.message?.content) send({ type: 'stream_chunk', text: obj.message.content });
                    if (obj.done) send({ type: 'stream_end' });
                } catch { /* skip malformed */ }
            }
        }
    } catch (err: any) {
        if (err.name !== 'AbortError') send({ type: 'error', message: String(err.message) });
    }
    ollamaAbort = null;
}

// Combined local-tab list = Ollama models + local jac-llm-server models.
function pushLocalModels(): void {
    const models = [...(lastOllamaLocalList as unknown[]), ...(lastLocalServerList as unknown[])];
    mainWindow?.webContents.send('relay-message', { type: 'local_models_list', models });
}

async function pollLocalServerModels(): Promise<void> {
    if (localSrvPollTimer) clearTimeout(localSrvPollTimer);
    try {
        const res = await fetch(`${LOCAL_SERVER_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
            const data = await res.json() as { data?: Array<{ id: string }> };
            lastLocalServerList = (data.data || []).map(m => ({
                id: `local:${m.id}`,
                label: `${String(m.id).replace(/.*[\\/]/, '').replace(/\.gguf$/i, '')} (local)`,
                size: '',
                status: 'ready',
                provider_id: 'local-srv',
            }));
            pushLocalModels();
        }
    } catch { lastLocalServerList = []; }
    localSrvPollTimer = setTimeout(pollLocalServerModels, 10000);
}

async function handleLocalServerQuery(msg: Record<string, unknown>, modelId: string): Promise<void> {
    localSrvAbort?.abort();
    localSrvAbort = new AbortController();
    const prompt = msg.prompt as string;
    const rawHistory = (msg.history as Array<{ role: string; text: string }> | undefined) || [];
    const cwd = (msg.cwd as string) || activeCwd;
    const messages = [
        { role: 'system', content: buildSystemMessage(cwd) },
        ...rawHistory.map(h => ({ role: h.role, content: h.text })),
        { role: 'user', content: prompt },
    ];
    const send = (delta: Record<string, unknown>) => mainWindow?.webContents.send('relay-message', delta);
    try {
        const res = await fetch(`${LOCAL_SERVER_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId, messages, stream: true }),
            signal: localSrvAbort.signal,
        });
        if (!res.ok) { send({ type: 'error', message: `Local server ${res.status}: ${await res.text()}` }); localSrvAbort = null; return; }
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        send({ type: 'stream_start' });
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
                if (payload === '[DONE]') { send({ type: 'stream_end' }); continue; }
                try {
                    const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
                    const txt = obj.choices?.[0]?.delta?.content;
                    if (txt) send({ type: 'stream_chunk', text: txt });
                } catch { /* skip malformed SSE */ }
            }
        }
        send({ type: 'stream_end' });
    } catch (err: any) {
        if (err.name !== 'AbortError') send({ type: 'error', message: String(err.message) });
    }
    localSrvAbort = null;
}

function mergeModelsForUI(relayModels: ORModel[]): { models: ORModel[]; current_model: string } {
    // Only filter Claude fallbacks once OR models are actually loaded
    const shouldFilter = config.openrouterApiKey && orModels.length > 0;
    const filtered = shouldFilter
        ? relayModels.filter(m => !CLAUDE_FALLBACK_IDS.has(m.id))
        : relayModels;
    const combined = [...ollamaModels, ...orModels, ...filtered];
    // If current model was filtered out, default to first OR model
    const cur = combined.find(m => m.id === currentModel)
        ? currentModel
        : (orModels[0]?.id ?? '');
    return { models: combined, current_model: cur };
}

let pushCount = 0;
let lastRelayModelsSent: string[] = [];
let lastRelayModelsReceived: string[] = [];

function pushModelsToUI(): void {
    const { models, current_model } = mergeModelsForUI([]);
    if (models.length === 0) return;
    pushCount++;
    lastRelayModelsSent = models.slice(0, 3).map(m => m.id);
    mainWindow?.webContents.send('relay-message', { type: 'models_list', models, current_model });
}

async function handleORQuery(msg: Record<string, unknown>, modelId: string): Promise<void> {
    orAbort?.abort();
    orAbort = new AbortController();

    const prompt = msg.prompt as string;
    const rawHistory = (msg.history as Array<{ role: string; text: string }> | undefined) || [];
    const cwd = (msg.cwd as string) || activeCwd;
    const messages = [
        { role: 'system', content: buildSystemMessage(cwd) },
        ...rawHistory.map(h => ({ role: h.role, content: h.text })),
        { role: 'user', content: prompt },
    ];
    const send = (delta: Record<string, unknown>) => mainWindow?.webContents.send('relay-message', delta);

    // Tools = live MCP tools + JAC-native meta-tools (always present). Route tool-capable models
    // through the agentic loop; plain chat otherwise.
    const tools = [...mcpManager.getTools(), ...MCP_BUILTINS];
    const model = orModels.find(m => m.id === modelId);
    if (model?.supportsTools) {
        await runAgenticQuery({
            url: 'https://openrouter.ai/api/v1/chat/completions',
            headers: {
                'Authorization': `Bearer ${config.openrouterApiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://jac.app',
                'X-Title': 'JAC',
            },
            model: modelId.replace(/^or:/, ''),
            messages, tools,
            callTool: (n, a) => (n.startsWith('jac__') ? callBuiltin(n, a) : mcpManager.callTool(n, a)),
            send, signal: orAbort.signal,
            permit: (name, a) => decidePermission(name, a),
        });
    } else {
        await queryOR(config.openrouterApiKey, modelId, messages, send, orAbort.signal);
    }
    orAbort = null;
}

function createWindow(): BrowserWindowType {
    const win = new BrowserWindow({
        width: config.windowBounds.width,
        height: config.windowBounds.height,
        minWidth: 480,
        minHeight: 400,
        title: 'JAC',
        icon: path.join(__dirname, '../../assets/icon.png'),
        backgroundColor: '#1e1e1e',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        titleBarOverlay: { color: '#191919', symbolColor: '#cccccc', height: 32 },
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile(path.join(__dirname, '../renderer/index.html'));

    // TEMP DIAG: forward renderer console to the main log so we can see explorer errors
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        console.log(`[rndr:${level}] ${message} @ ${sourceId}:${line}`);
    });

    win.on('resize', () => {
        const [width, height] = win.getSize();
        config.windowBounds = { width, height };
        saveConfig(config);
    });

    win.on('close', (e) => {
        // Hide to tray instead of quitting
        e.preventDefault();
        win.hide();
    });

    return win;
}

function createTray(): void {
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    const icon = fs.existsSync(iconPath)
        ? nativeImage.createFromPath(iconPath)
        : nativeImage.createEmpty();

    tray = new Tray(icon);
    tray.setToolTip('JAC');

    const updateMenu = () => {
        const pendingFindings = scheduler?.getPendingFindings() ?? [];
        const menu = Menu.buildFromTemplate([
            {
                label: 'Open JAC',
                click: () => { mainWindow?.show(); mainWindow?.focus(); },
            },
            { type: 'separator' },
            ...(pendingFindings.length > 0 ? [
                {
                    label: `${pendingFindings.length} new finding${pendingFindings.length > 1 ? 's' : ''}`,
                    enabled: false,
                },
                ...pendingFindings.slice(0, 3).map(f => ({
                    label: `  ${f.taskName}: ${f.summary.substring(0, 40)}...`,
                    click: () => { mainWindow?.show(); mainWindow?.focus(); },
                })),
                { type: 'separator' as const },
            ] : []),
            {
                label: 'Research Tasks',
                submenu: scheduler?.getTaskNames().map(name => ({
                    label: name,
                    click: () => scheduler?.runNow(name),
                })) ?? [],
            },
            { type: 'separator' },
            {
                label: 'Check for Updates…',
                click: () => { checkForUpdatesNow(); },
            },
            { type: 'separator' },
            {
                label: 'Quit JAC',
                click: () => { app.quit(); },
            },
        ]);
        tray!.setContextMenu(menu);
    };

    tray.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });

    updateMenu();
    scheduler?.on('taskComplete', updateMenu);
    scheduler?.on('taskComplete', (finding: { taskName: string; summary: string }) => {
        new Notification({
            title: `JAC: ${finding.taskName}`,
            body: finding.summary.substring(0, 120),
        }).show();
    });
}

// Forward relay messages from wsClient to renderer
interface SerializedMsg {
    role: 'user' | 'assistant';
    text: string;
    tools?: Array<{ name: string; id: string; args: Record<string, unknown>; result?: string; isError?: boolean }>;
    timestamp: number;
}

function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return (content as Array<Record<string, unknown>>)
            .map(c => c.type === 'text' ? String(c.text) : c.type === 'image' ? '[image]' : '')
            .filter(Boolean).join('\n');
    }
    return String(content ?? '');
}

// Locate Claude Code's project dir for a cwd. It encodes every path separator (/, \, :) and space → '-'.
function resolveClaudeProjectDir(cwd: string): string | null {
    if (!cwd) return null;
    const encoded = cwd.replace(/[\\/: ]/g, '-');
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    let projectDir = path.join(projectsRoot, encoded);
    if (!fs.existsSync(projectDir)) {
        // drive-letter case differs between sessions (C:\ vs c:\) — match case-insensitively
        try {
            const match = fs.readdirSync(projectsRoot).find(dir => dir.toLowerCase() === encoded.toLowerCase());
            if (match) projectDir = path.join(projectsRoot, match);
        } catch { return null; }
    }
    return fs.existsSync(projectDir) ? projectDir : null;
}

// Parse one Claude Code .jsonl transcript into JAC's SerializedMsg[] (text + tool calls/results).
function parseClaudeJsonl(jsonlPath: string): SerializedMsg[] {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    const messages: SerializedMsg[] = [];
    const pendingTools = new Map<string, SerializedMsg>();   // tool_use_id → owning assistant msg
    for (const line of lines) {
        try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (obj.type !== 'user' && obj.type !== 'assistant') continue;
            const msg = obj.message as Record<string, unknown> | undefined;
            if (!msg) continue;
            const role = msg.role as 'user' | 'assistant';
            const content = msg.content;
            const ts = new Date(obj.timestamp as string).getTime() || Date.now();
            const blocks = typeof content === 'string'
                ? [{ type: 'text', text: content }]
                : (Array.isArray(content) ? content as Array<Record<string, unknown>> : []);
            const textParts: string[] = [];
            const toolUses: Array<{ name: string; id: string; args: Record<string, unknown> }> = [];
            const toolResults: Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> = [];
            for (const block of blocks) {
                if (block.type === 'text') textParts.push(String(block.text ?? ''));
                else if (block.type === 'tool_use') toolUses.push({ name: String(block.name), id: String(block.id), args: (block.input as Record<string, unknown>) ?? {} });
                else if (block.type === 'tool_result') toolResults.push({ tool_use_id: String(block.tool_use_id), content: block.content, is_error: Boolean(block.is_error) });
            }
            for (const tr of toolResults) {
                const ownerMsg = pendingTools.get(tr.tool_use_id);
                if (ownerMsg?.tools) {
                    const tool = ownerMsg.tools.find(t => t.id === tr.tool_use_id);
                    if (tool) { tool.result = toolResultText(tr.content); tool.isError = tr.is_error; }
                }
                pendingTools.delete(tr.tool_use_id);
            }
            const text = textParts.join('\n').trim();
            if (!text && !toolUses.length) continue;
            const serialized: SerializedMsg = { role, text, timestamp: ts };
            if (toolUses.length) {
                serialized.tools = toolUses.map(tu => ({ name: tu.name, id: tu.id, args: tu.args }));
                for (const tu of toolUses) pendingTools.set(tu.id, serialized);
            }
            messages.push(serialized);
        } catch { /* skip malformed lines */ }
    }
    return messages;
}

// Cheap title + folder from a session file — reads only the first 64KB (sessions can be 100MB+),
// finding the first real user message (skips IDE-injected <ide_opened_file> openers) and the cwd.
function claudeSessionInfo(jsonlPath: string): { title: string; folder: string } {
    let fd: number | undefined;
    let title = '', folder = '';
    try {
        fd = fs.openSync(jsonlPath, 'r');
        const buf = Buffer.alloc(65536);
        const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        for (const line of buf.toString('utf8', 0, bytes).split('\n')) {
            if (!line.trim()) continue;
            let obj: Record<string, unknown>;
            try { obj = JSON.parse(line); } catch { continue; }   // last line may be truncated by the 64KB cut
            if (!folder && typeof obj.cwd === 'string') folder = path.basename(obj.cwd as string);
            if (!title && obj.type === 'user' && obj.message) {
                const c = (obj.message as Record<string, unknown>).content;
                let t = typeof c === 'string' ? c
                    : Array.isArray(c) ? String((c.find((b: Record<string, unknown>) => b.type === 'text') as Record<string, unknown> | undefined)?.text ?? '') : '';
                t = t.trim();
                if (t && !t.startsWith('<')) title = t.replace(/\s+/g, ' ').slice(0, 48);
            }
            if (title && folder) break;
        }
    } catch { /* unreadable */ }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* */ } } }
    return { title: title || 'Claude Code session', folder };
}

// Walk up from a browsed folder to the nearest ancestor that actually has Claude Code sessions — that's
// the "project." Returns '' if the area isn't a project (home, Desktop) so history can stay on the last one.
function resolveProjectDir(cwd: string): string {
    let p = cwd;
    for (let i = 0; i < 12 && p; i++) {
        const dir = resolveClaudeProjectDir(p);
        if (dir) { try { if (fs.readdirSync(dir).some(f => f.endsWith('.jsonl'))) return p; } catch { /* */ } }
        const parent = path.dirname(p);
        if (!parent || parent === p) break;
        p = parent;
    }
    return '';
}

// This PROJECT's Claude Code sessions, most-recent first — scoped so switching projects switches history.
// Browsing subfolders resolves UP to the project; browsing a non-project area keeps the last project.
// Only stats the project's files (cheap) + reads a 64KB title for each; a ⟢ glyph marks origin.
function listClaudeSessions(cwd: string): Array<{ id: string; title: string; timestamp: number; source: string }> {
    try {
        const resolved = resolveProjectDir(cwd || '');
        if (resolved && resolved !== lastProject) {   // switched into a different project → remember + persist
            lastProject = resolved;
            config.lastCwd = resolved;
            saveConfig(config);
        }
        const project = lastProject || resolved || cwd;
        const dir = resolveClaudeProjectDir(project);
        if (!dir) return [];
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
                const full = path.join(dir, f);
                let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch { /* */ }
                return { file: f, full, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 30)
            .map(f => ({ id: 'cc:' + f.file, title: `⟢ ${claudeSessionInfo(f.full).title}`, timestamp: f.mtime, source: 'claude' }));
    } catch { return []; }
}

// Load a Claude Code session by id ('cc:<file>') for read-only viewing. The uuid filename is globally
// unique, so search all project dirs (cwd-preferred) — restore works regardless of the current workspace.
function loadClaudeSession(cwd: string, id: string): SerializedMsg[] | null {
    try {
        const file = id.replace(/^cc:/, '');
        if (!/^[\w.\-]+\.jsonl$/.test(file)) return null;   // plain filename only — no path traversal
        const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
        const preferred = resolveClaudeProjectDir(cwd);
        const all = fs.existsSync(projectsRoot)
            ? fs.readdirSync(projectsRoot).map(d => path.join(projectsRoot, d))
            : [];
        const ordered = preferred ? [preferred, ...all.filter(d => d !== preferred)] : all;
        for (const d of ordered) {
            const full = path.join(d, file);
            if (fs.existsSync(full)) return parseClaudeJsonl(full);
        }
        return null;
    } catch { return null; }
}

const historyStore = new Map<string, SerializedMsg[]>();

function setupRelay(): void {
    wsClient = new WSClient(config.relayUrl, config.authToken, {
        onMessage: (msg) => {
            const m = msg as unknown as Record<string, unknown>;
            if (m.type === 'models_list') {
                const relayMods = (m.models as ORModel[] | undefined) ?? [];
                lastRelayModelsReceived = relayMods.slice(0, 3).map(mm => mm.id);
                const { models, current_model } = mergeModelsForUI(relayMods);
                mainWindow?.webContents.send('relay-message', { ...m, models, current_model });
            } else if (m.type === 'local_models_list') {
                // Merge bridge's llama.cpp catalog with our Ollama models
                const bridgeModels = (m.models as unknown[]) ?? [];
                const ollamaList = lastOllamaLocalList;
                const merged = [...ollamaList, ...bridgeModels];
                mainWindow?.webContents.send('relay-message', { ...m, models: merged });
            } else {
                // The relay emits "No provider connected" whenever there's no bridge online.
                // On a local/OR model nothing is ever routed to a provider, so that error is
                // pure noise — swallow it. Keep it for Claude models, where it's legitimate.
                if (m.type === 'error' && m.message === 'No provider connected'
                    && (isORModel(currentModel) || isOllamaModel(currentModel))) {
                    return;
                }
                mainWindow?.webContents.send('relay-message', msg);
            }
        },
        onStatusChange: (status) => {
            mainWindow?.webContents.send('connection-status', status);
        },
    });
    wsClient.connect();
}

// ── PCB / CAD Python backends (spawned like the bundled llama server) ─────────
let pcbServerChild: ReturnType<typeof spawn> | null = null;
const PCB_SERVER_URL = 'http://127.0.0.1:5051';

// Remember the last opened/saved board so Save re-targets the SAME file instead of
// suggesting a generic name (which would overwrite). For a fresh board we suggest a
// name derived from its main IC, uniquified so nothing clobbers an existing project.
let currentPcbProject: string | null = null;
function slugName(s: string): string {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'board';
}
async function suggestPcbProjectPath(dir: string): Promise<string> {
    let base = 'board';
    try {
        const r = await fetch(`${PCB_SERVER_URL}/schematic`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
            const d = await r.json() as { components?: Array<{ type: string }>; library?: Record<string, { name?: string; category?: string }> };
            const lib = d.library || {};
            const ic = (d.components || []).find((c) => (lib[c.type] || {}).category === 'ic');
            if (ic) base = slugName(lib[ic.type]?.name || ic.type);
        }
    } catch { /* server down / empty board — fall back to 'board' */ }
    let name = `${base}.jac`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.jac`;
    return path.join(dir, name);
}

/** Resolve a real Python interpreter (the PATH `python` is often the MS Store stub). */
function pythonExe(): string {
    const home = os.homedir();
    const bundled = path.join(process.resourcesPath, 'python', 'python.exe');   // packaged
    const candidates = [
        bundled,
        path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
        path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
    ];
    for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
    return 'python';
}

/** Directory holding the Python tool servers (dev: jac/server, packaged: resources/server). */
function serverDir(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'server')
        : path.join(__dirname, '..', '..', '..', 'server');
}

async function startPcbServer(): Promise<void> {
    try {
        const r = await fetch(`${PCB_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;   // already running (reuse)
    } catch { /* not up yet */ }
    const script = path.join(serverDir(), 'pcb_tools.py');
    if (!fs.existsSync(script)) { console.log(`[pcb] server script not found: ${script}`); return; }
    try {
        pcbServerChild = spawn(pythonExe(), [script, '5051'], { stdio: 'ignore' });
        pcbServerChild.on('exit', () => { pcbServerChild = null; });
        console.log('[pcb] server starting on :5051');
    } catch (e) { console.log(`[pcb] spawn failed: ${e}`); }
}

function stopPcbServer(): void {
    try { pcbServerChild?.kill(); } catch { /* */ }
    pcbServerChild = null;
}

// ZELDOVICH research server (:5056) — provenance-tiered ledger + solver bridge.
let zeldovichServerChild: ReturnType<typeof spawn> | null = null;
const ZELDOVICH_SERVER_URL = 'http://127.0.0.1:5056';
const ZELDOVICH_DIR = path.join(os.homedir(), 'Desktop', 'Projects', 'research');
async function startZeldovichServer(): Promise<void> {
    try {
        const r = await fetch(`${ZELDOVICH_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;   // already running (reuse)
    } catch { /* not up yet */ }
    const script = path.join(ZELDOVICH_DIR, 'zeldovich_server.py');
    if (!fs.existsSync(script)) { console.log(`[zeldovich] server script not found: ${script}`); return; }
    try {
        zeldovichServerChild = spawn(pythonExe(), [script, '5056'], { cwd: ZELDOVICH_DIR, stdio: 'ignore' });
        zeldovichServerChild.on('exit', () => { zeldovichServerChild = null; });
        console.log('[zeldovich] server starting on :5056');
    } catch (e) { console.log(`[zeldovich] spawn failed: ${e}`); }
}

let cadServerChild: ReturnType<typeof spawn> | null = null;
const CAD_SERVER_URL = 'http://127.0.0.1:5050';

async function startCadServer(): Promise<void> {
    try {
        const r = await fetch(`${CAD_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;
    } catch { /* not up yet */ }
    const script = path.join(serverDir(), 'cad_tools.py');
    if (!fs.existsSync(script)) { console.log(`[cad] server script not found: ${script}`); return; }
    try {
        cadServerChild = spawn(pythonExe(), [script, '5050'], { stdio: 'ignore' });
        cadServerChild.on('exit', () => { cadServerChild = null; });
        console.log('[cad] server starting on :5050 (build123d)');
    } catch (e) { console.log(`[cad] spawn failed: ${e}`); }
}

function stopCadServer(): void {
    try { cadServerChild?.kill(); } catch { /* */ }
    cadServerChild = null;
}

// ── Neural-surgery server (:5055) — HF model resident for neuron attribution + live edits ──
let surgeryServerChild: ReturnType<typeof spawn> | null = null;
async function startSurgeryServer(): Promise<void> {
    try {
        const r = await fetch('http://127.0.0.1:5055/info', { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;
    } catch { /* not up yet */ }
    const script = app.isPackaged
        ? path.join(process.resourcesPath, 'steer', 'surgery_server.py')
        : path.join(__dirname, '..', '..', 'resources', 'steer', 'surgery_server.py');
    const hf = config.steerHfModelPath;
    if (!fs.existsSync(script) || !hf || !fs.existsSync(hf)) { console.log('[surgery] script or HF model missing; not starting'); return; }
    try {
        surgeryServerChild = spawn(steerPython(), [script, '5055', hf], { windowsHide: true, stdio: 'ignore' });
        surgeryServerChild.on('exit', () => { surgeryServerChild = null; });
        console.log('[surgery] server starting on :5055');
    } catch (e) { console.log(`[surgery] spawn failed: ${e}`); }
}
function stopSurgeryServer(): void {
    try { surgeryServerChild?.kill(); } catch { /* */ }
    surgeryServerChild = null;
}

// ── 3D-gen server (:5052) — runs INSIDE WSL where the ROCm/torch env lives ────
// (P2a: hardcoded distro + backend; P2b's detection/installer will make these dynamic.)
let gen3dServerChild: ReturnType<typeof spawn> | null = null;
const GEN3D_DISTRO = 'Ubuntu-24.04';
const GEN3D_WSL_PYTHON = '/root/jac3d/bin/python3';   // venv with torch/TripoSR; stub tolerates any python
const GEN3D_BACKEND: string = 'triposr';               // stub | triposr | trellis
/** Convert a Windows path (C:\a\b) to the /mnt/c/a/b form WSL can exec. */
function winToWslPath(p: string): string {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (!m) return p.replace(/\\/g, '/');
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}
async function startGen3dServer(): Promise<void> {
    try {
        const r = await fetch(`${GEN3D_SERVER_URL}/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;   // already running (reuse)
    } catch { /* not up */ }
    const script = winToWslPath(path.join(serverDir(), 'gen3d_server.py'));
    const py = GEN3D_BACKEND === 'stub' ? 'python3' : GEN3D_WSL_PYTHON;
    try {
        gen3dServerChild = spawn('wsl.exe', ['-d', GEN3D_DISTRO, '--', py, script, '5052', GEN3D_BACKEND], { stdio: 'ignore' });
        gen3dServerChild.on('exit', () => { gen3dServerChild = null; });
        console.log(`[gen3d] server starting on :5052 in WSL (${GEN3D_DISTRO}, backend=${GEN3D_BACKEND})`);
    } catch (e) { console.log(`[gen3d] spawn failed: ${e}`); }
}
function stopGen3dServer(): void {
    try { gen3dServerChild?.kill(); } catch { /* */ }
    gen3dServerChild = null;
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);   // drop the default File/Edit/View/Window/Help bar
    if (process.platform === 'win32') app.setAppUserModelId('com.clifford.jac'); // match electron-builder appId
    // IPC handlers — must be registered after app is ready
    ipcMain.handle('history-load-more', (_e, cwd: string, offset: number) => {
        const all = historyStore.get(cwd);
        if (!all || offset <= 0) return null;
        const PAGE = 50;
        const start = Math.max(0, offset - PAGE);
        return { messages: all.slice(start, offset), newOffset: start, historyTotal: all.length, historyCwd: cwd };
    });
    ipcMain.handle('get-config', () => config);
    // OpenRouter balance for the chat header readout (null if no key / OR unreachable).
    ipcMain.handle('get-or-usage', () => fetchORCredits(config.openrouterApiKey));
    ipcMain.handle('save-config', (_e, updates: Partial<typeof DEFAULT_CONFIG>) => {
        const mcpChanged = 'mcpServers' in updates
            && JSON.stringify(updates.mcpServers) !== JSON.stringify(config.mcpServers);
        const keyChanged = 'openrouterApiKey' in updates
            && updates.openrouterApiKey !== config.openrouterApiKey;
        config = { ...config, ...updates };
        saveConfig(config);
        if (mcpChanged) mcpManager.reload(config.mcpServers);
        // A changed OpenRouter key: re-fetch the model list live so the picker updates without a restart.
        if (keyChanged) {
            if (config.openrouterApiKey) {
                fetchORModels(config.openrouterApiKey)
                    .then((models) => { orModels = models; pushModelsToUI(); })
                    .catch(() => { /* OR unavailable */ });
            } else {
                orModels = [];
                pushModelsToUI();
            }
        }
        return config;
    });
    // MCP: server connection status + flattened tool list (for the settings panel)
    ipcMain.handle('mcp-status', () => mcpManager.status());
    ipcMain.handle('mcp-tools', () => mcpManager.getTools().map(t => ({
        server: t.server, name: t.name, qualifiedName: t.qualifiedName, description: t.description,
    })));
    ipcMain.handle('mcp-reload', () => { mcpManager.reload(config.mcpServers); return mcpManager.status(); });
    ipcMain.handle('get-platform', () => process.platform);
    ipcMain.handle('get-home', () => os.homedir());
    ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url));

    // Run KiCad's real push-and-shove router (ported to WASM) and return the routed polyline.
    ipcMain.handle('kicad-route-demo', async (_e, withObstacle: boolean, mode: string) => {
        try {
            const poly = await routeDemo(!!withObstacle, mode === 'shove' ? 'shove' : 'walkaround');
            return { ok: true, path: poly };
        } catch (err) {
            return { ok: false, error: String(err) };
        }
    });

    // Interactive routing session driven by the PCB canvas (all coords in nanometres).
    ipcMain.handle('kicad-route-setup', async (_e, obstacles: Obstacle[], segments: SegObstacle[], mode: string, tw: number, cl: number) => {
        try { await routeSetup(obstacles || [], segments || [], mode === 'shove' ? 'shove' : 'walkaround', tw, cl); return { ok: true }; }
        catch (err) { return { ok: false, error: String(err) }; }
    });
    ipcMain.handle('kicad-route-start', (_e, x: number, y: number, layer: number) => routeStart(x, y, layer));
    ipcMain.handle('kicad-route-move', (_e, x: number, y: number) => routeMove(x, y));
    ipcMain.handle('kicad-route-finish', (_e, x: number, y: number) => routeFinish(x, y));
    ipcMain.handle('kicad-route-ab', (_e, x1: number, y1: number, x2: number, y2: number, layer: number) => routeAB(x1, y1, x2, y2, layer));

    // Manufacturing: turn a .kicad_pcb into a fab package (Gerbers + drill + pick-and-place, zipped)
    // — the exact bundle a fab house (JLCPCB / PCBWay) takes to make the board.
    ipcMain.handle('kicad-fabricate', async (_e, pcbPath: string, bomPath?: string) => {
        try {
            if (!kicadPaths?.cli) { kicadPaths = findKicad(); }
            if (!kicadPaths?.cli) return { ok: false, error: 'KiCad CLI not found (install KiCad).' };
            if (!fs.existsSync(pcbPath)) return { ok: false, error: 'Board file not found: ' + pcbPath };

            const outDir = path.join(path.dirname(pcbPath), 'fab');
            fs.rmSync(outDir, { recursive: true, force: true });
            fs.mkdirSync(outDir, { recursive: true });

            // Assembly BOM (from the :5051 schematic) rounds out the package with the CPL/pos file.
            if (bomPath && fs.existsSync(bomPath)) {
                try { fs.copyFileSync(bomPath, path.join(outDir, 'bom.csv')); } catch { /* BOM optional */ }
            }

            const run = (args: string[]) => new Promise<void>((res, rej) => {
                const p = spawn(kicadPaths!.cli, args, { windowsHide: true, stdio: 'ignore' });
                p.on('exit', (code) => code === 0 ? res() : rej(new Error('kicad-cli ' + args[1] + ' exit ' + code)));
                p.on('error', rej);
            });
            // Fill copper zones (ground/power planes) into the board first, so the pour plots to gerbers.
            try { await run(['pcb', 'drc', pcbPath, '--refill-zones', '--save-board', '-o', path.join(outDir, '_fill.rpt')]); } catch { /* fill best-effort */ }
            await run(['pcb', 'export', 'gerbers', pcbPath, '-o', outDir + path.sep]);
            await run(['pcb', 'export', 'drill', pcbPath, '-o', outDir + path.sep]);
            try { await run(['pcb', 'export', 'pos', pcbPath, '-o', path.join(outDir, 'pos.csv'), '--format', 'csv', '--units', 'mm']); } catch { /* assembly file optional */ }

            const zip = path.join(path.dirname(pcbPath), 'jac_fab.zip');
            fs.rmSync(zip, { force: true });
            await new Promise<void>((res, rej) => {
                const ps = spawn('powershell', ['-NoProfile', '-Command',
                    `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zip}' -Force`], { windowsHide: true, stdio: 'ignore' });
                ps.on('exit', (code) => code === 0 ? res() : rej(new Error('zip failed')));
                ps.on('error', rej);
            });

            const files = fs.readdirSync(outDir);
            const gerbers = files.filter((f) => /\.(gtl|gbl|gto|gbo|gm1|gbr)$/i.test(f)).length;
            return { ok: true, zip, dir: outDir, files, gerbers, hasDrill: files.some((f) => /\.drl$/i.test(f)),
                hasBom: files.includes('bom.csv'), hasCpl: files.includes('pos.csv') };
        } catch (err) {
            return { ok: false, error: String(err) };
        }
    });

    // Design-Rule Check: run KiCad's real DRC engine on the exported board and return
    // structured violations + unconnected items for the PCB view to list + mark on the canvas.
    ipcMain.handle('kicad-drc', async (_e, pcbPath: string) => {
        try {
            if (!kicadPaths?.cli) { kicadPaths = findKicad(); }
            if (!kicadPaths?.cli) return { ok: false, error: 'KiCad CLI not found (install KiCad).' };
            if (!fs.existsSync(pcbPath)) return { ok: false, error: 'Board file not found: ' + pcbPath };

            const report = path.join(path.dirname(pcbPath), 'drc_report.json');
            fs.rmSync(report, { force: true });
            // DRC exits 0 even when violations exist (only --exit-code-violations changes that),
            // so resolve regardless of exit code and read the report file — like the sch-erc path.
            await new Promise<void>((resolve) => {
                const p = spawn(kicadPaths!.cli, ['pcb', 'drc', pcbPath, '-o', report,
                    '--format', 'json', '--units', 'mm', '--severity-all', '--refill-zones'], { windowsHide: true, stdio: 'ignore' });
                p.on('exit', () => resolve());
                p.on('error', () => resolve());
            });
            if (!fs.existsSync(report)) return { ok: false, error: 'DRC produced no report (kicad-cli pcb drc failed).' };
            const raw = JSON.parse(fs.readFileSync(report, 'utf8'));

            // Findings live in three arrays; every item is {description, pos:{x,y}, uuid}.
            // 'lib_footprint_issues' is pure noise from JAC's synthetic 'jac:' footprint lib — collapse it out.
            const NOISE = 'lib_footprint_issues';
            const norm = (arr: unknown[], kind: string) => (Array.isArray(arr) ? arr : [])
                .filter((v: any) => v.type !== NOISE)
                .map((v: any) => ({
                    kind, type: v.type, severity: v.severity, description: v.description,
                    items: (v.items || []).map((it: any) => ({
                        description: it.description, x: it.pos ? it.pos.x : 0, y: it.pos ? it.pos.y : 0, uuid: it.uuid,
                    })),
                }));
            const findings = [
                ...norm(raw.violations, 'violation'),
                ...norm(raw.unconnected_items, 'unconnected'),
            ];
            const errors = findings.filter((f) => f.severity === 'error').length;
            const warnings = findings.filter((f) => f.severity === 'warning').length;
            const libIssues = (Array.isArray(raw.violations) ? raw.violations : []).filter((v: any) => v.type === NOISE).length;
            return { ok: true, findings, errors, warnings, libIssues, units: raw.coordinate_units || 'mm' };
        } catch (err) {
            return { ok: false, error: String(err) };
        }
    });

    // Search KiCad's real 22k-symbol library so JAC's palette isn't limited to the built-ins.
    ipcMain.handle('kicad-symbol-search', (_e, query: string) => {
        if (!kicadPaths?.symbolsDir) { kicadPaths = findKicad(); }
        if (!kicadPaths?.symbolsDir) return { ok: false, error: 'KiCad symbols not found (install KiCad).' };
        const res = searchCatalog(kicadPaths.symbolsDir, String(query || ''), 24);
        return { ok: true, results: res.map((e) => ({ libId: e.libId, name: e.name, lib: e.libName, desc: e.desc })) };
    });

    // Resolve one symbol → a placeable definition: pins + graphics in JAC world units
    // (KiCad symbol Y is up, so flip), plus the symbol's default footprint / ref prefix / value.
    ipcMain.handle('kicad-symbol-get', (_e, libId: string) => {
        try {
            if (!kicadPaths?.symbolsDir) { kicadPaths = findKicad(); }
            if (!kicadPaths?.symbolsDir) return { ok: false, error: 'KiCad symbols not found.' };
            const e = resolveLibId(kicadPaths.symbolsDir, String(libId));
            if (!e) return { ok: false, error: 'Symbol not found: ' + libId };
            // Derived symbols (extends "Parent") inherit pins + graphics from the parent — follow the chain.
            let pinSrc = e.name;
            let symText = extractSymbol(e.lib, e.name) || '';
            for (let hop = 0; hop < 4; hop++) {
                const ext = symText.match(/\(extends "([^"]+)"/);
                if (!ext) break;
                const parent = extractSymbol(e.lib, ext[1]);
                if (!parent) break;
                pinSrc = ext[1]; symText = parent;
            }
            const S = 8;                                        // world units per mm
            const X = (v: number) => Math.round(v * S), Y = (v: number) => Math.round(-v * S);
            const pins: Record<string, { x: number; y: number; name: string }> = {};
            for (const p of symbolPins(symText)) pins[p.number] = { x: X(p.x), y: Y(p.y), name: p.name };
            const g = symbolGraphics(e.lib, pinSrc);
            const svg: string[] = [];
            for (const r of g.rects) svg.push(`<rect x="${Math.min(X(r[0]), X(r[2]))}" y="${Math.min(Y(r[1]), Y(r[3]))}" width="${Math.abs(X(r[2]) - X(r[0]))}" height="${Math.abs(Y(r[3]) - Y(r[1]))}" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
            for (const pl of g.polylines) { if (pl.length < 2) continue; svg.push(`<polyline points="${pl.map((pt) => `${X(pt[0])},${Y(pt[1])}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5"/>`); }
            for (const c of g.circles) svg.push(`<circle cx="${X(c.x)}" cy="${Y(c.y)}" r="${Math.round(c.r * S)}" fill="none" stroke="currentColor" stroke-width="1.4"/>`);
            const xs: number[] = [], ys: number[] = [];
            Object.keys(pins).forEach((k) => { xs.push(pins[k].x); ys.push(pins[k].y); });
            g.rects.forEach((r) => { xs.push(X(r[0]), X(r[2])); ys.push(Y(r[1]), Y(r[3])); });
            const w = xs.length ? Math.max(...xs) - Math.min(...xs) : 40;
            const h = ys.length ? Math.max(...ys) - Math.min(...ys) : 30;
            return { ok: true, def: {
                libId: e.libId, name: e.name,
                prefix: symbolRefPrefix(e.lib, e.name) || symbolRefPrefix(e.lib, pinSrc),
                value: symbolDefaultValue(e.lib, e.name) || e.name,
                footprint: symbolDefaultFootprint(e.lib, e.name) || symbolDefaultFootprint(e.lib, pinSrc),
                pins, svg: svg.join(''), w: Math.max(w, 20), h: Math.max(h, 16), desc: e.desc } };
        } catch (err) { return { ok: false, error: String(err) }; }
    });

    // Recolor the native window controls (min/max/close overlay) to match the app theme.
    ipcMain.handle('set-titlebar-overlay', (_e, color: string, symbolColor: string) => {
        try { mainWindow?.setTitleBarOverlay?.({ color, symbolColor, height: 32 }); return { ok: true }; }
        catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
    });
    ipcMain.handle('get-pending-findings', () => scheduler?.getPendingFindings() ?? []);
    ipcMain.handle('clear-finding', (_e, id: string) => scheduler?.clearFinding(id));
    ipcMain.handle('run-task-now', (_e, name: string) => scheduler?.runNow(name));
    ipcMain.handle('get-tasks', () => scheduler?.getTasks() ?? []);
    ipcMain.on('relay-send', (_e, rawMsg: unknown) => {
        const msg = rawMsg as Record<string, unknown>;
        const type = msg.type as string;

        // Schematic tab opened/reloaded — push current state.
        if (type === 'sch_request') { pushSchematic(); return; }
        // Native schematic canvas edits (drag/rotate/delete/wire) — mutate the model + re-push.
        if (type === 'sch_edit') {
            const a = msg.action as string;
            if (a === 'move') { const c = schematic.find(String(msg.target)); if (c) { c.x = Number(msg.x); c.y = Number(msg.y); } }
            else if (a === 'rotate') { const c = schematic.find(String(msg.target)); if (c) c.rot = ((Number(msg.rot) % 360) + 360) % 360; }
            else if (a === 'remove') { schematic.remove(String(msg.target)); }
            else if (a === 'add_wire') { schematic.addWire(Number(msg.x1), Number(msg.y1), Number(msg.x2), Number(msg.y2)); }
            pushSchematic();
            return;
        }

        // MCP tool-permission prompt reply — resolve the waiting decidePermission() promise.
        if (type === 'permission_response') {
            const rid = msg.request_id as string;
            const resolver = pendingPermissions.get(rid);
            if (resolver) { pendingPermissions.delete(rid); resolver({ allow: Boolean(msg.allow), remember: Boolean(msg.remember) }); }
            return;
        }

        if (type === 'set_model') {
            currentModel = (msg.model as string) || '';
            config.lastModel = currentModel; saveConfig(config);   // persist so it survives restart
            if (isORModel(currentModel) || isOllamaModel(currentModel) || isLocalServerModel(currentModel)) return;
        }

        if (type === 'get_local_models') {
            pollOllamaModels();
            pollLocalServerModels();
            return;
        }

        if (type === 'set_model_favorites') {
            config.favoriteModels = (msg.favorites as string[]) || [];
            saveConfig(config);
            return;
        }

        if (type === 'set_default_model') {
            config.defaultModel = (msg.model as string) || '';
            saveConfig(config);
            return;
        }

        if (type === 'abort_query' && isORModel(currentModel)) {
            orAbort?.abort();
            orAbort = null;
            return;
        }

        if (type === 'query' && isORModel(currentModel)) {
            handleORQuery(msg, currentModel).catch(err =>
                mainWindow?.webContents.send('relay-message', { type: 'error', message: String(err) })
            );
            return;
        }

        if (type === 'abort_query' && isOllamaModel(currentModel)) {
            ollamaAbort?.abort();
            ollamaAbort = null;
            return;
        }

        if (type === 'query' && isOllamaModel(currentModel)) {
            const modelName = currentModel.slice('ollama:'.length);
            handleOllamaQuery(msg, modelName).catch(err =>
                mainWindow?.webContents.send('relay-message', { type: 'error', message: String(err) })
            );
            return;
        }

        if (type === 'abort_query' && isLocalServerModel(currentModel)) {
            localSrvAbort?.abort();
            localSrvAbort = null;
            return;
        }

        if (type === 'query' && isLocalServerModel(currentModel)) {
            handleLocalServerQuery(msg, currentModel.slice('local:'.length)).catch(err =>
                mainWindow?.webContents.send('relay-message', { type: 'error', message: String(err) })
            );
            return;
        }

        wsClient?.send(msg as any);
    });
    ipcMain.on('relay-send-raw', (_e, rawMsg: unknown) => {
        const m = rawMsg as Record<string, unknown>;
        if (m.type === 'set_cwd') {
            const cwd = m.cwd as string;
            if (cwd) {                       // starting a conversation here makes this the active project
                activeCwd = cwd;
                if (cwd !== lastProject) { lastProject = cwd; config.lastCwd = cwd; saveConfig(config); }
                // Restart (or auto-create) the filesystem MCP server pointed at the new CWD.
                const fsCfg = config.mcpServers['filesystem'];
                if (fsCfg?.command) {
                    // Keep everything up to and including the package name, replace directory args.
                    const args = fsCfg.args ?? [];
                    const pkgIdx = args.findIndex(a => a.includes('server-filesystem'));
                    const newArgs = pkgIdx >= 0 ? [...args.slice(0, pkgIdx + 1), cwd] : [...args, cwd];
                    mcpManager.restartServer('filesystem', { ...fsCfg, args: newArgs });
                } else {
                    // No filesystem server configured — spin one up automatically.
                    mcpManager.restartServer('filesystem', {
                        command: 'npx',
                        args: ['-y', '@modelcontextprotocol/server-filesystem', cwd],
                    });
                }
            }
        }
        wsClient?.sendRaw(m as Record<string, unknown>);
    });

    // Conversation history (persisted to ~/.jac/conversations/)
    const CONV_DIR = path.join(os.homedir(), '.jac', 'conversations');
    const CONV_INDEX = path.join(CONV_DIR, 'index.json');
    const MAX_PER_WORKSPACE = 50;

    function convReadIndex(): unknown[] {
        try { return JSON.parse(fs.readFileSync(CONV_INDEX, 'utf-8')); } catch { return []; }
    }
    function convWriteIndex(idx: unknown[]): void {
        fs.mkdirSync(CONV_DIR, { recursive: true });
        fs.writeFileSync(CONV_INDEX, JSON.stringify(idx));
    }

    ipcMain.handle('conv-save', (_e, messages: unknown[], meta: Record<string, unknown>, workspace: string) => {
        if (!messages || !messages.length) return;
        const id: string = (meta.id as string) || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        fs.mkdirSync(CONV_DIR, { recursive: true });
        fs.writeFileSync(path.join(CONV_DIR, `${id}.json`), JSON.stringify(messages));

        // Authoritative workspace: stamp the project the app currently has open. The renderer's
        // `workspace` arg often arrives unset (→ 'global'), which orphans the conv from per-project
        // history. Main knows the cwd reliably (activeCwd, else the persisted lastProject), so resolve
        // THAT to its project root — the same value get-project-history filters against.
        const base = activeCwd || lastProject || '';
        const ws = resolveProjectDir(base) || base
            || (workspace && workspace !== 'global' ? workspace : '') || 'global';

        // Title = first user message (the dropdown renders entry.title); fixes blank JAC entries.
        const firstUser = (messages as Array<{ role?: string; text?: string }>).find(m => m?.role === 'user');
        const title = (firstUser?.text || 'Conversation').replace(/\s+/g, ' ').trim().slice(0, 56) || 'Conversation';

        let idx = convReadIndex() as Array<Record<string, unknown>>;
        idx = idx.filter(c => c.id !== id);
        idx.unshift({ ...meta, id, workspace: ws, timestamp: Date.now(), title });

        // Keep MAX_PER_WORKSPACE per folder, prune old
        const sameWs = idx.filter(c => c.workspace === ws);
        if (sameWs.length > MAX_PER_WORKSPACE) {
            sameWs.slice(MAX_PER_WORKSPACE).forEach(old => {
                try { fs.unlinkSync(path.join(CONV_DIR, `${old.id}.json`)); } catch {}
            });
        }
        idx = idx.filter(c => c.workspace !== ws || sameWs.indexOf(c) < MAX_PER_WORKSPACE);
        convWriteIndex(idx);
        return id;
    });

    ipcMain.handle('conv-load-index', () => convReadIndex());
    // Claude Code sessions for the folder — merged into the history dropdown (read-only viewing).
    ipcMain.handle('list-claude-sessions', (_e, cwd: string) => listClaudeSessions(cwd || activeCwd));
    // The full history dropdown, scoped to ONE project: that project's Claude Code sessions + its JAC
    // conversations only (browsedCwd resolves up to the project; non-project browsing keeps the last).
    ipcMain.handle('get-project-history', (_e, browsedCwd: string) => {
        const claude = listClaudeSessions(browsedCwd || '');    // resolves + remembers the project
        const jac = (convReadIndex() as Array<Record<string, unknown>>)
            .filter(c => !!c.workspace && c.workspace === lastProject);   // only this project's JAC convs
        return [...claude, ...jac].sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
    });
    ipcMain.handle('load-claude-session', (_e, cwd: string, id: string) => loadClaudeSession(cwd || activeCwd, id));

    ipcMain.handle('conv-load', (_e, id: string) => {
        try { return JSON.parse(fs.readFileSync(path.join(CONV_DIR, `${id}.json`), 'utf-8')); } catch { return null; }
    });

    ipcMain.handle('conv-delete', (_e, id: string) => {
        try { fs.unlinkSync(path.join(CONV_DIR, `${id}.json`)); } catch {}
        convWriteIndex((convReadIndex() as Array<Record<string, unknown>>).filter(c => c.id !== id));
    });

    // Filesystem IPC for sidebar
    ipcMain.handle('fs-list-dir', (_e, dirPath: string) => {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return entries
                .filter(e => !e.name.startsWith('.'))
                .map(e => ({
                    name: e.name,
                    path: path.join(dirPath, e.name),
                    isDir: e.isDirectory(),
                }))
                .sort((a, b) => {
                    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
        } catch { return []; }
    });
    ipcMain.handle('fs-open-in-finder', (_e, dirPath: string) => shell.openPath(dirPath));
    // Read a file for the editor tab: text content, image data URL, or binary metadata.
    ipcMain.handle('fs-read-file', (_e, filePath: string) => {
        try {
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) return { ok: false, error: 'Path is a directory' };
            const ext = path.extname(filePath).toLowerCase();
            const IMG: Record<string, string> = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
                '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
            };
            if (IMG[ext]) {
                if (stat.size > 25 * 1024 * 1024) return { ok: false, error: 'Image too large to preview' };
                const b64 = fs.readFileSync(filePath).toString('base64');
                return { ok: true, kind: 'image', dataUrl: `data:${IMG[ext]};base64,${b64}`, size: stat.size };
            }
            if (stat.size > 5 * 1024 * 1024) return { ok: true, kind: 'binary', size: stat.size };
            const buf = fs.readFileSync(filePath);
            if (buf.subarray(0, 8192).includes(0)) return { ok: true, kind: 'binary', size: stat.size };  // NUL byte => binary
            return { ok: true, kind: 'text', content: buf.toString('utf-8'), ext, size: stat.size };
        } catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
    });
    ipcMain.handle('fs-open-external-file', (_e, filePath: string) => shell.openPath(filePath));
    ipcMain.handle('fs-write-file', (_e, filePath: string, content: string) => {
        try { fs.writeFileSync(filePath, content, 'utf-8'); return { ok: true }; }
        catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
    });
    // Open a 3D model for the CAD viewer: file dialog (or explicit path) -> base64 GLB.
    ipcMain.handle('cad-open-glb', async (_e, explicitPath?: string) => {
        try {
            let filePath = explicitPath;
            if (!filePath) {
                const { dialog } = require('electron');
                const r = await dialog.showOpenDialog({
                    title: 'Open 3D model',
                    filters: [{ name: '3D Models', extensions: ['glb', 'gltf'] }],
                    properties: ['openFile'],
                });
                if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
                filePath = r.filePaths[0];
            }
            const fp: string = filePath as string;
            const stat = fs.statSync(fp);
            if (stat.size > 200 * 1024 * 1024) return { ok: false, error: 'Model too large (>200MB)' };
            return { ok: true, name: path.basename(fp), b64: fs.readFileSync(fp).toString('base64') };
        } catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
    });
    // Save a model exported client-side (STL/GLB) from the CAD viewer: base64 bytes -> save dialog -> disk.
    ipcMain.handle('cad-save-model', async (_e, b64: string, defaultName: string) => {
        try {
            const { dialog } = require('electron');
            const ext = (path.extname(defaultName || '') || '.stl').replace('.', '').toLowerCase();
            const r = await dialog.showSaveDialog(mainWindow!, {
                title: 'Save 3D model',
                defaultPath: defaultName || 'model.stl',
                filters: [{ name: ext.toUpperCase() + ' model', extensions: [ext] }, { name: 'All files', extensions: ['*'] }],
            });
            if (r.canceled || !r.filePath) return { ok: false, canceled: true };
            fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
            return { ok: true, path: r.filePath };
        } catch (e) { return { ok: false, error: String((e as Error).message ?? e) }; }
    });
    ipcMain.handle('dialog-open-folder', async () => {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
    });
    // JAC project (.jac) save/open dialogs — the backend does the actual read/write to the chosen path.
    // PCB projects get a dedicated home under ~/.jac/pcb so boards don't scatter / overwrite each other.
    const PCB_PROJECT_DIR = path.join(os.homedir(), '.jac', 'pcb');
    ipcMain.handle('project-save-dialog', async () => {
        const { dialog } = require('electron');
        fs.mkdirSync(PCB_PROJECT_DIR, { recursive: true });
        // re-target the current project if we have one, else auto-suggest a unique name from the board
        const suggested = currentPcbProject || await suggestPcbProjectPath(PCB_PROJECT_DIR);
        const r = await dialog.showSaveDialog(mainWindow!, {
            title: 'Save JAC project',
            defaultPath: suggested,
            filters: [{ name: 'JAC project', extensions: ['jac'] }, { name: 'All files', extensions: ['*'] }],
        });
        if (r.canceled || !r.filePath) return null;
        currentPcbProject = r.filePath;
        return r.filePath;
    });
    ipcMain.handle('project-open-dialog', async () => {
        const { dialog } = require('electron');
        fs.mkdirSync(PCB_PROJECT_DIR, { recursive: true });
        const r = await dialog.showOpenDialog(mainWindow!, {
            title: 'Open JAC project',
            defaultPath: currentPcbProject || PCB_PROJECT_DIR,
            filters: [{ name: 'JAC project', extensions: ['jac', 'json'] }, { name: 'All files', extensions: ['*'] }],
            properties: ['openFile'],
        });
        if (r.canceled || !r.filePaths[0]) return null;
        currentPcbProject = r.filePaths[0];
        return r.filePaths[0];
    });

    ipcMain.handle('fs-mkdir', (_e, dir: string, name: string) => {
        try {
            const clean = String(name).trim().replace(/[\\/:*?"<>|]/g, '');
            if (!clean) return { ok: false, error: 'Invalid name' };
            const target = path.join(dir, clean);
            if (fs.existsSync(target)) return { ok: false, error: 'Already exists' };
            fs.mkdirSync(target);
            return { ok: true, path: target };
        } catch (err) { return { ok: false, error: String(err) }; }
    });

    ipcMain.handle('fs-rename', (_e, oldPath: string, newName: string) => {
        try {
            const clean = String(newName).trim().replace(/[\\/:*?"<>|]/g, '');
            if (!clean) return { ok: false, error: 'Invalid name' };
            const target = path.join(path.dirname(oldPath), clean);
            if (fs.existsSync(target)) return { ok: false, error: 'Already exists' };
            fs.renameSync(oldPath, target);
            return { ok: true, path: target };
        } catch (err) { return { ok: false, error: String(err) }; }
    });

    ipcMain.handle('fs-trash', async (_e, target: string) => {
        try {
            const { dialog } = require('electron');
            const home = os.homedir();
            const resolved = path.resolve(target);
            // Safety: only trash things inside the user's home, and never home itself.
            if (resolved === home || !resolved.toLowerCase().startsWith(home.toLowerCase() + path.sep)) {
                return { ok: false, error: 'Refused: outside home directory' };
            }
            const choice = await dialog.showMessageBox(mainWindow!, {
                type: 'warning',
                buttons: ['Move to Recycle Bin', 'Cancel'],
                defaultId: 1, cancelId: 1,
                message: `Move "${path.basename(resolved)}" to the Recycle Bin?`,
                detail: resolved,
            });
            if (choice.response !== 0) return { ok: false, canceled: true };
            await shell.trashItem(resolved);
            return { ok: true };
        } catch (err) { return { ok: false, error: String(err) }; }
    });

    // ── Local model acquisition (download recommended / pick a GGUF) ──
    ipcMain.handle('get-recommended-model', () => CURATED_MODEL);
    ipcMain.handle('model-download', () => downloadCuratedModel());
    ipcMain.handle('model-download-cancel', () => { modelDownloadAbort?.abort(); });
    ipcMain.handle('model-pick', async () => {
        const { dialog } = require('electron');
        const r = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openFile'],
            filters: [{ name: 'GGUF models', extensions: ['gguf'] }],
        });
        if (r.canceled || !r.filePaths[0]) return { ok: false };
        config.localModelPath = r.filePaths[0]; saveConfig(config);
        restartLocalServer();
        return { ok: true, path: r.filePaths[0] };
    });

    const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
    const MUSIC_STATE_PATH = path.join(os.homedir(), '.jac', 'music-state.json');

    function scanDir(dir: string, results: Array<{ path: string; name: string; dir: string }> = []) {
        try {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                if (ent.name.startsWith('.')) continue;
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) { scanDir(full, results); }
                else if (AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) {
                    results.push({ path: full, name: ent.name, dir });
                }
            }
        } catch { /* skip unreadable dirs */ }
        return results;
    }

    ipcMain.handle('music-scan', (_e, dirPath: string) => scanDir(dirPath));
    ipcMain.handle('music-read-file', (_e, filePath: string) => {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().slice(1);
        const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'flac' ? 'audio/flac'
            : ext === 'wav' ? 'audio/wav' : ext === 'm4a' ? 'audio/mp4'
            : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg';
        return `data:${mime};base64,${data.toString('base64')}`;
    });
    ipcMain.handle('music-save-state', (_e, state: unknown) => {
        fs.writeFileSync(MUSIC_STATE_PATH, JSON.stringify(state));
    });
    ipcMain.handle('music-load-state', () => {
        try { return JSON.parse(fs.readFileSync(MUSIC_STATE_PATH, 'utf8')); }
        catch { return null; }
    });

    // Banana Slug — system audio capture IPC
    const CAPTURE_DIR = path.join(os.homedir(), '.jac', 'captures');
    ipcMain.handle('capture-setup-loopback', () => {
        const { desktopCapturer, session } = require('electron');
        mainWindow?.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
            desktopCapturer.getSources({ types: ['screen'] }).then((sources: Array<{ id: string }>) => {
                callback({ video: sources[0] as any, audio: 'loopback' as any });
            });
        });
        return true;
    });
    ipcMain.handle('capture-save', (_e, filename: string, data: Uint8Array) => {
        fs.mkdirSync(CAPTURE_DIR, { recursive: true });
        const outPath = path.join(CAPTURE_DIR, filename);
        fs.writeFileSync(outPath, Buffer.from(data));
        return outPath;
    });
    ipcMain.handle('capture-reveal', (_e, filePath: string) => shell.showItemInFolder(filePath));

    // ── Behavior steering (control vectors) ──────────────────────────────────
    // Apply side: llama-server --control-vector-scaled (C++). Generate side: a mean-difference
    // extractor in Python (Windows llama.cpp has no cvector-generator), driven by steer_gen.py.
    function steerScriptPath(): string {
        return app.isPackaged
            ? path.join(process.resourcesPath, 'steer', 'steer_gen.py')
            : path.join(__dirname, '..', '..', 'resources', 'steer', 'steer_gen.py');
    }
    // Cockpit: steering and surgery share the GPU — only one engine runs at a time.
    let engineMode = 'steering';
    const portUp = async (url: string) => {
        try { return (await net.fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    };
    ipcMain.handle('engine-status', async () => ({
        mode: engineMode,
        steeringUp: await portUp(`${LOCAL_SERVER_URL}/v1/models`),
        surgeryUp: await portUp('http://127.0.0.1:5055/info'),
    }));
    ipcMain.handle('engine-set-mode', async (_e, mode: string) => {
        if (mode === 'surgery') {
            engineMode = 'surgery';
            stopLocalServer();                                   // free the GPU
            await new Promise(r => setTimeout(r, 500));
            startSurgeryServer();
        } else {
            engineMode = 'steering';
            stopSurgeryServer();                                 // free the GPU
            await new Promise(r => setTimeout(r, 500));
            startLocalServer();
        }
        return { mode: engineMode };
    });
    ipcMain.handle('steer-status', async () => {
        const exe = path.join(localServerDir(), process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
        const model = resolveLocalModel();
        let serverUp = false;
        try { serverUp = (await net.fetch(`${LOCAL_SERVER_URL}/v1/models`, { signal: AbortSignal.timeout(1200) })).ok; } catch { /* down */ }
        return {
            enginePresent: fs.existsSync(exe),
            generatorPresent: !!(config.steerHfModelPath && fs.existsSync(config.steerHfModelPath) && fs.existsSync(steerScriptPath())),
            model: model ? path.basename(model) : '',
            modelPath: model,
            vectors: config.steerVectors || [],
            scales: config.steerScales || {},
            presets: config.steerPresets || [],
            serverUp,
        };
    });
    ipcMain.handle('steer-save-preset', (_e, name: string, scales: Record<string, number>) => {
        const presets = (config.steerPresets || []).filter(p => p.name !== name);
        presets.push({ name, scales });
        config.steerPresets = presets;
        saveConfig(config);
        return config.steerPresets;
    });
    ipcMain.handle('steer-delete-preset', (_e, name: string) => {
        config.steerPresets = (config.steerPresets || []).filter(p => p.name !== name);
        saveConfig(config);
        return config.steerPresets;
    });
    ipcMain.handle('steer-set-scale', (_e, id: string, scale: number) => {
        config.steerScales = { ...(config.steerScales || {}), [id]: scale };
        saveConfig(config);
        restartLocalServer();
        return true;
    });
    ipcMain.handle('steer-generate', async (e, opts: { name: string; positive: string[]; negative: string[] }) => {
        const script = steerScriptPath();
        const hf = config.steerHfModelPath;
        if (!fs.existsSync(script)) throw new Error('steer_gen.py not found');
        if (!hf || !fs.existsSync(hf)) throw new Error('HF model not set up — run steering setup first');
        fs.mkdirSync(STEER_DIR, { recursive: true });
        const id = 'v' + Date.now().toString(36);
        const posFile = path.join(STEER_DIR, `${id}.positive.txt`);
        const negFile = path.join(STEER_DIR, `${id}.negative.txt`);
        const outFile = path.join(STEER_DIR, `${id}.gguf`);
        fs.writeFileSync(posFile, opts.positive.join('\n'), 'utf-8');
        fs.writeFileSync(negFile, opts.negative.join('\n'), 'utf-8');
        const args = [script, '--model', hf, '--out', outFile, '--positive', posFile, '--negative', negFile];
        const send = (line: string) => e.sender.send('steer-generate-progress', line);
        return await new Promise<{ id: string; name: string; path: string }>((resolve, reject) => {
            const p = spawn(steerPython(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            p.stdout?.on('data', (d: Buffer) => send(d.toString()));
            p.stderr?.on('data', (d: Buffer) => send(d.toString()));
            p.on('error', reject);
            p.on('close', (code) => {
                if (code === 0 && fs.existsSync(outFile)) {
                    const vec = { id, name: opts.name, path: outFile };
                    config.steerVectors = [...(config.steerVectors || []), vec];
                    config.steerScales = { ...(config.steerScales || {}), [id]: 0 };
                    saveConfig(config);
                    resolve(vec);
                } else {
                    reject(new Error(`generator exited ${code}`));
                }
            });
        });
    });
    ipcMain.handle('steer-delete', (_e, id: string) => {
        const v = (config.steerVectors || []).find(x => x.id === id);
        if (v) { try { fs.unlinkSync(v.path); } catch { /* ignore */ } }
        config.steerVectors = (config.steerVectors || []).filter(x => x.id !== id);
        const s = { ...(config.steerScales || {}) }; delete s[id]; config.steerScales = s;
        saveConfig(config);
        restartLocalServer();
        return true;
    });
    ipcMain.handle('steer-test', async (_e, prompt: string, system: string) => {
        const body = {
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                { role: 'user', content: prompt },
            ],
            temperature: 0.7, max_tokens: 300, stream: false,
        };
        const r = await net.fetch(`${LOCAL_SERVER_URL}/v1/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) throw new Error(`local server HTTP ${r.status}`);
        const j = await r.json();
        return j?.choices?.[0]?.message?.content ?? '';
    });

    let yfCrumb = '';
    ipcMain.handle('stocks-fetch', async (_e, url: string) => {
        if (!url.startsWith('https://query1.finance.yahoo.com/') && !url.startsWith('https://query2.finance.yahoo.com/'))
            throw new Error('URL not allowed');
        // net.fetch uses Chromium's networking stack — handles Yahoo Finance cookies automatically
        const withCrumb = (u: string) => yfCrumb ? u + (u.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(yfCrumb)}` : u;
        let res = await net.fetch(withCrumb(url));
        if (res.status === 401 || res.status === 403) {
            try {
                const cr = await net.fetch('https://query2.finance.yahoo.com/v1/test/getcrumb');
                if (cr.ok) yfCrumb = (await cr.text()).trim();
            } catch { yfCrumb = ''; }
            res = await net.fetch(withCrumb(url));
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    });
    ipcMain.handle('capture-delete', (_e, filename: string) => {
        const base = path.join(CAPTURE_DIR, path.basename(filename));
        for (const f of [base, base.replace(/\.wav$/, '.meta.json')]) {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
        }
    });
    ipcMain.handle('capture-list', () => {
        try {
            if (!fs.existsSync(CAPTURE_DIR)) return [];
            return fs.readdirSync(CAPTURE_DIR)
                .filter((f: string) => f.endsWith('.wav'))
                .map((f: string) => {
                    const filePath = path.join(CAPTURE_DIR, f);
                    const stat = fs.statSync(filePath);
                    const metaPath = path.join(CAPTURE_DIR, f.replace('.wav', '.meta.json'));
                    let meta: Record<string, unknown> = {};
                    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
                    return { name: f, path: filePath, size: stat.size, mtime: stat.mtimeMs, ...meta };
                })
                .sort((a: any, b: any) => b.mtime - a.mtime);
        } catch { return []; }
    });
    ipcMain.handle('capture-read-file', (_e, filePath: string) => {
        const buf = fs.readFileSync(filePath);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    });
    ipcMain.handle('capture-save-meta', (_e, filename: string, meta: unknown) => {
        fs.mkdirSync(CAPTURE_DIR, { recursive: true });
        const metaPath = path.join(CAPTURE_DIR, filename.replace('.wav', '.meta.json'));
        fs.writeFileSync(metaPath, JSON.stringify(meta));
    });

    // Lossless capture — ffmpeg WASAPI loopback, bypasses Chromium entirely
    let losslessProc: ReturnType<typeof spawn> | null = null;
    let losslessOutPath: string | null = null;
    ipcMain.handle('capture-check-lossless', () => new Promise<boolean>(resolve => {
        // Test actual WASAPI loopback support, not just ffmpeg existence
        const p = spawn('ffmpeg', ['-f', 'wasapi', '-list_devices', 'true', '-i', 'dummy'],
            { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        (p.stderr as NodeJS.ReadableStream | null)?.on('data', (d: Buffer) => stderr += d.toString());
        p.on('error', () => resolve(false));
        p.on('close', () => resolve(stderr.includes('wasapi') && !stderr.includes('Unknown input format')));
    }));
    ipcMain.handle('capture-start-lossless', (_e, filename: string) => {
        if (losslessProc) return { error: 'Already recording' };
        fs.mkdirSync(CAPTURE_DIR, { recursive: true });
        const outPath = path.join(CAPTURE_DIR, filename);
        losslessOutPath = outPath;
        losslessProc = spawn('ffmpeg', [
            '-y', '-f', 'wasapi', '-loopback', '1', '-i', '',
            // Viz pipe: 8kHz mono s16le to stdout for live waveform
            '-map', '0:a', '-c:a', 'pcm_s16le', '-ar', '8000', '-ac', '1', '-f', 's16le', 'pipe:1',
            // File: full quality 32-bit float PCM
            '-map', '0:a', '-c:a', 'pcm_f32le', '-ar', '48000', outPath,
        ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        losslessProc.stdout?.on('data', (chunk: Buffer) => {
            mainWindow?.webContents.send('capture-viz-chunk', new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        });
        losslessProc.on('error', (err: Error) => {
            mainWindow?.webContents.send('capture-lossless-error', err.message);
            losslessProc = null;
        });
        return { path: outPath };
    });
    ipcMain.handle('capture-stop-lossless', () => new Promise<string | null>(resolve => {
        if (!losslessProc) { resolve(null); return; }
        const proc = losslessProc;
        const outPath = losslessOutPath;
        proc.on('close', () => { losslessProc = null; losslessOutPath = null; resolve(outPath); });
        try { proc.stdin?.write('q'); proc.stdin?.end(); } catch {}
        setTimeout(() => { try { proc.kill(); } catch {} }, 5000);
    }));
    app.on('before-quit', () => { try { losslessProc?.kill(); } catch {} });

    mainWindow = createWindow();

    // Auto-start the bundled jac-llm-server (serves the configured model), then poll for it.
    startLocalServer();
    app.on('before-quit', stopLocalServer);
    setupAutoUpdate();
    // Connect any configured MCP servers; tear them down on quit.
    mcpManager.reload(config.mcpServers);
    app.on('before-quit', () => mcpManager.stopAll());
    // Start the PCB/schematic tool server (Python stdlib, :5051) + CAD server (build123d, :5050).
    startPcbServer();
    startCadServer();
    startZeldovichServer();   // ZELDOVICH research ledger + solver (:5056)
    startGen3dServer();
    // Surgery is NOT auto-started — it's a cockpit mode that shares the GPU with steering,
    // started on demand via engine-set-mode. Default mode = steering (llama-server).
    app.on('before-quit', stopPcbServer);
    app.on('before-quit', stopCadServer);
    app.on('before-quit', stopGen3dServer);
    app.on('before-quit', stopSurgeryServer);
    pollOllamaModels();
    pollLocalServerModels();

    // Fetch OR models; push to webview once both fetch and page load are done
    if (config.openrouterApiKey) {
        // On every load (incl. hot reload) push OR models with a small delay
        // so main.js message handlers are registered before we fire
        mainWindow.webContents.on('did-finish-load', () => {
            const prefs = { type: 'model_prefs', favorites: config.favoriteModels || [], default: config.defaultModel || '' };
            setTimeout(() => mainWindow?.webContents.send('relay-message', prefs), 200);
            setTimeout(pushModelsToUI, 300);
        });
    } else {
        mainWindow.webContents.on('did-finish-load', () => {
            const prefs = { type: 'model_prefs', favorites: config.favoriteModels || [], default: config.defaultModel || '' };
            setTimeout(() => mainWindow?.webContents.send('relay-message', prefs), 200);
            if (ollamaModels.length > 0) setTimeout(pushModelsToUI, 300);
        });
    }

    if (config.openrouterApiKey) {
        fetchORModels(config.openrouterApiKey).then(models => {
            orModels = models;
            // Push after a tick — page is almost certainly loaded by now
            setTimeout(pushModelsToUI, 300);
        }).catch(() => { /* OR unavailable */ });
    }

    if (!app.isPackaged) {
        // Hot reload — watch dist/renderer and reload window when webpack writes
        const rendererDir = path.join(__dirname, '../renderer');
        let reloadTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleReload = () => {
            if (reloadTimer) clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => mainWindow?.webContents.reloadIgnoringCache(), 200);
        };
        try {
            fs.watch(rendererDir, { recursive: true }, scheduleReload);
        } catch {
            fs.watch(rendererDir, scheduleReload);
        }

        // Dev capture server — curl http://localhost:7654/capture → PNG of the JAC window
        //                      curl http://localhost:7654/debug  → JSON state dump
        http.createServer(async (req, res) => {
            if (req.url === '/inject-or') {
                // Push the real OR model list to the webview
                pushModelsToUI();
                res.writeHead(200); res.end('dispatched');
                return;
            }
            if (req.url === '/eval') {
                // POST body = JS to eval
                let body = '';
                req.on('data', d => body += d);
                req.on('end', async () => {
                    try {
                        const result = await mainWindow?.webContents.executeJavaScript(body);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ result }));
                    } catch (e) { res.writeHead(500); res.end(String(e)); }
                });
                return;
            }
            if (req.url === '/webview-state') {
                try {
                    const state = await mainWindow?.webContents.executeJavaScript(`
                        JSON.stringify({
                            modelBtn: document.getElementById('model-btn')?.textContent,
                            sessionDropdown: document.getElementById('session-dropdown')?.textContent,
                            appHtml: document.getElementById('app')?.innerHTML?.slice(0,200),
                            relayMsgCount: window.__relayMsgCount,
                            lastRelayMsgType: window.__lastRelayMsg?.type,
                            lastRelayMsgModelsLen: window.__lastRelayMsg?.models?.length,
                            lastRelayMsgCurrent: window.__lastRelayMsg?.current_model,
                            handlerCount: window.__messageHandlerCount?.(),
                        })
                    `);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(state || '{}');
                } catch (e) {
                    res.writeHead(500); res.end(String(e));
                }
                return;
            }
            if (req.url === '/debug') {
                const state = {
                    orModelsCount: orModels.length,
                    orModelsFirst3: orModels.slice(0, 3).map(m => m.id),
                    currentModel,
                    hasKey: !!config.openrouterApiKey,
                    keyPrefix: config.openrouterApiKey.slice(0, 12),
                    pushCount,
                    lastRelayModelsSent,
                    lastRelayModelsReceived,
                };
                const body = JSON.stringify(state, null, 2);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(body);
                return;
            }
            if (!mainWindow) { res.writeHead(503); res.end('no window'); return; }
            const img = await mainWindow.webContents.capturePage();
            const png = img.toPNG();
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
            res.end(png);
        }).on('error', () => { /* port already in use — skip capture server */ }).listen(7654);
    }

    scheduler = new AgentScheduler(
        path.join(os.homedir(), '.jac', 'research_tasks.yaml'),
        path.join(os.homedir(), '.jac', 'findings'),
    );
    scheduler.start();

    createTray();
    if (config.useRelay && config.authToken) setupRelay();
    else mainWindow?.webContents.send('connection-status', 'local'); // local-only mode

    app.on('activate', () => {
        mainWindow?.show();
        mainWindow?.focus();
    });
});

// ── Workflow window ───────────────────────────────────────────────────────────
let workflowWindow: BrowserWindowType | null = null;

ipcMain.handle('open-workflow', () => {
    if (workflowWindow && !workflowWindow.isDestroyed()) {
        workflowWindow.focus();
        return;
    }
    workflowWindow = new BrowserWindow({
        width: 1400, height: 900,
        minWidth: 800, minHeight: 600,
        title: 'JAC Workflow',
        backgroundColor: '#0d0d0f',
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    workflowWindow.loadFile(path.join(__dirname, '../renderer/workflow.html'));
    workflowWindow.on('closed', () => { workflowWindow = null; });
});

// Workflow storage
const WORKFLOW_DIR = path.join(os.homedir(), '.jac', 'workflows');

ipcMain.handle('workflow-save', (_e, name: string, data: string) => {
    fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKFLOW_DIR, `${name}.json`), data, 'utf-8');
});

ipcMain.handle('workflow-load', (_e, name: string) => {
    try { return fs.readFileSync(path.join(WORKFLOW_DIR, `${name}.json`), 'utf-8'); } catch { return null; }
});

ipcMain.handle('workflow-list', () => {
    try {
        return fs.readdirSync(WORKFLOW_DIR).filter((f: string) => f.endsWith('.json')).map((f: string) => f.replace('.json', ''));
    } catch { return []; }
});

ipcMain.handle('ollama-start', async () => {
    // Search common install paths on macOS/Linux before falling back to PATH
    const candidates = [
        '/usr/local/bin/ollama',
        '/opt/homebrew/bin/ollama',
        '/usr/bin/ollama',
        'ollama',
    ];
    const bin = candidates.find(c => {
        try { fs.accessSync(c, fs.constants.X_OK); return true; } catch { return false; }
    }) ?? 'ollama';

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
        try {
            const child = spawn(bin, ['serve'], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env },
            });
            child.unref();
            child.on('error', (err) => resolve({ ok: false, error: err.message }));
            // Give it 500ms to fail on exec error; if no error, assume it launched
            setTimeout(() => resolve({ ok: true }), 500);
        } catch (err: any) {
            resolve({ ok: false, error: err.message });
        }
    });
});

app.on('before-quit', () => {
    mainWindow?.removeAllListeners('close');
    scheduler?.stop();
    wsClient?.disconnect();
});

app.on('window-all-closed', () => {
    // Don't quit on macOS — live in tray
    if (process.platform !== 'darwin') { app.quit(); }
});
