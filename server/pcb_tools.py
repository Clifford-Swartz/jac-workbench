"""
PCB/Schematic Tool Server — manages circuit schematics, components, nets.

Runs alongside cad_tools.py. The schematic is stored as a graph of components
and nets. Components have symbols (SVG), pins, and properties. Nets connect
pins together. The AI generates placement/wiring commands.

Port: 5051
"""

import json
import sys
import traceback
import logging
import math
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

log = logging.getLogger("pcb_tools")

# ── Component Library ──────────────────────────────────────────────────────

COMPONENT_LIB = {
    # ── Passives ──────────────────────────────────────────────────────────
    "resistor": {
        "name": "Resistor", "prefix": "R", "category": "passive",
        "pins": {"1": {"x": -30, "y": 0}, "2": {"x": 30, "y": 0}},
        "w": 60, "h": 16,
        # Zigzag resistor symbol (IEC/US style)
        "svg": '<path d="M-20,0 L-14,-7 L-8,7 L-2,-7 L4,7 L10,-7 L16,7 L20,0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
        "properties": {"value": "10K", "footprint": "0402", "lcsc": ""},
    },
    "capacitor": {
        "name": "Capacitor", "prefix": "C", "category": "passive",
        "pins": {"1": {"x": -20, "y": 0}, "2": {"x": 20, "y": 0}},
        "w": 40, "h": 16,
        # Two parallel plates with gap
        "svg": '<line x1="-10" y1="0" x2="-3" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="-3" y1="-8" x2="-3" y2="8" stroke="currentColor" stroke-width="2"/>'
               '<line x1="3" y1="-8" x2="3" y2="8" stroke="currentColor" stroke-width="2"/>'
               '<line x1="3" y1="0" x2="10" y2="0" stroke="currentColor" stroke-width="1.5"/>',
        "properties": {"value": "100nF", "footprint": "0402", "lcsc": ""},
    },
    "cap_polar": {
        "name": "Capacitor (Polar)", "prefix": "C", "category": "passive",
        "pins": {"+": {"x": -20, "y": 0}, "-": {"x": 20, "y": 0}},
        "w": 40, "h": 16,
        # Flat plate + curved plate for electrolytic
        "svg": '<line x1="-10" y1="0" x2="-3" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="-3" y1="-8" x2="-3" y2="8" stroke="currentColor" stroke-width="2"/>'
               '<path d="M3,-8 Q6,0 3,8" fill="none" stroke="currentColor" stroke-width="2"/>'
               '<line x1="3" y1="0" x2="10" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<text x="-8" y="-6" font-size="8" fill="currentColor">+</text>',
        "properties": {"value": "10uF", "footprint": "0805", "lcsc": ""},
    },
    "inductor": {
        "name": "Inductor", "prefix": "L", "category": "passive",
        "pins": {"1": {"x": -30, "y": 0}, "2": {"x": 30, "y": 0}},
        "w": 60, "h": 16,
        # Four bumps (coil symbol)
        "svg": '<path d="M-20,0 C-17,-8 -13,-8 -10,0 C-7,-8 -3,-8 0,0 C3,-8 7,-8 10,0 C13,-8 17,-8 20,0" fill="none" stroke="currentColor" stroke-width="1.5"/>',
        "properties": {"value": "10uH", "footprint": "0805", "lcsc": ""},
    },
    "led": {
        "name": "LED", "prefix": "D", "category": "passive",
        "pins": {"A": {"x": -20, "y": 0}, "K": {"x": 20, "y": 0}},
        "w": 40, "h": 20,
        # Triangle + bar (diode) + arrows (light emission)
        "svg": '<line x1="-10" y1="0" x2="-4" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<polygon points="-4,-7 -4,7 6,0" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="6" y1="-7" x2="6" y2="7" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="6" y1="0" x2="10" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="2" y1="-9" x2="6" y2="-14" stroke="currentColor" stroke-width="1"/>'
               '<line x1="4.5" y1="-14" x2="6" y2="-14" stroke="currentColor" stroke-width="1"/>'
               '<line x1="6" y1="-14" x2="6" y2="-11.5" stroke="currentColor" stroke-width="1"/>'
               '<line x1="5" y1="-7" x2="9" y2="-12" stroke="currentColor" stroke-width="1"/>'
               '<line x1="7.5" y1="-12" x2="9" y2="-12" stroke="currentColor" stroke-width="1"/>'
               '<line x1="9" y1="-12" x2="9" y2="-9.5" stroke="currentColor" stroke-width="1"/>',
        "properties": {"value": "Red", "footprint": "0603", "lcsc": ""},
    },
    "diode": {
        "name": "Diode", "prefix": "D", "category": "passive",
        "pins": {"A": {"x": -20, "y": 0}, "K": {"x": 20, "y": 0}},
        "w": 40, "h": 16,
        "svg": '<line x1="-10" y1="0" x2="-4" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<polygon points="-4,-7 -4,7 6,0" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="6" y1="-7" x2="6" y2="7" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="6" y1="0" x2="10" y2="0" stroke="currentColor" stroke-width="1.5"/>',
        "properties": {"value": "1N4148", "footprint": "SOD-323", "lcsc": ""},
    },
    # ── Active ────────────────────────────────────────────────────────────
    "npn": {
        "name": "NPN Transistor", "prefix": "Q", "category": "active",
        "pins": {"B": {"x": -25, "y": 0}, "C": {"x": 15, "y": -18}, "E": {"x": 15, "y": 18}},
        "w": 40, "h": 44,
        # Circle + base bar + collector/emitter lines + emitter arrow
        "svg": '<circle cx="0" cy="0" r="16" fill="none" stroke="currentColor" stroke-width="1"/>'
               '<line x1="-16" y1="0" x2="-4" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="-4" y1="-10" x2="-4" y2="10" stroke="currentColor" stroke-width="2"/>'
               '<line x1="-4" y1="-5" x2="10" y2="-14" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="-4" y1="5" x2="10" y2="14" stroke="currentColor" stroke-width="1.5"/>'
               '<polygon points="10,14 4,10 7,8" fill="currentColor" stroke="none"/>',
        "properties": {"value": "2N2222", "footprint": "SOT-23", "lcsc": ""},
    },
    "pnp": {
        "name": "PNP Transistor", "prefix": "Q", "category": "active",
        "pins": {"B": {"x": -25, "y": 0}, "C": {"x": 15, "y": 18}, "E": {"x": 15, "y": -18}},
        "w": 40, "h": 44,
        "svg": '<circle cx="0" cy="0" r="16" fill="none" stroke="currentColor" stroke-width="1"/>'
               '<line x1="-16" y1="0" x2="-4" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="-4" y1="-10" x2="-4" y2="10" stroke="currentColor" stroke-width="2"/>'
               '<line x1="-4" y1="-5" x2="10" y2="-14" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="-4" y1="5" x2="10" y2="14" stroke="currentColor" stroke-width="1.5"/>'
               '<polygon points="-4,-5 2,-3 -1,-1" fill="currentColor" stroke="none"/>',
        "properties": {"value": "2N2907", "footprint": "SOT-23", "lcsc": ""},
    },
    # ── ICs with pin labels ───────────────────────────────────────────────
    "ic_generic": {
        "name": "IC (Generic)", "prefix": "U", "category": "ic",
        "pins": {
            "1": {"x": -40, "y": -20}, "2": {"x": -40, "y": 0}, "3": {"x": -40, "y": 20},
            "4": {"x": 40, "y": 20}, "5": {"x": 40, "y": 0}, "6": {"x": 40, "y": -20},
        },
        "w": 80, "h": 60,
        "svg": '<rect x="-30" y="-25" width="60" height="50" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<circle cx="-25" cy="-20" r="2" fill="currentColor"/>'
               '<text x="-26" y="-17" font-size="6" fill="currentColor">1</text>'
               '<text x="-26" y="3" font-size="6" fill="currentColor">2</text>'
               '<text x="-26" y="23" font-size="6" fill="currentColor">3</text>'
               '<text x="20" y="23" font-size="6" fill="currentColor" text-anchor="end">4</text>'
               '<text x="20" y="3" font-size="6" fill="currentColor" text-anchor="end">5</text>'
               '<text x="20" y="-17" font-size="6" fill="currentColor" text-anchor="end">6</text>',
        "properties": {"value": "IC", "footprint": "SOIC-8", "lcsc": ""},
    },
    "555": {
        "name": "555 Timer", "prefix": "U", "category": "ic",
        "pins": {
            "GND": {"x": -50, "y": 30}, "TRIG": {"x": -50, "y": 10},
            "OUT": {"x": 50, "y": 10}, "RESET": {"x": 50, "y": -30},
            "CTRL": {"x": -50, "y": -10}, "THRES": {"x": -50, "y": -30},
            "DISCH": {"x": 50, "y": -10}, "VCC": {"x": 50, "y": 30},
        },
        "w": 100, "h": 80,
        "svg": '<rect x="-40" y="-35" width="80" height="70" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<text x="0" y="-2" text-anchor="middle" font-size="11" font-weight="bold" fill="currentColor">555</text>'
               '<circle cx="-35" cy="-30" r="2" fill="currentColor"/>'
               '<text x="-36" y="-26" font-size="5" fill="currentColor">THR</text>'
               '<text x="-36" y="-6" font-size="5" fill="currentColor">CV</text>'
               '<text x="-36" y="14" font-size="5" fill="currentColor">TRG</text>'
               '<text x="-36" y="34" font-size="5" fill="currentColor">GND</text>'
               '<text x="36" y="-26" font-size="5" fill="currentColor" text-anchor="end">RST</text>'
               '<text x="36" y="-6" font-size="5" fill="currentColor" text-anchor="end">DIS</text>'
               '<text x="36" y="14" font-size="5" fill="currentColor" text-anchor="end">OUT</text>'
               '<text x="36" y="34" font-size="5" fill="currentColor" text-anchor="end">VCC</text>',
        "properties": {"value": "NE555", "footprint": "SOIC-8", "lcsc": "C7535"},
    },
    "esp32": {
        "name": "ESP32-S3", "prefix": "U", "category": "ic",
        "pins": {
            "3V3": {"x": -60, "y": -40}, "EN": {"x": -60, "y": -20},
            "GPIO0": {"x": -60, "y": 0}, "GPIO1": {"x": -60, "y": 20},
            "GPIO2": {"x": -60, "y": 40}, "GND": {"x": 60, "y": 40},
            "TX": {"x": 60, "y": 20}, "RX": {"x": 60, "y": 0},
            "USB_D+": {"x": 60, "y": -20}, "USB_D-": {"x": 60, "y": -40},
        },
        "w": 120, "h": 100,
        "svg": '<rect x="-50" y="-45" width="100" height="90" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<text x="0" y="-5" text-anchor="middle" font-size="10" font-weight="bold" fill="currentColor">ESP32</text>'
               '<text x="0" y="7" text-anchor="middle" font-size="7" fill="currentColor">S3</text>'
               '<circle cx="-45" cy="-40" r="2" fill="currentColor"/>'
               '<text x="-46" y="-36" font-size="5" fill="currentColor">3V3</text>'
               '<text x="-46" y="-16" font-size="5" fill="currentColor">EN</text>'
               '<text x="-46" y="4" font-size="5" fill="currentColor">IO0</text>'
               '<text x="-46" y="24" font-size="5" fill="currentColor">IO1</text>'
               '<text x="-46" y="44" font-size="5" fill="currentColor">IO2</text>'
               '<text x="46" y="-36" font-size="5" fill="currentColor" text-anchor="end">D-</text>'
               '<text x="46" y="-16" font-size="5" fill="currentColor" text-anchor="end">D+</text>'
               '<text x="46" y="4" font-size="5" fill="currentColor" text-anchor="end">RX</text>'
               '<text x="46" y="24" font-size="5" fill="currentColor" text-anchor="end">TX</text>'
               '<text x="46" y="44" font-size="5" fill="currentColor" text-anchor="end">GND</text>',
        "properties": {"value": "ESP32-S3-WROOM", "footprint": "MODULE", "lcsc": "C2913202"},
    },
    # ── Connectors ────────────────────────────────────────────────────────
    "connector_2pin": {
        "name": "2-Pin Header", "prefix": "J", "category": "connector",
        "pins": {"1": {"x": -15, "y": 0}, "2": {"x": 15, "y": 0}},
        "w": 30, "h": 16,
        # Two squares with pin numbers
        "svg": '<rect x="-10" y="-6" width="8" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<rect x="2" y="-6" width="8" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<text x="-6" y="3" font-size="6" fill="currentColor" text-anchor="middle">1</text>'
               '<text x="6" y="3" font-size="6" fill="currentColor" text-anchor="middle">2</text>',
        "properties": {"value": "CONN_2", "footprint": "PinHeader_1x02", "lcsc": ""},
    },
    "usb_c": {
        "name": "USB-C", "prefix": "J", "category": "connector",
        "pins": {
            "VBUS": {"x": -40, "y": -15}, "GND": {"x": -40, "y": 15},
            "CC1": {"x": 40, "y": -15}, "CC2": {"x": 40, "y": 15},
            "D+": {"x": -40, "y": 0}, "D-": {"x": 40, "y": 0},
        },
        "w": 80, "h": 50,
        "svg": '<rect x="-30" y="-20" width="60" height="40" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<rect x="-20" y="-12" width="40" height="24" rx="4" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="2,2"/>'
               '<text x="0" y="4" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">USB-C</text>'
               '<text x="-26" y="-11" font-size="4" fill="currentColor">VBUS</text>'
               '<text x="-26" y="3" font-size="4" fill="currentColor">D+</text>'
               '<text x="-26" y="18" font-size="4" fill="currentColor">GND</text>'
               '<text x="26" y="-11" font-size="4" fill="currentColor" text-anchor="end">CC1</text>'
               '<text x="26" y="3" font-size="4" fill="currentColor" text-anchor="end">D-</text>'
               '<text x="26" y="18" font-size="4" fill="currentColor" text-anchor="end">CC2</text>',
        "properties": {"value": "USB-C", "footprint": "USB_C_Receptacle", "lcsc": "C168688"},
    },
    # ── Power symbols ─────────────────────────────────────────────────────
    "vcc": {
        "name": "VCC", "prefix": "", "category": "power",
        "pins": {"1": {"x": 0, "y": 10}},
        "w": 20, "h": 20,
        "svg": '<line x1="0" y1="10" x2="0" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<polygon points="-8,0 0,-10 8,0" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<text x="0" y="-13" text-anchor="middle" font-size="7" fill="currentColor">VCC</text>',
        "properties": {"value": "VCC", "net": "VCC"},
    },
    "gnd": {
        "name": "GND", "prefix": "", "category": "power",
        "pins": {"1": {"x": 0, "y": -10}},
        "w": 20, "h": 20,
        "svg": '<line x1="0" y1="-10" x2="0" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="-8" y1="0" x2="8" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<line x1="-5" y1="3" x2="5" y2="3" stroke="currentColor" stroke-width="1.2"/>'
               '<line x1="-2" y1="6" x2="2" y2="6" stroke="currentColor" stroke-width="1"/>',
        "properties": {"value": "GND", "net": "GND"},
    },
    "3v3": {
        "name": "3.3V", "prefix": "", "category": "power",
        "pins": {"1": {"x": 0, "y": 10}},
        "w": 20, "h": 20,
        "svg": '<line x1="0" y1="10" x2="0" y2="0" stroke="currentColor" stroke-width="1.5"/>'
               '<polygon points="-8,0 0,-10 8,0" fill="none" stroke="currentColor" stroke-width="1.5"/>'
               '<text x="0" y="-13" text-anchor="middle" font-size="7" fill="currentColor">3V3</text>',
        "properties": {"value": "3V3", "net": "3V3"},
    },
}

# ── Session State ──────────────────────────────────────────────────────────

session = {
    "components": [],  # [{id, type, ref, x, y, rotation, properties, ...}]
    "wires": [],       # [{id, points: [[x1,y1],[x2,y2],...], net: str}]
    "nets": {},        # {net_name: [{"comp_id": str, "pin": str}, ...]}
    "next_id": 1,
}


def _next_id():
    session["next_id"] += 1
    return f"item_{session['next_id'] - 1}"


def _get_ref(comp_type):
    """Generate next reference designator (R1, R2, C1, etc.)."""
    lib = COMPONENT_LIB.get(comp_type, {})
    prefix = lib.get("prefix", "X")
    existing = [c["ref"] for c in session["components"] if c["ref"].startswith(prefix)]
    nums = []
    for r in existing:
        try:
            nums.append(int(r[len(prefix):]))
        except ValueError:
            pass
    n = max(nums) + 1 if nums else 1
    return f"{prefix}{n}"


# ── Tool Functions ─────────────────────────────────────────────────────────

def add_component(comp_type: str, x: float = 0, y: float = 0, rotation: float = 0, properties: dict = None) -> dict:
    """Add a component to the schematic."""
    lib = COMPONENT_LIB.get(comp_type)
    if not lib:
        return {"ok": False, "error": f"Unknown component: {comp_type}. Available: {list(COMPONENT_LIB.keys())}"}

    comp_id = _next_id()
    ref = _get_ref(comp_type)
    props = dict(lib.get("properties", {}))
    if properties:
        props.update(properties)

    comp = {
        "id": comp_id,
        "type": comp_type,
        "ref": ref,
        "x": x, "y": y,
        "rotation": rotation,
        "properties": props,
    }
    session["components"].append(comp)
    return {"ok": True, "component": comp, **get_schematic()}


def remove_component(comp_id: str) -> dict:
    """Remove a component and its connections."""
    session["components"] = [c for c in session["components"] if c["id"] != comp_id]
    # Remove wires connected to this component
    for net_name, pins in list(session["nets"].items()):
        session["nets"][net_name] = [p for p in pins if p["comp_id"] != comp_id]
    return {"ok": True, **get_schematic()}


def move_component(comp_id: str, x: float, y: float) -> dict:
    """Move a component."""
    for c in session["components"]:
        if c["id"] == comp_id:
            c["x"] = x
            c["y"] = y
            return {"ok": True, **get_schematic()}
    return {"ok": False, "error": f"Component not found: {comp_id}"}


def _get_obstacles():
    """Get bounding boxes of all components as obstacles for routing."""
    obstacles = []
    MARGIN = 10  # routing clearance around components
    for c in session["components"]:
        lib = COMPONENT_LIB.get(c["type"], {})
        w = lib.get("w", 40) / 2 + MARGIN
        h = lib.get("h", 20) / 2 + MARGIN
        obstacles.append({
            "x1": c["x"] - w, "y1": c["y"] - h,
            "x2": c["x"] + w, "y2": c["y"] + h,
            "id": c["id"],
        })
    return obstacles


def _astar_route(ax, ay, bx, by, obstacles, exclude_ids=None):
    """A* pathfinding on a virtual grid with obstacle avoidance and turn penalty.

    Returns a list of [x, y] waypoints forming an orthogonal path.
    """
    import heapq

    GRID = 10  # grid resolution
    TURN_COST = 3  # penalty for changing direction
    exclude_ids = exclude_ids or set()

    # Snap to grid
    def snap(v):
        return round(v / GRID) * GRID

    sx, sy = snap(ax), snap(ay)
    gx, gy = snap(bx), snap(by)

    # Check if a point is inside an obstacle
    def blocked(x, y):
        for obs in obstacles:
            if obs["id"] in exclude_ids:
                continue
            if obs["x1"] <= x <= obs["x2"] and obs["y1"] <= y <= obs["y2"]:
                return True
        return False

    # A* with direction tracking for turn penalty
    # State: (x, y, direction) where direction is 0=none, 1=horizontal, 2=vertical
    start = (sx, sy, 0)
    goal_xy = (gx, gy)

    # f = g + h
    def heuristic(x, y):
        return abs(x - gx) + abs(y - gy)

    open_set = [(heuristic(sx, sy), 0, start)]  # (f, g, state)
    came_from = {}
    g_score = {start: 0}
    visited = set()

    moves = [(GRID, 0, 1), (-GRID, 0, 1), (0, GRID, 2), (0, -GRID, 2)]

    iterations = 0
    max_iter = 5000  # prevent infinite loops

    while open_set and iterations < max_iter:
        iterations += 1
        f, g, current = heapq.heappop(open_set)
        cx, cy, cdir = current

        if (cx, cy) == goal_xy:
            # Reconstruct path
            path = [[bx, by]]  # end at exact position
            state = current
            while state in came_from:
                path.append([state[0], state[1]])
                state = came_from[state]
            path.append([ax, ay])  # start at exact position
            path.reverse()
            # Remove collinear points
            if len(path) > 2:
                cleaned = [path[0]]
                for i in range(1, len(path) - 1):
                    p0, p1, p2 = path[i-1], path[i], path[i+1]
                    if not ((p0[0] == p1[0] == p2[0]) or (p0[1] == p1[1] == p2[1])):
                        cleaned.append(p1)
                cleaned.append(path[-1])
                path = cleaned
            return path

        if current in visited:
            continue
        visited.add(current)

        for dx, dy, new_dir in moves:
            nx, ny = cx + dx, cy + dy
            if blocked(nx, ny):
                continue

            turn_penalty = TURN_COST if (cdir != 0 and cdir != new_dir) else 0
            new_g = g + GRID + turn_penalty
            new_state = (nx, ny, new_dir)

            if new_state not in g_score or new_g < g_score[new_state]:
                g_score[new_state] = new_g
                f = new_g + heuristic(nx, ny)
                heapq.heappush(open_set, (f, new_g, new_state))
                came_from[new_state] = current

    # Fallback: simple L-route if A* fails
    mid_x = (ax + bx) / 2
    return [[ax, ay], [mid_x, ay], [mid_x, by], [bx, by]]


def add_wire(from_comp: str, from_pin: str, to_comp: str, to_pin: str, net_name: str = None) -> dict:
    """Connect two pins with a wire."""
    # Find the components
    comp_a = next((c for c in session["components"] if c["id"] == from_comp or c["ref"] == from_comp), None)
    comp_b = next((c for c in session["components"] if c["id"] == to_comp or c["ref"] == to_comp), None)
    if not comp_a:
        return {"ok": False, "error": f"Component not found: {from_comp}"}
    if not comp_b:
        return {"ok": False, "error": f"Component not found: {to_comp}"}

    # Get pin positions
    lib_a = COMPONENT_LIB.get(comp_a["type"], {})
    lib_b = COMPONENT_LIB.get(comp_b["type"], {})
    pin_a = lib_a.get("pins", {}).get(from_pin)
    pin_b = lib_b.get("pins", {}).get(to_pin)
    if not pin_a:
        return {"ok": False, "error": f"Pin {from_pin} not found on {comp_a['ref']}. Available: {list(lib_a.get('pins', {}).keys())}"}
    if not pin_b:
        return {"ok": False, "error": f"Pin {to_pin} not found on {comp_b['ref']}. Available: {list(lib_b.get('pins', {}).keys())}"}

    # Calculate absolute pin positions
    ax = comp_a["x"] + pin_a["x"]
    ay = comp_a["y"] + pin_a["y"]
    bx = comp_b["x"] + pin_b["x"]
    by = comp_b["y"] + pin_b["y"]

    # Auto-name net if not provided
    if not net_name:
        net_name = f"NET_{len(session['wires']) + 1}"

    wire_id = _next_id()

    # A* pathfinding with obstacle avoidance
    obstacles = _get_obstacles()
    # Exclude the two connected components from obstacles (pins are on their edges)
    exclude = {comp_a["id"], comp_b["id"]}
    points = _astar_route(ax, ay, bx, by, obstacles, exclude_ids=exclude)

    # Junction dots where endpoints meet existing wires
    ALIGN_THRESH = 5
    junctions = []
    for existing_w in session["wires"]:
        for ep in [points[0], points[-1]]:
            for pt in existing_w["points"]:
                if abs(pt[0] - ep[0]) <= ALIGN_THRESH and abs(pt[1] - ep[1]) <= ALIGN_THRESH:
                    junctions.append([ep[0], ep[1]])

    wire = {
        "id": wire_id,
        "points": points,
        "net": net_name,
        "junctions": junctions,
    }
    session["wires"].append(wire)

    # Update netlist
    if net_name not in session["nets"]:
        session["nets"][net_name] = []
    session["nets"][net_name].append({"comp_id": comp_a["id"], "pin": from_pin})
    session["nets"][net_name].append({"comp_id": comp_b["id"], "pin": to_pin})

    return {"ok": True, "wire": wire, **get_schematic()}


def get_schematic() -> dict:
    """Return the full schematic state."""
    return {
        "components": session["components"],
        "wires": session["wires"],
        "nets": session["nets"],
        "n_components": len(session["components"]),
        "n_wires": len(session["wires"]),
        "n_nets": len(session["nets"]),
        "library": {k: {"name": v["name"], "category": v.get("category", "")} for k, v in COMPONENT_LIB.items()},
    }


def get_context() -> str:
    """Build schematic context string for LLM."""
    if not session["components"]:
        return "Empty schematic. No components placed."
    lines = [f"Schematic: {len(session['components'])} components, {len(session['wires'])} wires, {len(session['nets'])} nets\n"]
    for c in session["components"]:
        lines.append(f"  {c['ref']} ({c['type']}) at ({c['x']},{c['y']}) — {c['properties'].get('value', '')}")
    if session["nets"]:
        lines.append("\nNets:")
        for name, pins in session["nets"].items():
            pin_strs = [f"{p['comp_id']}.{p['pin']}" for p in pins]
            lines.append(f"  {name}: {' — '.join(pin_strs)}")
    lines.append(f"\nAvailable components: {', '.join(COMPONENT_LIB.keys())}")
    return "\n".join(lines)


def reset_schematic() -> dict:
    """Clear the schematic."""
    session["components"] = []
    session["wires"] = []
    session["nets"] = {}
    session["next_id"] = 1
    return {"ok": True, **get_schematic()}


def export_kicad(path: str = None) -> dict:
    """Export schematic as KiCad .kicad_sch format."""
    import uuid as _uuid

    if not path:
        out_dir = Path.home() / ".jac" / "cad_out"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = str(out_dir / "schematic.kicad_sch")

    sch_uuid = str(_uuid.uuid4())
    lines = []
    lines.append('(kicad_sch (version 20230121) (generator "jac_pcb_tools")')
    lines.append('')
    lines.append(f'  (uuid "{sch_uuid}")')
    lines.append('')
    lines.append('  (paper "A4")')
    lines.append('')

    # Emit each component as a symbol instance
    for comp in session["components"]:
        lib = COMPONENT_LIB.get(comp["type"], {})
        c_uuid = str(_uuid.uuid4())
        cx, cy = comp["x"], comp["y"]
        rot = comp.get("rotation", 0)
        ref = comp["ref"]
        value = comp["properties"].get("value", comp["type"])
        footprint = comp["properties"].get("footprint", "")
        category = lib.get("category", "")

        lines.append(f'  (symbol (lib_id "{comp["type"]}") (at {cx} {cy} {rot})')
        lines.append(f'    (uuid "{c_uuid}")')

        # Power flag
        if category == "power":
            net = comp["properties"].get("net", value)
            lines.append(f'    (power)')

        # Properties
        lines.append(f'    (property "Reference" "{ref}" (at {cx} {cy - 15} 0)')
        lines.append(f'      (effects (font (size 1.27 1.27))))')
        lines.append(f'    (property "Value" "{value}" (at {cx} {cy + 15} 0)')
        lines.append(f'      (effects (font (size 1.27 1.27))))')
        if footprint:
            lines.append(f'    (property "Footprint" "{footprint}" (at {cx} {cy + 25} 0)')
            lines.append(f'      (effects (font (size 1.27 1.27)) hide))')

        # Pins
        pins = lib.get("pins", {})
        for pin_name, pin_pos in pins.items():
            px = cx + pin_pos["x"]
            py = cy + pin_pos["y"]
            pin_uuid = str(_uuid.uuid4())
            lines.append(f'    (pin "{pin_name}" (uuid "{pin_uuid}"))')

        lines.append('  )')
        lines.append('')

    # Emit wires
    for wire in session["wires"]:
        pts = wire["points"]
        # KiCad wires are segment-based (each pair of consecutive points)
        for i in range(len(pts) - 1):
            w_uuid = str(_uuid.uuid4())
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            lines.append(f'  (wire (pts (xy {x1} {y1}) (xy {x2} {y2}))')
            lines.append(f'    (uuid "{w_uuid}")')
            lines.append(f'    (stroke (width 0) (type default))')
            lines.append(f'  )')

        # Junction dots
        for junc in wire.get("junctions", []):
            j_uuid = str(_uuid.uuid4())
            lines.append(f'  (junction (at {junc[0]} {junc[1]}))')

    # Net labels
    for net_name, pins in session["nets"].items():
        if net_name.startswith("NET_"):
            continue  # skip auto-generated net names
        if pins:
            # Place net label at first pin location
            first = pins[0]
            comp = next((c for c in session["components"] if c["id"] == first["comp_id"]), None)
            if comp:
                lib = COMPONENT_LIB.get(comp["type"], {})
                pin_pos = lib.get("pins", {}).get(first["pin"], {"x": 0, "y": 0})
                lx = comp["x"] + pin_pos["x"]
                ly = comp["y"] + pin_pos["y"]
                l_uuid = str(_uuid.uuid4())
                lines.append(f'  (net_label "{net_name}" (at {lx} {ly} 0)')
                lines.append(f'    (uuid "{l_uuid}")')
                lines.append(f'    (effects (font (size 1.27 1.27))))')

    lines.append(')')
    lines.append('')

    content = '\n'.join(lines)
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(content, encoding="utf-8")

    return {"ok": True, "path": str(out_path), "size": len(content)}


# ── Tool Map ───────────────────────────────────────────────────────────────

TOOL_MAP = {
    "add_component": lambda a: add_component(a["type"], a.get("x", 0), a.get("y", 0), a.get("rotation", 0), a.get("properties")),
    "remove_component": lambda a: remove_component(a["id"]),
    "move_component": lambda a: move_component(a["id"], a["x"], a["y"]),
    "add_wire": lambda a: add_wire(a["from_comp"], a["from_pin"], a["to_comp"], a["to_pin"], a.get("net")),
    "get_schematic": lambda a: {"ok": True, **get_schematic()},
    "get_context": lambda a: {"ok": True, "context": get_context()},
    "reset": lambda a: reset_schematic(),
    "get_library": lambda a: {"ok": True, "library": {k: {kk: vv for kk, vv in v.items() if kk != "svg"} for k, v in COMPONENT_LIB.items()}},
    "export_kicad": lambda a: export_kicad(a.get("path")),
}


# ── HTTP Server ────────────────────────────────────────────────────────────

class PcbHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        tool_name = body.get("tool", "")
        args = body.get("args", {})
        handler = TOOL_MAP.get(tool_name)
        if not handler:
            self.respond(400, {"ok": False, "error": f"Unknown tool: {tool_name}"})
            return
        try:
            result = handler(args)
            self.respond(200, result)
        except Exception:
            self.respond(500, {"ok": False, "error": traceback.format_exc()})

    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"status": "ok", "n_components": len(session["components"])})
        elif self.path == "/schematic":
            self.respond(200, {"ok": True, **get_schematic()})
        elif self.path == "/context":
            self.respond(200, {"context": get_context()})
        elif self.path == "/library":
            self.respond(200, {"ok": True, "library": COMPONENT_LIB})
        else:
            self.respond(404, {"error": "not found"})

    def respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        log.info(format % args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5051
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    server = HTTPServer(("127.0.0.1", port), PcbHandler)
    log.info("PCB tool server on http://127.0.0.1:%d", port)
    log.info("Components: %s", list(COMPONENT_LIB.keys()))
    server.serve_forever()


if __name__ == "__main__":
    main()
