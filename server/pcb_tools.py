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
    "tracks": [],      # [{id, segs:[{ax,ay,bx,by,layer}], vias:[{x,y}], net, a, b, width}] — routed copper
    "zones": [],       # [{id, layer, net, poly:[[x,y],...]}] — copper pours (ground/power planes)
    # per-net design rules; routing/DRC use the class of each net. Widths/clearance in mm.
    "netclasses": {
        "Default": {"track_width": 0.25, "clearance": 0.2, "via_dia": 0.6, "via_drill": 0.3},
        "Power":   {"track_width": 0.6,  "clearance": 0.2, "via_dia": 0.8, "via_drill": 0.4},
    },
    "net_assign": {},  # explicit net -> class overrides (else auto: power rails -> "Power")
    "custom_lib": {},  # KiCad symbols the user searched + placed: {libId: {name,pins,svg,footprint_ref,...}}
    "next_id": 1,
}

def _lib_of(comp_type):
    """Definition for a component type — a built-in OR a session-custom KiCad symbol."""
    return COMPONENT_LIB.get(comp_type) or session.get("custom_lib", {}).get(comp_type) or {}

import re as _re
_POWER_NETS = {"GND", "VCC", "VDD", "VDDA", "VSS", "VSSA", "VEE", "VBUS", "VBAT", "VIN", "VOUT",
               "AGND", "DGND", "PGND", "AVCC", "AVDD"}
# Voltage-rail names: 5V, +3V3, 3.3V, 12V, 1V8, -5V, 2V5 …
_VOLT_RE = _re.compile(r'^[+-]?\d+(\.\d+)?V\d*$')
def net_class_of(net_name):
    """Which netclass a net belongs to: explicit override, else power rails -> Power."""
    if net_name in session.get("net_assign", {}):
        return session["net_assign"][net_name]
    n = (net_name or "").upper()
    if n in _POWER_NETS or n.startswith("+") or _VOLT_RE.match(n):
        return "Power"
    return "Default"

def net_track_width_mm(net_name):
    cls = net_class_of(net_name)
    return session["netclasses"].get(cls, session["netclasses"]["Default"]).get("track_width", 0.25)


def _next_id():
    session["next_id"] += 1
    return f"item_{session['next_id'] - 1}"


def _get_ref(comp_type):
    """Generate next reference designator (R1, R2, C1, etc.)."""
    lib = _lib_of(comp_type)
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

# Real LCSC part numbers for common JLCPCB Basic Parts (verified from the JLCPCB parts
# library). Keyed by (type, VALUE, PACKAGE); package/value None = wildcard. So a placed
# 10K 0402 resistor gets a real, orderable LCSC # in the BOM instead of a blank.
# Source: JLCPCB Basic Parts list (github.com/josemariaaraujo/JLCPCB-Basic-Parts).
LCSC_TABLE = {
    ("resistor", "100", "0402"): "C25076", ("resistor", "220", "0402"): "C25092",
    ("resistor", "330", "0402"): "C25105", ("resistor", "1K", "0402"): "C11702",
    ("resistor", "4.7K", "0402"): "C25900", ("resistor", "10K", "0402"): "C25744",
    ("resistor", "100K", "0402"): "C25741",
    ("capacitor", "100NF", "0402"): "C1525", ("capacitor", "1UF", "0402"): "C52923",
    ("capacitor", "10UF", "0402"): "C15525", ("capacitor", "10UF", "0805"): "C15850",
    ("led", "RED", "0603"): "C2286",
    ("diode", None, None): "C81598",     # general-purpose (1N4148-class, SOD-123)
    ("npn", None, None): "C20526",       # MMBT3904 SOT-23
    ("pnp", None, None): "C8326",        # MMBT3906 SOT-23
}

def lookup_lcsc(comp_type, value, footprint):
    """Best real LCSC # for a (type, value, package), most-specific match first. '' if unknown."""
    v = (value or "").upper().replace(" ", "").replace("Ω", "").replace("OHM", "")
    fp = (footprint or "").upper()
    for key in ((comp_type, v, fp), (comp_type, v, None), (comp_type, None, None)):
        if key in LCSC_TABLE:
            return LCSC_TABLE[key]
    return ""


def add_component(comp_type: str, x: float = 0, y: float = 0, rotation: float = 0, properties: dict = None) -> dict:
    """Add a component to the schematic."""
    lib = _lib_of(comp_type)
    if not lib:
        return {"ok": False, "error": f"Unknown component: {comp_type}. Available: {list(COMPONENT_LIB.keys())}"}

    comp_id = _next_id()
    ref = _get_ref(comp_type)
    props = dict(lib.get("properties", {}))
    if properties:
        props.update(properties)
    if not props.get("lcsc"):                        # auto-fill a real LCSC # for common parts
        props["lcsc"] = lookup_lcsc(comp_type, props.get("value"), props.get("footprint"))

    comp = {
        "id": comp_id,
        "type": comp_type,
        "ref": ref,
        "x": x, "y": y,               # schematic position
        "pcb_x": x, "pcb_y": y,       # PCB (board) position — independent layout, like KiCad
        "rotation": rotation,
        "properties": props,
    }
    session["components"].append(comp)
    return {"ok": True, "component": comp, **get_schematic()}


def add_symbol(defn: dict, x: float = 0, y: float = 0, rotation: float = 0) -> dict:
    """Place a real KiCad symbol from the library search. Registers its definition into the
    session's custom lib (pins/graphics/footprint), then adds it like any other component.
    `defn` is what kicad-symbol-get returns (pins already in JAC world units)."""
    lib_id = defn.get("libId")
    if not lib_id:
        return {"ok": False, "error": "Symbol definition has no libId."}
    if lib_id not in session["custom_lib"]:
        pins = defn.get("pins", {}) or {}
        session["custom_lib"][lib_id] = {
            "name": defn.get("name", lib_id), "prefix": defn.get("prefix", "U"), "category": "kicad",
            "pins": {k: {"x": p["x"], "y": p["y"]} for k, p in pins.items()},
            "pin_names": {k: p.get("name", "") for k, p in pins.items()},
            "w": defn.get("w", 40), "h": defn.get("h", 30), "svg": defn.get("svg", ""),
            "footprint_ref": defn.get("footprint", "") or "",
            "properties": {"value": defn.get("value", ""), "footprint": defn.get("footprint", ""), "lcsc": ""},
        }
    return add_component(lib_id, x, y, rotation)


def _resolve_comp(comp_id: str):
    """Find a component by id OR ref designator (e.g. 'item_3' or 'R1')."""
    return next((c for c in session["components"] if c["id"] == comp_id or c.get("ref") == comp_id), None)


def remove_component(comp_id: str) -> dict:
    """Remove a component and its connections (by id or ref)."""
    target = _resolve_comp(comp_id)
    real_id = target["id"] if target else comp_id
    session["components"] = [c for c in session["components"] if c["id"] != real_id]
    # Remove wires connected to this component
    for net_name, pins in list(session["nets"].items()):
        session["nets"][net_name] = [p for p in pins if p["comp_id"] != real_id]
    return {"ok": True, **get_schematic()}


def move_component(comp_id: str, x: float, y: float, view: str = "schematic") -> dict:
    """Move a component (by id or ref). view='pcb' moves it on the board layout only;
    view='schematic' moves it on the schematic sheet. The two layouts are independent."""
    c = _resolve_comp(comp_id)
    if c:
        if view == "pcb":
            c["pcb_x"] = x; c["pcb_y"] = y
        else:
            c["x"] = x; c["y"] = y
            # re-route the nets touching this part so its wires follow it on the sheet
            touching = [nn for nn, ms in session["nets"].items() if any(m["comp_id"] == c["id"] for m in ms)]
            if touching:
                _rewire_nets(touching)
        return {"ok": True, **get_schematic()}
    return {"ok": False, "error": f"Component not found: {comp_id}"}


def set_component_property(comp_id: str, key: str, value: str) -> dict:
    """Edit a component property (value / footprint / lcsc). Changing value or footprint
    re-auto-fills the LCSC # from the parts table (a manual lcsc edit overrides it)."""
    c = _resolve_comp(comp_id)
    if not c:
        return {"ok": False, "error": f"Component not found: {comp_id}"}
    c.setdefault("properties", {})[key] = value
    # Assigning a footprint to a placed KiCad symbol updates its land pattern (makes it routable).
    if key == "footprint" and c["type"] in session.get("custom_lib", {}) and ":" in str(value):
        session["custom_lib"][c["type"]]["footprint_ref"] = value
    if key in ("value", "footprint"):
        hit = lookup_lcsc(c["type"], c["properties"].get("value"), c["properties"].get("footprint"))
        if hit:
            c["properties"]["lcsc"] = hit          # keep LCSC in sync with the chosen part
    return {"ok": True, "lcsc": c["properties"].get("lcsc", ""), **get_schematic()}


def _cluster_layout(parts, half_ext, set_pos, gap=22, anchor_dx=260, hug_gap=14, seed=(200, 300)):
    """Shared connectivity-aware placer used by BOTH the board and the schematic.

    ICs are anchors. Decoupling caps (on a power net + sharing a net with an IC) hug that IC.
    Everything else is placed force-directed-style: parts bonded by shared nets (weighted
    1/(fanout-1); power nets down-weighted so VCC/GND don't glue everything), each dropped at
    the weighted centroid of its placed neighbours via a spiral search for a free slot.
    `half_ext(c)->(hw,hh)` gives a part's half-size; `set_pos(c,x,y)` writes the chosen coords
    (pcb_x/pcb_y for the board, x/y for the schematic). Returns count placed."""
    import math
    from collections import defaultdict
    comp_by_id = {c["id"]: c for c in parts}

    netinfo = {}; netsof = defaultdict(set); pnets = defaultdict(set)
    for nn, pins in session.get("nets", {}).items():
        members = [p["comp_id"] for p in pins if p["comp_id"] in comp_by_id]
        if len(members) < 2:
            continue
        power = net_class_of(nn) == "Power"
        netinfo[nn] = {"members": members, "power": power}
        for m in members:
            netsof[m].add(nn)
            if power:
                pnets[m].add(nn)
    bond = defaultdict(float)
    for nn, info in netinfo.items():
        m = info["members"]; f = len(m)
        w = (1.0 / (f - 1)) * (0.15 if info["power"] else 1.0)
        for i in range(len(m)):
            for j in range(i + 1, len(m)):
                bond[tuple(sorted((m[i], m[j])))] += w
    def bwt(a, b):
        return bond.get(tuple(sorted((a, b))), 0.0)

    placed = {}; occupied = []
    def fits(x, y, hw, hh):
        for (ox, oy, ohw, ohh) in occupied:
            if abs(x - ox) < hw + ohw + gap and abs(y - oy) < hh + ohh + gap:
                return False
        return True
    def commit(c, x, y):
        hw, hh = half_ext(c); placed[c["id"]] = (x, y); occupied.append((x, y, hw, hh)); set_pos(c, x, y)
    def place_near(c, cx, cy):
        hw, hh = half_ext(c)
        if fits(cx, cy, hw, hh):
            commit(c, cx, cy); return
        step = max(24, (hw + hh) / 2)
        for radius in range(1, 90):
            for ang in range(0, 360, 30):
                x = cx + radius * step * math.cos(math.radians(ang)); y = cy + radius * step * math.sin(math.radians(ang))
                if fits(x, y, hw, hh):
                    commit(c, x, y); return
        commit(c, cx, cy)

    anchors = [c for c in parts if _lib_of(c["type"]).get("category") == "ic"]
    hug = {}
    for c in parts:
        if _lib_of(c["type"]).get("prefix") != "C" or not pnets[c["id"]]:
            continue
        cand = [a for a in anchors if netsof[c["id"]] & netsof[a["id"]]]
        if cand:
            hug[c["id"]] = max(cand, key=lambda a: len(netsof[c["id"]] & netsof[a["id"]]))

    for i, a in enumerate(anchors):
        place_near(a, seed[0] + i * anchor_dx, seed[1])
    if not placed:
        s = max(parts, key=lambda c: sum(bwt(c["id"], o["id"]) for o in parts if o is not c))
        place_near(s, seed[0], seed[1])
    offs = [(1, 0), (0, -1), (0, 1), (-1, 0), (1, -1), (1, 1), (-1, -1), (-1, 1)]; side = defaultdict(int)
    for cap_id, a in sorted(hug.items()):
        c = comp_by_id[cap_id]; ax, ay = placed[a["id"]]
        ahw, ahh = half_ext(a); chw, chh = half_ext(c)
        ox, oy = offs[side[a["id"]] % len(offs)]; side[a["id"]] += 1
        place_near(c, ax + ox * (ahw + chw + hug_gap), ay + oy * (ahh + chh + hug_gap))
    remaining = [c for c in parts if c["id"] not in placed]
    while remaining:
        remaining.sort(key=lambda c: sum(bwt(c["id"], pid) for pid in placed), reverse=True)
        c = remaining.pop(0); wx = wy = num = 0.0
        for pid, (px, py) in placed.items():
            b = bwt(c["id"], pid)
            if b > 0:
                wx += px * b; wy += py * b; num += b
        if num > 0:
            place_near(c, wx / num, wy / num)
        else:
            place_near(c, seed[0] + len(placed) * 40, seed[1] + 340)
    return len(placed)


def auto_place_pcb() -> dict:
    """Connectivity-aware BOARD placement — decoupling caps hug their IC; no blind grid.
    Uses real footprint courtyards for spacing. Schematic positions are untouched."""
    parts = [c for c in session["components"] if _lib_of(c["type"]).get("category") != "power"]
    if not parts:
        return {"ok": True, **get_schematic()}
    S = 0.05
    def half(c):
        g = footprint_geometry(c["type"])
        if g and g.get("bbox"):
            b = g["bbox"]
            return (max(abs(b[0]), abs(b[2])) / S, max(abs(b[1]), abs(b[3])) / S)
        lib = _lib_of(c["type"]); return (lib.get("w", 40) / 2, lib.get("h", 30) / 2)
    def setp(c, x, y): c["pcb_x"] = round(x); c["pcb_y"] = round(y)
    n = _cluster_layout(parts, half, setp, gap=22, anchor_dx=260, hug_gap=14, seed=(200, 300))
    return {"ok": True, "placed": n, **get_schematic()}


def auto_place_sch() -> dict:
    """Tidy the SCHEMATIC sheet: spread parts (x/y) with generous spacing so symbols don't
    overlap and wires have lanes, then re-route every wire so nets flow around parts instead
    of straight through them. This is what makes an auto-built schematic readable."""
    parts = [c for c in session["components"] if _lib_of(c["type"]).get("category") != "power"]
    if parts:
        def half(c):
            cat = _lib_of(c["type"]).get("category")
            if cat == "ic":
                return (42, 36)
            if cat == "connector":
                return (34, 30)
            return (38, 20)     # passives — wide enough that pin leads clear neighbours
        def setp(c, x, y): c["x"] = round(x); c["y"] = round(y)
        _cluster_layout(parts, half, setp, gap=48, anchor_dx=300, hug_gap=44, seed=(320, 320))
        _orient_two_pin(parts)     # rotate passives to face their connections (no wire doubling-over)
    _place_power_flags()
    _rewire_all()
    return {"ok": True, "placed": len(parts), **get_schematic()}


def _pin_world_sch(c, pin):
    """World (sheet) position of a pin, honouring the component's rotation — matches the
    renderer's `translate(x,y) rotate(rotation)` transform so wires meet the drawn pins."""
    import math
    lib = _lib_of(c["type"])
    p = lib.get("pins", {}).get(str(pin)) or lib.get("pins", {}).get(pin)
    if not p:
        return None
    r = math.radians(c.get("rotation", 0) or 0)
    lx, ly = p["x"], p["y"]
    return (c["x"] + lx * math.cos(r) - ly * math.sin(r),
            c["y"] + lx * math.sin(r) + ly * math.cos(r))


def _orient_two_pin(parts):
    """Rotate 2-pin parts (R/C/L/D) so their pin axis lines up with where they connect —
    vertical when the two ends go up/down, horizontal when they go left/right. This is what
    stops wires from 'doubling over' to reach a pin that faces the wrong way."""
    by_id = {c["id"]: c for c in session["components"]}
    for c in parts:
        if _lib_of(c["type"]).get("prefix") not in ("R", "C", "L", "D"):
            continue
        pins = _lib_of(c["type"]).get("pins", {})
        if len(pins) != 2:
            continue
        names = list(pins.keys())

        def target(pin):
            for nn, members in session["nets"].items():
                if any(m["comp_id"] == c["id"] and str(m["pin"]) == str(pin) for m in members):
                    xs, ys = [], []
                    for m in members:
                        o = by_id.get(m["comp_id"])
                        if o and o is not c:
                            xs.append(o["x"]); ys.append(o["y"])
                    if xs:
                        return (sum(xs) / len(xs), sum(ys) / len(ys))
            return None
        t1, t2 = target(names[0]), target(names[1])
        if not t1 or not t2:
            continue
        c["rotation"] = 90 if abs(t2[1] - t1[1]) > abs(t2[0] - t1[0]) else 0


def _place_power_flags():
    """Put each power flag (VCC/GND) next to the parts on its net — VCC above, GND below,
    like a hand-drawn schematic — after the signal parts have been placed."""
    by_id = {c["id"]: c for c in session["components"]}
    for pc in session["components"]:
        lib = _lib_of(pc["type"])
        if lib.get("category") != "power":
            continue
        neigh = []
        for nn, members in session["nets"].items():
            if any(m["comp_id"] == pc["id"] for m in members):
                for m in members:
                    c = by_id.get(m["comp_id"])
                    if c and c is not pc and _lib_of(c["type"]).get("category") != "power":
                        neigh.append(c)
        if not neigh:
            continue
        cx = sum(c["x"] for c in neigh) / len(neigh)
        cy = sum(c["y"] for c in neigh) / len(neigh)
        name = (pc.get("properties", {}).get("net") or lib.get("name", "")).upper()
        pc["x"] = round(cx); pc["y"] = round(cy + (110 if "GND" in name else -110))


def _build_net_wires(net_names):
    """A*-route each named net's pins (chained) against current part positions, appending
    the resulting wires. Rotation-aware pin positions so wires meet the drawn pins."""
    by_id = {c["id"]: c for c in session["components"]}
    for nn in net_names:
        pts = []
        for m in session["nets"].get(nn, []):
            c = by_id.get(m["comp_id"])
            if not c:
                continue
            w = _pin_world_sch(c, m["pin"])
            if w is None:
                continue
            pts.append((w[0], w[1], c["id"]))
        for i in range(len(pts) - 1):
            ax, ay, aid = pts[i]; bx, by, bid = pts[i + 1]
            path = _astar_route(ax, ay, bx, by, _get_obstacles(), exclude_ids={aid, bid})
            if path and len(path) >= 2:
                session["wires"].append({"id": _next_id(), "points": path, "net": nn, "junctions": []})


def _recompute_junctions():
    """Junction dots where 3+ wire endpoints coincide; parked on the first wire for drawing."""
    from collections import defaultdict as _dd
    tally = _dd(int)
    for w in session["wires"]:
        for ep in (w["points"][0], w["points"][-1]):
            tally[(round(ep[0], 1), round(ep[1], 1))] += 1
    dots = [[k[0], k[1]] for k, n in tally.items() if n >= 3]
    for w in session["wires"]:
        w["junctions"] = []
    if session["wires"]:
        session["wires"][0]["junctions"] = dots


def _rewire_all():
    """Rebuild every schematic wire from the net list against current part positions."""
    session["wires"] = []
    _build_net_wires(list(session["nets"].keys()))
    _recompute_junctions()


def _rewire_nets(net_names):
    """Re-route just the given nets (used after rotating/moving one part) — leaves other wires be."""
    names = set(net_names)
    session["wires"] = [w for w in session["wires"] if w.get("net") not in names]
    _build_net_wires([n for n in session["nets"] if n in names])
    _recompute_junctions()


def rotate_component(comp_id, delta=90) -> dict:
    """Rotate one part in place by `delta` degrees and re-route the nets touching it so its
    wires follow — the manual 'press R to rotate' action in the schematic editor."""
    c = next((x for x in session["components"] if x["id"] == comp_id or x["ref"] == comp_id), None)
    if not c:
        return {"ok": False, "error": f"Component not found: {comp_id}"}
    c["rotation"] = (int(c.get("rotation", 0)) + int(delta)) % 360
    touching = [nn for nn, ms in session["nets"].items() if any(m["comp_id"] == c["id"] for m in ms)]
    if touching:
        _rewire_nets(touching)
    return {"ok": True, "rotation": c["rotation"], **get_schematic()}


def _get_obstacles():
    """Get bounding boxes of all components as obstacles for routing."""
    obstacles = []
    MARGIN = 10  # routing clearance around components
    for c in session["components"]:
        lib = _lib_of(c["type"])
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
    lib_a = _lib_of(comp_a["type"])
    lib_b = _lib_of(comp_b["type"])
    pin_a = lib_a.get("pins", {}).get(from_pin)
    pin_b = lib_b.get("pins", {}).get(to_pin)
    if not pin_a:
        return {"ok": False, "error": f"Pin {from_pin} not found on {comp_a['ref']}. Available: {list(lib_a.get('pins', {}).keys())}"}
    if not pin_b:
        return {"ok": False, "error": f"Pin {to_pin} not found on {comp_b['ref']}. Available: {list(lib_b.get('pins', {}).keys())}"}

    # Calculate absolute pin positions (rotation-aware, matching the renderer)
    ax, ay = _pin_world_sch(comp_a, from_pin)
    bx, by = _pin_world_sch(comp_b, to_pin)

    # Reuse the net a pin already belongs to, so wiring a 3rd pin JOINS the
    # existing net instead of forking a new one (that's how a real net grows).
    def _net_of(comp_id, pin):
        for nn, members in session["nets"].items():
            if any(m["comp_id"] == comp_id and str(m["pin"]) == str(pin) for m in members):
                return nn
        return None
    # A power flag names the rail: wiring to GND/VCC/3V3 puts the pin on that named net,
    # so power/ground nets merge into one rail (and a ground pour has a real net to fill).
    def _power_net(c):
        lib = _lib_of(c["type"])
        if lib.get("category") == "power":
            return c.get("properties", {}).get("net") or lib.get("properties", {}).get("net")
        return None
    if not net_name:
        net_name = (_power_net(comp_a) or _power_net(comp_b)
                    or _net_of(comp_a["id"], from_pin)
                    or _net_of(comp_b["id"], to_pin)
                    or f"NET_{len(session['wires']) + 1}")

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

    # Update netlist (dedup — a pin appears once per net even if wired repeatedly)
    if net_name not in session["nets"]:
        session["nets"][net_name] = []
    # MERGE: if either pin already sits on a DIFFERENT net, fold that whole net into this one
    # (else grounding an already-wired pin would leave it in two nets and drop the connection).
    for cid, pn in [(comp_a["id"], from_pin), (comp_b["id"], to_pin)]:
        old = _net_of(cid, pn)
        if old and old != net_name:
            for mbr in session["nets"].pop(old, []):
                if not any(m["comp_id"] == mbr["comp_id"] and str(m["pin"]) == str(mbr["pin"])
                           for m in session["nets"][net_name]):
                    session["nets"][net_name].append(mbr)
            for w in session["wires"]:
                if w.get("net") == old:
                    w["net"] = net_name
    for cid, pn in [(comp_a["id"], from_pin), (comp_b["id"], to_pin)]:
        if not any(m["comp_id"] == cid and str(m["pin"]) == str(pn) for m in session["nets"][net_name]):
            session["nets"][net_name].append({"comp_id": cid, "pin": pn})

    return {"ok": True, "wire": wire, **get_schematic()}


def get_schematic() -> dict:
    """Return the full schematic state."""
    return {
        "components": session["components"],
        "wires": session["wires"],
        "nets": session["nets"],
        "tracks": session["tracks"],
        "zones": session.get("zones", []),
        "netclasses": session.get("netclasses", {}),
        "net_class": {n: net_class_of(n) for n in session["nets"]},   # net -> class assignment
        "n_components": len(session["components"]),
        "n_wires": len(session["wires"]),
        "n_nets": len(session["nets"]),
        "n_tracks": len(session["tracks"]),
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
    session["tracks"] = []
    session["zones"] = []
    session["net_assign"] = {}
    session["custom_lib"] = {}
    session["netclasses"] = {
        "Default": {"track_width": 0.25, "clearance": 0.2, "via_dia": 0.6, "via_drill": 0.3},
        "Power":   {"track_width": 0.6,  "clearance": 0.2, "via_dia": 0.8, "via_drill": 0.4},
    }
    session["next_id"] = 1
    return {"ok": True, **get_schematic()}


# ── Routed tracks (from the KiCad WASM router) ──────────────────────────────

def add_track(track: dict = None, **kw) -> dict:
    """Persist a routed track (segments + optional vias) on the board."""
    track = track or kw
    tid = _next_id()
    t = {
        "id": tid,
        "segs": track.get("segs", []),        # [{ax,ay,bx,by,layer}] in world units
        "vias": track.get("vias", []),        # [{x,y}]
        "net": track.get("net"),
        "a": track.get("a"), "b": track.get("b"),
        "width": track.get("width", 5),
    }
    session["tracks"].append(t)
    return {"ok": True, "id": tid, **get_schematic()}


def remove_track(track_id: str) -> dict:
    session["tracks"] = [t for t in session["tracks"] if t["id"] != track_id]
    return {"ok": True, **get_schematic()}


def clear_tracks() -> dict:
    session["tracks"] = []
    return {"ok": True, **get_schematic()}


def _pad_world(comp, pin_name) -> tuple:
    """World-unit coordinates for a named pin on a placed component."""
    S = 0.05  # world units per mm
    pcb_x = comp.get("pcb_x", comp["x"])
    pcb_y = comp.get("pcb_y", comp["y"])
    geo = footprint_geometry(comp["type"])
    if geo and pin_name in geo.get("pins", {}):
        p = geo["pins"][pin_name]
        return pcb_x + p["x"] / S, pcb_y + p["y"] / S
    return float(pcb_x), float(pcb_y)


def auto_route_all() -> dict:
    """Auto-place (if needed) then A*-route every unrouted net on F.Cu.
    Returns the number of routes added and any nets that failed."""
    # Auto-place if nothing has pcb positions yet
    has_pcb = any("pcb_x" in c for c in session["components"]
                  if _lib_of(c["type"]).get("category") != "power")
    if not has_pcb:
        auto_place_pcb()

    # Build comp index by id
    comp_by_id = {c["id"]: c for c in session["components"]}

    # For each net build list of (wx, wy, comp_id, pin_name) for each pin
    net_endpoints: dict = {}
    for net_name, pins in session["nets"].items():
        pts = []
        for p in pins:
            comp = comp_by_id.get(p["comp_id"])
            if not comp or _lib_of(comp["type"]).get("category") == "power":
                continue
            wx, wy = _pad_world(comp, p["pin"])
            pts.append((wx, wy, comp["id"], p["pin"]))
        if len(pts) >= 2:
            net_endpoints[net_name] = pts

    # Build obstacle list from placed components
    obstacles = []
    MARGIN = 8
    for c in session["components"]:
        if _lib_of(c["type"]).get("category") == "power":
            continue
        geo = footprint_geometry(c["type"])
        S = 0.05
        if geo and geo.get("bbox"):
            b = geo["bbox"]
            hw = max(abs(b[0]), abs(b[2])) / S
            hh = max(abs(b[1]), abs(b[3])) / S
        else:
            lib = _lib_of(c["type"])
            hw = lib.get("w", 40) / 2
            hh = lib.get("h", 30) / 2
        pcx = c.get("pcb_x", c["x"])
        pcy = c.get("pcb_y", c["y"])
        obstacles.append({"id": c["id"], "x1": pcx - hw - MARGIN, "y1": pcy - hh - MARGIN,
                           "x2": pcx + hw + MARGIN, "y2": pcy + hh + MARGIN})

    routed, failed = 0, []
    net_class_widths = {"Power": 8, "Default": 5}

    for net_name, pts in net_endpoints.items():
        nc = net_class_of(net_name)
        width = round(net_class_widths.get(nc, 5))
        # Chain-route: 0→1, 1→2, 2→3, …  (simple daisy-chain MST approx)
        for i in range(len(pts) - 1):
            ax, ay, aid, apin = pts[i]
            bx, by, bid, bpin = pts[i + 1]
            path = _astar_route(ax, ay, bx, by, obstacles, exclude_ids={aid, bid})
            if not path or len(path) < 2:
                failed.append(f"{net_name}[{i}]")
                continue
            segs = [{"ax": path[j][0], "ay": path[j][1],
                     "bx": path[j+1][0], "by": path[j+1][1], "layer": 0}
                    for j in range(len(path) - 1)]
            add_track({"segs": segs, "net": net_name, "width": width,
                       "a": {"compId": aid, "pin": apin},
                       "b": {"compId": bid, "pin": bpin}})
            routed += 1

    return {"ok": True, "routed": routed, "failed": failed, **get_schematic()}


# ── Copper zones (ground / power planes) ────────────────────────────────────

def _board_bbox_world(margin=40):
    """Bounding box of placed footprints (PCB positions) + margin, in world units."""
    xs, ys = [], []
    for comp in session["components"]:
        lib = _lib_of(comp["type"])
        if lib.get("category") == "power":
            continue
        geo = footprint_geometry(comp["type"])
        if geo and geo.get("bbox"):
            b = geo["bbox"]; hw = max(abs(b[0]), abs(b[2])) / 0.05; hh = max(abs(b[1]), abs(b[3])) / 0.05
        else:
            hw, hh = lib.get("w", 40) / 2, lib.get("h", 30) / 2
        pcx, pcy = comp.get("pcb_x", comp["x"]), comp.get("pcb_y", comp["y"])
        xs += [pcx - hw, pcx + hw]; ys += [pcy - hh, pcy + hh]
    if not xs:
        return [0, 0, 400, 400]
    return [min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin]


def add_zone(layer: int = 0, net: str = "GND", poly=None) -> dict:
    """Add a copper pour (plane). Default: a ground plane on F.Cu covering the board
    (F.Cu so it connects the top-side SMD pads on that net; B.Cu needs via stitching).
    `poly` is an optional outline [[x,y],...] in world units; if omitted, the board rect."""
    if poly is None:
        x0, y0, x1, y1 = _board_bbox_world()
        poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    zid = _next_id()
    z = {"id": zid, "layer": int(layer), "net": net or "GND", "poly": poly}
    session["zones"].append(z)
    return {"ok": True, "id": zid, "zone": z, **get_schematic()}


def remove_zone(zone_id: str) -> dict:
    session["zones"] = [z for z in session["zones"] if z["id"] != zone_id]
    return {"ok": True, **get_schematic()}


def clear_zones() -> dict:
    session["zones"] = []
    return {"ok": True, **get_schematic()}


# ── Netclasses (per-net trace width / clearance) ────────────────────────────

def set_netclass(name: str, track_width: float = None, clearance: float = None,
                 via_dia: float = None, via_drill: float = None) -> dict:
    """Update a netclass's design rules (mm). Creates the class if new."""
    nc = session["netclasses"].setdefault(name, {"track_width": 0.25, "clearance": 0.2, "via_dia": 0.6, "via_drill": 0.3})
    if track_width is not None: nc["track_width"] = float(track_width)
    if clearance is not None:   nc["clearance"] = float(clearance)
    if via_dia is not None:     nc["via_dia"] = float(via_dia)
    if via_drill is not None:   nc["via_drill"] = float(via_drill)
    return {"ok": True, **get_schematic()}


def assign_net(net: str, netclass: str) -> dict:
    """Force a net into a netclass (overrides the power-rail auto-assignment)."""
    session["net_assign"][net] = netclass
    return {"ok": True, **get_schematic()}


# ── BOM (assembly bill of materials) ────────────────────────────────────────

def export_bom(path: str = None) -> dict:
    """Write a JLCPCB-style assembly BOM CSV — parts grouped by (value, footprint,
    LCSC), designators comma-joined. Power flags are skipped (not physical parts)."""
    import csv
    if not path:
        out_dir = Path.home() / ".jac" / "cad_out"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = str(out_dir / "bom.csv")
    groups = {}   # (value, footprint, lcsc) -> [refs]
    for c in session["components"]:
        lib = _lib_of(c["type"])
        if lib.get("category") == "power":
            continue
        props = c.get("properties", {})
        value = props.get("value", "") or c.get("type", "")
        fp = props.get("footprint", "")
        lcsc = props.get("lcsc", "")
        groups.setdefault((value, fp, lcsc), []).append(c.get("ref", "") or "?")
    rows = 0; parts = 0; no_lcsc = 0
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
        for (value, fp, lcsc), refs in sorted(groups.items(), key=lambda kv: sorted(kv[1])):
            refs_sorted = sorted(refs)
            w.writerow([value, ",".join(refs_sorted), fp, lcsc])
            rows += 1; parts += len(refs_sorted)
            if not lcsc:
                no_lcsc += 1
    return {"ok": True, "path": path, "lines": rows, "parts": parts, "missing_lcsc": no_lcsc}


# ── ERC (electrical rules check on the schematic) ───────────────────────────

# Electrical type per pin. Most JAC parts are passive; power flags drive rails; ICs
# have real in/out/power pins. Kept as a side map so COMPONENT_LIB stays position-only.
_PIN_TYPES = {
    "vcc": {"1": "power_out"}, "gnd": {"1": "power_out"}, "3v3": {"1": "power_out"},
    "555": {"GND": "power_in", "VCC": "power_in", "OUT": "output", "DISCH": "output",
            "TRIG": "input", "RESET": "input", "CTRL": "input", "THRES": "input"},
    "esp32": {"3V3": "power_in", "GND": "power_in", "EN": "input", "RX": "input", "TX": "output",
              "GPIO0": "bidi", "GPIO1": "bidi", "GPIO2": "bidi", "USB_D+": "bidi", "USB_D-": "bidi"},
    "ic_generic": {str(i): "bidi" for i in range(1, 7)},
    "usb_c": {"VBUS": "power_in", "GND": "power_in", "CC1": "bidi", "CC2": "bidi", "D+": "bidi", "D-": "bidi"},
    # npn/pnp intentionally left passive (base-resistor topologies would false-positive as "undriven")
}
_DRIVERS = {"output", "power_out", "bidi"}

def pin_type(comp_type, pin_name):
    return _PIN_TYPES.get(comp_type, {}).get(str(pin_name), "passive")


def run_erc() -> dict:
    """Electrical Rules Check on the schematic model: floating pins, dangling nets,
    duplicate refs, and a no-ground sanity check. (Pin electrical types aren't modeled
    yet, so output-conflict / no-driver checks are future work.)"""
    issues = []
    pin_net = {}
    for nn, members in session["nets"].items():
        for m in members:
            pin_net[(m["comp_id"], str(m["pin"]))] = nn

    # 1) unconnected pins — every pin should go somewhere
    for c in session["components"]:
        lib = _lib_of(c["type"])
        is_power = lib.get("category") == "power"
        for pin_name in lib.get("pins", {}):
            if (c["id"], str(pin_name)) not in pin_net:
                issues.append({
                    "severity": "warning", "type": "unconnected_pin",
                    "message": ("Unused power flag " + c["ref"] if is_power
                                else f'{c["ref"]} pin {pin_name} is unconnected'),
                    "comp_id": c["id"], "pin": str(pin_name)})

    # 2) single-connection nets — a net that reaches only one pin does nothing
    for nn, members in session["nets"].items():
        uniq = {(m["comp_id"], str(m["pin"])) for m in members}
        if len(uniq) < 2:
            first = members[0] if members else {}
            issues.append({"severity": "warning", "type": "single_pin_net",
                           "message": f'Net "{nn}" has only one connection',
                           "comp_id": first.get("comp_id"), "pin": (str(first["pin"]) if first else None)})

    # 3) duplicate reference designators (annotation error)
    seen = {}
    for c in session["components"]:
        seen.setdefault(c["ref"], []).append(c["id"])
    for ref, ids in seen.items():
        if ref and len(ids) > 1:
            issues.append({"severity": "error", "type": "duplicate_ref",
                           "message": f'Reference "{ref}" used by {len(ids)} parts',
                           "comp_id": ids[0], "pin": None})

    # 4) sanity: a board with real parts but no ground net
    has_parts = any(_lib_of(c["type"]).get("category") != "power" for c in session["components"])
    has_gnd = any(n.upper() in ("GND", "AGND", "DGND", "GNDA", "PGND", "VSS") for n in session["nets"])
    if has_parts and not has_gnd:
        issues.append({"severity": "warning", "type": "no_ground",
                       "message": "No ground (GND) net on the board", "comp_id": None, "pin": None})

    # 5) pin-electrical-type checks (needs the pin type map)
    comp_by_id = {c["id"]: c for c in session["components"]}
    for nn, members in session["nets"].items():
        typed = []   # (comp, pin, etype)
        for m in members:
            c = comp_by_id.get(m["comp_id"])
            if c:
                typed.append((c, str(m["pin"]), pin_type(c["type"], m["pin"])))
        etypes = [t[2] for t in typed]
        outs = [t for t in typed if t[2] == "output"]
        if len(outs) >= 2:      # two drivers fighting on one net
            issues.append({"severity": "error", "type": "output_conflict",
                           "message": f'Net "{nn}" has {len(outs)} outputs driving it ('
                                      + ", ".join(f'{c["ref"]}.{p}' for c, p, _ in outs) + ")",
                           "comp_id": outs[0][0]["id"], "pin": outs[0][1]})
        if "power_in" in etypes and "power_out" not in etypes:   # a supply pin with no source
            pi = next(t for t in typed if t[2] == "power_in")
            issues.append({"severity": "warning", "type": "power_unpowered",
                           "message": f'{pi[0]["ref"]} pin {pi[1]} needs a power source — net "{nn}" has no supply (add a {("GND" if "GND" in nn.upper() else "power")} flag)',
                           "comp_id": pi[0]["id"], "pin": pi[1]})

    errors = sum(1 for i in issues if i["severity"] == "error")
    warnings = sum(1 for i in issues if i["severity"] == "warning")
    return {"ok": True, "issues": issues, "errors": errors, "warnings": warnings}


# ── Project persistence (open / save a whole board) ─────────────────────────

_PROJECT_KEYS = ("components", "wires", "nets", "tracks", "zones", "netclasses", "net_assign", "custom_lib")

def save_project(path: str) -> dict:
    """Save the whole schematic + board session to a .jac (JSON) file."""
    import json as _json
    try:
        data = {"version": 1, "next_id": session.get("next_id", 1)}
        for k in _PROJECT_KEYS:
            data[k] = session.get(k)
        with open(path, "w", encoding="utf-8") as f:
            _json.dump(data, f, indent=1)
        return {"ok": True, "path": path, "n_components": len(session["components"])}
    except Exception as e:
        return {"ok": False, "error": f"Save failed: {e}"}


def load_project(path: str) -> dict:
    """Load a saved .jac project, replacing the current session."""
    import json as _json
    try:
        with open(path, encoding="utf-8") as f:
            data = _json.load(f)
    except Exception as e:
        return {"ok": False, "error": f"Cannot read project: {e}"}
    if not isinstance(data, dict) or "components" not in data:
        return {"ok": False, "error": "Not a JAC project file."}
    for k in _PROJECT_KEYS:
        if k in data and data[k] is not None:
            session[k] = data[k]
    session["next_id"] = data.get("next_id", session.get("next_id", 1))
    session.setdefault("zones", [])
    session.setdefault("net_assign", {})
    session.setdefault("netclasses", {
        "Default": {"track_width": 0.25, "clearance": 0.2, "via_dia": 0.6, "via_drill": 0.3},
        "Power":   {"track_width": 0.6,  "clearance": 0.2, "via_dia": 0.8, "via_drill": 0.4},
    })
    return {"ok": True, "path": path, **get_schematic()}


# ── Autosave: the working board lives only in this process's memory, so mirror it
# to ~/.jac/pcb/_autosave.jac after every mutation and restore it on startup. A JAC
# restart (or a crash) then never loses the board. Explicit Save/Open is unaffected. ──
import os as _os
_AUTOSAVE_PATH = _os.path.join(_os.path.expanduser("~"), ".jac", "pcb", "_autosave.jac")

def _autosave():
    try:
        _os.makedirs(_os.path.dirname(_AUTOSAVE_PATH), exist_ok=True)
        save_project(_AUTOSAVE_PATH)
    except Exception as e:
        log.warning("autosave failed: %s", e)

def _restore_autosave():
    if _os.path.exists(_AUTOSAVE_PATH) and not session["components"]:
        r = load_project(_AUTOSAVE_PATH)
        if r.get("ok"):
            log.info("restored autosaved board (%d parts)", len(session["components"]))


def _net_of_pad(comp_id, pin):
    for nn, pins in session["nets"].items():
        if any(p["comp_id"] == comp_id and str(p["pin"]) == str(pin) for p in pins):
            return nn
    return ""


# ── Real KiCad footprints (blocker #1) ──────────────────────────────────────
# Replace toy 0.8mm pads with real KiCad land patterns: read the shipped .kicad_mod
# files, parse geometry for the canvas, and splice the raw footprint (with nets
# injected) into the exported board — self-contained, no fp-lib-table needed.
import os as _os

_FP_DIR = None
def _ver_key(name):
    """Sort '10.0' after '9.0' numerically (a plain string sort gets this backwards)."""
    key = []
    for p in name.split("."):
        try: key.append((1, int(p)))
        except ValueError: key.append((0, p))
    return key
def find_footprints_dir():
    """Locate KiCad's shipped footprints dir (mirrors the app's findKicad). Only a
    successful result is cached, so a transient early-boot miss retries next call."""
    global _FP_DIR
    if _FP_DIR:
        return _FP_DIR
    env = _os.environ.get("KICAD_FOOTPRINT_DIR")
    if env and _os.path.isdir(env):
        _FP_DIR = env; return env
    roots = []
    la = _os.path.join(_os.path.expanduser("~"), "AppData", "Local", "Programs", "KiCad")
    for base in (la, r"C:\Program Files\KiCad", r"C:\Program Files (x86)\KiCad"):
        try:
            for v in sorted(_os.listdir(base), key=_ver_key, reverse=True):   # newest version first
                roots.append(_os.path.join(base, v))
        except OSError:
            pass
    roots += ["/usr/share/kicad", "/usr/local/share/kicad",
              "/Applications/KiCad/KiCad.app/Contents/SharedSupport"]
    for r in roots:
        for cand in (_os.path.join(r, "share", "kicad", "footprints"),
                     _os.path.join(r, "footprints")):
            if _os.path.isdir(cand):
                _FP_DIR = cand; return cand
    return None                                              # not found — don't cache, retry later

# type -> (pretty_lib, footprint_name, {symbol_pin: fp_pad | [fp_pads]})
# Pin->pad maps verified against the .kicad_mod files (polarity/order matters):
# LED/diode cathode = pad 1; SOT-23 BJT B/E/C = 1/2/3; tantalum + = pad 1.
FOOTPRINTS = {
    "resistor":       ("Resistor_SMD", "R_0402_1005Metric", {"1": "1", "2": "2"}),
    "capacitor":      ("Capacitor_SMD", "C_0402_1005Metric", {"1": "1", "2": "2"}),
    "cap_polar":      ("Capacitor_Tantalum_SMD", "CP_EIA-3216-18_Kemet-A", {"+": "1", "-": "2"}),
    "inductor":       ("Inductor_SMD", "L_0805_2012Metric", {"1": "1", "2": "2"}),
    "led":            ("LED_SMD", "LED_0603_1608Metric", {"K": "1", "A": "2"}),
    "diode":          ("Diode_SMD", "D_SOD-323", {"K": "1", "A": "2"}),
    "npn":            ("Package_TO_SOT_SMD", "SOT-23", {"B": "1", "E": "2", "C": "3"}),
    "pnp":            ("Package_TO_SOT_SMD", "SOT-23", {"B": "1", "E": "2", "C": "3"}),
    "ic_generic":     ("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm",
                       {"1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6"}),
    "555":            ("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm",
                       {"GND": "1", "TRIG": "2", "OUT": "3", "RESET": "4", "CTRL": "5", "THRES": "6", "DISCH": "7", "VCC": "8"}),
    "connector_2pin": ("Connector_PinHeader_2.54mm", "PinHeader_1x02_P2.54mm_Vertical", {"1": "1", "2": "2"}),
    "esp32":          ("RF_Module", "ESP32-S3-WROOM-1",
                       {"3V3": "2", "EN": "3", "GND": ["1", "40", "41"], "GPIO0": "27", "TX": "37", "RX": "36",
                        "USB_D+": "14", "USB_D-": "13", "GPIO1": "39", "GPIO2": "38"}),   # 41 = thermal EPAD → GND
    "usb_c":          ("Connector_USB", "USB_C_Receptacle_HRO_TYPE-C-31-M-12",
                       {"VBUS": ["A4", "B4", "A9", "B9"], "GND": ["A1", "B1", "A12", "B12", "SH"],   # SH = shield shell → GND
                        "CC1": ["A5"], "CC2": ["B5"], "D+": ["A6", "B6"], "D-": ["A7", "B7"]}),
}

def _fp_tok(s):
    toks, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c in "()":
            toks.append(c); i += 1
        elif c == '"':
            j = i + 1; buf = []
            while j < n and s[j] != '"':
                if s[j] == "\\" and j + 1 < n: buf.append(s[j + 1]); j += 2
                else: buf.append(s[j]); j += 1
            toks.append(("str", "".join(buf))); i = j + 1
        elif c.isspace():
            i += 1
        else:
            j = i
            while j < n and s[j] not in "() \t\r\n": j += 1
            toks.append(("atom", s[i:j])); i = j
    return toks

def _fp_parse(s):
    toks = _fp_tok(s); pos = 0
    def rd():
        nonlocal pos
        t = toks[pos]; pos += 1
        if t == "(":
            lst = []
            while toks[pos] != ")": lst.append(rd())
            pos += 1; return lst
        return t
    out = []
    while pos < len(toks): out.append(rd())
    return out[0] if len(out) == 1 else out

def _fp_sym(node):
    return node[0][1] if node and isinstance(node[0], tuple) else None
def _fp_atoms(node):
    return [t[1] for t in node if isinstance(t, tuple)]
def _fp_subs(node, head):
    return [c for c in node if isinstance(c, list) and _fp_sym(c) == head]
def _fp_mk(items):
    return [it if isinstance(it, tuple) else ("atom", str(it)) for it in items]
def _fp_ser(node):
    if isinstance(node, tuple):
        k, v = node
        if k == "str": return '"%s"' % str(v).replace("\\", "\\\\").replace('"', '\\"')
        return str(v)
    return "(" + " ".join(_fp_ser(c) for c in node) + ")"

_FP_TREE_CACHE = {}
def _fp_load(pretty, name):
    key = (pretty, name)
    if _FP_TREE_CACHE.get(key) is not None:
        return _FP_TREE_CACHE[key]
    d = find_footprints_dir(); tree = None
    if d:
        p = _os.path.join(d, pretty + ".pretty", name + ".kicad_mod")
        try: tree = _fp_parse(open(p, encoding="utf-8").read())
        except OSError: tree = None
    if tree is not None:                                     # only cache a real parse — a miss retries
        _FP_TREE_CACHE[key] = tree
    return tree

def _fp_points(node):
    pts = []
    for st in ("start", "end", "center", "mid"):
        sl = _fp_subs(node, st)
        if sl:
            a = _fp_atoms(sl[0])
            if len(a) >= 3: pts.append((float(a[1]), float(a[2])))
    pl = _fp_subs(node, "pts")
    if pl:
        for xy in _fp_subs(pl[0], "xy"):
            a = _fp_atoms(xy)
            if len(a) >= 3: pts.append((float(a[1]), float(a[2])))
    return pts

def _footprint_spec(comp_type):
    """(pretty_lib, footprint_name, pin_map|None) for a type. pin_map None = identity
    (footprint pad number IS the symbol pin) — used for placed KiCad symbols."""
    if comp_type in FOOTPRINTS:
        return FOOTPRINTS[comp_type]
    cl = session.get("custom_lib", {}).get(comp_type)
    if cl and cl.get("footprint_ref") and ":" in cl["footprint_ref"]:
        pretty, name = cl["footprint_ref"].split(":", 1)
        return (pretty, name, None)
    return None


def footprint_geometry(comp_type):
    """Parsed land pattern for the canvas: all pads (mm), a representative pad
    per symbol pin (for routing/ratsnest), courtyard, silk, bbox. None for power."""
    spec = _footprint_spec(comp_type)
    if not spec: return None
    pretty, name, pin_map = spec
    tree = _fp_load(pretty, name)
    if not tree: return None
    pads = {}; silk = []; crtyd = []
    for node in tree:
        if not isinstance(node, list): continue
        h = _fp_sym(node)
        if h == "pad":
            a = _fp_atoms(node)
            num, ptype, shape = a[1], a[2], (a[3] if len(a) > 3 else "rect")
            at = _fp_atoms(_fp_subs(node, "at")[0])[1:]
            sz = _fp_atoms(_fp_subs(node, "size")[0])[1:]
            dl = _fp_subs(node, "drill"); rr = _fp_subs(node, "roundrect_rratio")
            pads[num] = {
                "x": float(at[0]), "y": float(at[1]),
                "w": float(sz[0]), "h": float(sz[1]), "shape": shape,
                "thru": ptype != "smd",
                "drill": (float(_fp_atoms(dl[0])[1]) if dl and len(_fp_atoms(dl[0])) > 1 else None),
                "rratio": (float(_fp_atoms(rr[0])[1]) if rr else None),
            }
        elif h in ("fp_line", "fp_rect", "fp_poly"):
            ll = _fp_subs(node, "layer"); layer = _fp_atoms(ll[0])[1] if ll else ""
            p = _fp_points(node)
            if layer == "F.CrtYd": crtyd += p
            elif layer == "F.SilkS" and p: silk.append(p)
    pins = {}
    if pin_map is None:                        # KiCad symbol: symbol pin number == footprint pad number
        for pid, pad in pads.items():
            pins[pid] = {"x": pad["x"], "y": pad["y"]}
    else:
        for spin, pad in pin_map.items():
            for pid in (pad if isinstance(pad, list) else [pad]):
                if pid in pads:
                    pins[spin] = {"x": pads[pid]["x"], "y": pads[pid]["y"]}; break
    xs, ys = [], []
    for p in pads.values():
        xs += [p["x"] - p["w"] / 2, p["x"] + p["w"] / 2]
        ys += [p["y"] - p["h"] / 2, p["y"] + p["h"] / 2]
    court = None
    if crtyd:
        cx = [p[0] for p in crtyd]; cy = [p[1] for p in crtyd]
        court = [min(cx), min(cy), max(cx), max(cy)]
    bbox = court or ([min(xs), min(ys), max(xs), max(ys)] if xs else [-1, -1, 1, 1])
    return {"ref": name,
            "pads": [dict(id=k, **v) for k, v in pads.items()],
            "pins": pins, "courtyard": court, "silk": silk, "bbox": bbox}

def footprint_export(comp, net_index, net_of_pad, mm, uid):
    """Splice the real .kicad_mod for `comp`: bare name, placed (at cx cy rot),
    nets injected onto mapped pads, 3D model dropped. Returns an s-expr string, or
    None if this type has no footprint (power flags) or the file can't be read."""
    spec = _footprint_spec(comp["type"])
    if not spec: return None
    pretty, name, pin_map = spec
    tree = _fp_load(pretty, name)
    if not tree: return None
    import copy
    fp = copy.deepcopy(tree)
    # KiCad's (at ... angle) rotates pads with the OPPOSITE handedness to the canvas/router
    # (which use R(+rot) in a Y-down frame). Negate so exported pads land where tracks were routed.
    cx, cy, rot = mm(comp.get("pcb_x", comp["x"])), mm(comp.get("pcb_y", comp["y"])), (-comp.get("rotation", 0)) % 360
    inv = {}   # fp_pad_id -> symbol_pin (empty when identity: pad number == symbol pin)
    if pin_map is not None:
        for spin, pad in pin_map.items():
            for pid in (pad if isinstance(pad, list) else [pad]): inv[pid] = spin
    new, placed = [], False
    for child in fp:
        if not isinstance(child, list):
            new.append(child); continue                      # 'footprint' atom, name str
        h = _fp_sym(child)
        if h in ("model",):                                  # drop 3D ref (env var may be unset)
            continue
        if h == "property":
            pa = _fp_atoms(child)
            if len(pa) >= 3 and pa[1] == "Reference" and isinstance(child[2], tuple):
                child[2] = ("str", str(comp.get("ref", "")))
            new.append(child); continue
        if h == "pad":
            pid = _fp_atoms(child)[1]; spin = pid if pin_map is None else inv.get(pid)
            if spin is not None:
                netn = net_of_pad(comp["id"], spin)
                if netn:
                    child.append(_fp_mk(["net", net_index.get(netn, 0), ("str", netn)]))
            new.append(child); continue
        new.append(child)
        if h == "layer" and not placed:                      # place the footprint after its layer
            new.append(_fp_mk(["at", cx, cy, rot]))
            new.append(_fp_mk(["uuid", ("str", uid())]))
            placed = True
    return "  " + _fp_ser(new)


def export_pcb(path: str = None) -> dict:
    """Export a real KiCad .kicad_pcb — footprints (pads on nets) + routed segments + vias."""
    import uuid as _uuid

    if not path:
        out_dir = Path.home() / ".jac" / "cad_out"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = str(out_dir / "board.kicad_pcb")

    S = 0.05                                    # world units -> mm (router used 0.05 mm/unit)
    def mm(v): return round(float(v) * S, 4)
    def uid(): return str(_uuid.uuid4())
    layer_name = {0: "F.Cu", 1: "B.Cu"}

    # net table: net 0 is the no-net; then one per schematic net
    net_names = [""]
    def _reg(nn):
        if nn and nn not in net_names:
            net_names.append(nn)
    for nn in session["nets"].keys():
        _reg(nn)
    for t in session["tracks"]:                 # tracks/zones may reference a net; give it a real index
        _reg(t.get("net"))
    for z in session.get("zones", []):
        _reg(z.get("net"))
    net_index = {n: i for i, n in enumerate(net_names)}

    L = []
    L.append('(kicad_pcb (version 20221018) (generator "jac_pcb_tools")')
    L.append('  (general (thickness 1.6))')
    L.append('  (paper "A4")')
    L.append('  (layers')
    L.append('    (0 "F.Cu" signal)')
    L.append('    (31 "B.Cu" signal)')
    L.append('    (34 "B.Paste" user)')
    L.append('    (35 "F.Paste" user)')
    L.append('    (36 "B.SilkS" user)')
    L.append('    (37 "F.SilkS" user)')
    L.append('    (38 "B.Mask" user)')
    L.append('    (39 "F.Mask" user)')
    L.append('    (44 "Edge.Cuts" user)')
    L.append('    (48 "F.CrtYd" user)')
    L.append('    (49 "B.CrtYd" user)')
    L.append('    (50 "F.Fab" user)')
    L.append('    (51 "B.Fab" user)')
    L.append('  )')
    L.append('  (setup (pad_to_mask_clearance 0))')
    for n, i in net_index.items():
        L.append(f'  (net {i} "{n}")')

    # board outline (Edge.Cuts) — bounding box of the placed parts + a 2 mm margin, or a
    # default 20x20 mm if the board is empty. Fab houses require a closed outline.
    xs, ys = [], []
    for comp in session["components"]:
        lib = _lib_of(comp["type"])
        if lib.get("category") == "power":
            continue                                          # power flags aren't on the board
        geo = footprint_geometry(comp["type"])
        if geo and geo.get("bbox"):                           # real footprint extents (mm → world)
            b = geo["bbox"]
            hw = max(abs(b[0]), abs(b[2])) / S; hh = max(abs(b[1]), abs(b[3])) / S
        else:
            hw, hh = lib.get("w", 40) / 2, lib.get("h", 30) / 2
        pcx, pcy = comp.get("pcb_x", comp["x"]), comp.get("pcb_y", comp["y"])
        xs += [pcx - hw, pcx + hw]
        ys += [pcy - hh, pcy + hh]
    for t in session["tracks"]:
        for s in t.get("segs", []):
            xs += [s["ax"], s["bx"]]; ys += [s["ay"], s["by"]]
    marg = 40  # world units (~2 mm)
    if xs:
        x0, y0, x1, y1 = min(xs) - marg, min(ys) - marg, max(xs) + marg, max(ys) + marg
    else:
        x0, y0, x1, y1 = 0, 0, 400, 400
    L.append(f'  (gr_rect (start {mm(x0)} {mm(y0)}) (end {mm(x1)} {mm(y1)}) '
             f'(stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts") (uuid "{uid()}"))')

    # footprints — one per component. Real KiCad land pattern spliced in (proper pads,
    # soldermask + paste, silk, courtyard, drills), nets injected on the mapped pads.
    for comp in session["components"]:
        lib = _lib_of(comp["type"])
        if lib.get("category") == "power":
            continue                                          # vcc/gnd/3v3 are net flags, not placed parts
        cx, cy, rot = mm(comp.get("pcb_x", comp["x"])), mm(comp.get("pcb_y", comp["y"])), comp.get("rotation", 0)
        ref = comp["ref"]
        spliced = footprint_export(comp, net_index, _net_of_pad, mm, uid)
        if spliced is not None:
            L.append(spliced)
            continue
        # Fallback (footprint file missing / unmapped type): the old inline stub, on real layers.
        fp = comp["properties"].get("footprint", "") or comp["type"]
        L.append(f'  (footprint "{fp}" (layer "F.Cu")')
        L.append(f'    (at {cx} {cy} {rot})')
        L.append(f'    (uuid "{uid()}")')
        L.append(f'    (attr smd)')
        L.append(f'    (property "Reference" "{ref}" (at 0 -2 {rot}) (layer "F.SilkS") (uuid "{uid()}") (effects (font (size 1 1) (thickness 0.15))))')
        L.append(f'    (property "Value" "{comp["properties"].get("value","")}" (at 0 2 {rot}) (layer "F.Fab") (uuid "{uid()}") (effects (font (size 1 1) (thickness 0.15))))')
        for pin_name, pin_pos in lib.get("pins", {}).items():
            netn = _net_of_pad(comp["id"], pin_name)
            ni = net_index.get(netn, 0)
            px, py = mm(pin_pos["x"]), mm(pin_pos["y"])
            L.append(f'    (pad "{pin_name}" smd roundrect (at {px} {py} {rot}) (size 0.8 0.8) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net {ni} "{netn}") (uuid "{uid()}"))')
        L.append('  )')

    # routed copper: segments + vias (vias sized by the net's netclass)
    for t in session["tracks"]:
        netn = t.get("net") or ""
        ni = net_index.get(netn, 0)
        w = max(mm(t.get("width", 5)), 0.1)
        cls = session.get("netclasses", {}).get(net_class_of(netn), session.get("netclasses", {}).get("Default", {}))
        vdia = cls.get("via_dia", 0.6); vdrill = cls.get("via_drill", 0.3)
        for s in t.get("segs", []):
            lay = layer_name.get(s.get("layer", 0), "F.Cu")
            L.append(f'  (segment (start {mm(s["ax"])} {mm(s["ay"])}) (end {mm(s["bx"])} {mm(s["by"])}) (width {w}) (layer "{lay}") (net {ni}) (uuid "{uid()}"))')
        for v in t.get("vias", []):
            L.append(f'  (via (at {mm(v["x"])} {mm(v["y"])}) (size {vdia}) (drill {vdrill}) (layers "F.Cu" "B.Cu") (net {ni}) (uuid "{uid()}"))')

    # copper zones (ground / power planes) — outline only; KiCad fills them (--refill-zones)
    for z in session.get("zones", []):
        netn = z.get("net") or ""
        if not session["nets"].get(netn):        # no pins on this net → a floating pour; don't emit it
            continue
        ni = net_index.get(netn, 0)
        lay = layer_name.get(z.get("layer", 0), "F.Cu")
        pts = " ".join(f'(xy {mm(p[0])} {mm(p[1])})' for p in z.get("poly", []))
        L.append(f'  (zone (net {ni}) (net_name "{netn}") (layer "{lay}") (uuid "{uid()}")')
        L.append(f'    (hatch edge 0.508)')
        L.append(f'    (connect_pads (clearance 0.508))')
        L.append(f'    (min_thickness 0.254)')
        L.append(f'    (fill yes (thermal_gap 0.508) (thermal_bridge_width 0.508))')
        L.append(f'    (polygon (pts {pts})))')

    L.append(')')
    content = '\n'.join(L) + '\n'
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(content, encoding="utf-8")

    # Sibling .kicad_pro (netclasses + net->class assignments) and .kicad_dru (per-class min
    # track width) so kicad-cli DRC ENFORCES per-net design rules — e.g. a too-thin power trace
    # gets flagged. kicad-cli auto-loads both when they share the board's basename.
    import json as _json
    ncs = session.get("netclasses", {}) or {}
    classes = [{
        "name": name, "clearance": nc.get("clearance", 0.2), "track_width": nc.get("track_width", 0.25),
        "via_diameter": nc.get("via_dia", 0.6), "via_drill": nc.get("via_drill", 0.3),
        "diff_pair_gap": 0.25, "diff_pair_width": 0.2, "diff_pair_via_gap": 0.25,
        "microvia_diameter": 0.3, "microvia_drill": 0.1, "bus_width": 12, "line_style": 0,
        "wire_width": 6, "priority": 0, "tuning_profile": "",
        "pcb_color": "rgba(0, 0, 0, 0.000)", "schematic_color": "rgba(0, 0, 0, 0.000)",
    } for name, nc in ncs.items()]
    pro = {
        "board": {"design_settings": {"rules": {
            "min_track_width": 0.13, "min_clearance": 0.0, "min_connection": 0.0,
            "min_via_diameter": 0.4, "min_through_hole_diameter": 0.3, "min_hole_to_hole": 0.25,
            "min_copper_edge_clearance": 0.2, "min_hole_clearance": 0.2, "min_annular_width": 0.13,
        }}},
        "net_settings": {"classes": classes, "netclass_patterns": [],
                         "netclass_assignments": {nn: net_class_of(nn) for nn in session["nets"]},
                         "meta": {"version": 4}},
    }
    Path(str(out_path.with_suffix(".kicad_pro"))).write_text(_json.dumps(pro, indent=2), encoding="utf-8")
    dru = ["(version 1)"]
    for name, nc in ncs.items():
        w = nc.get("track_width", 0.25)
        dru.append(f'(rule "min_{name}_width"\n  (constraint track_width (min {w}mm))\n  (condition "A.NetClass == \'{name}\'"))')
    Path(str(out_path.with_suffix(".kicad_dru"))).write_text("\n".join(dru) + "\n", encoding="utf-8")

    return {"ok": True, "path": str(out_path), "size": len(content),
            "n_tracks": len(session["tracks"]), "n_footprints": len(session["components"])}


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
        lib = _lib_of(comp["type"])
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
                lib = _lib_of(comp["type"])
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
    "move_component": lambda a: move_component(a["id"], a["x"], a["y"], a.get("view", "schematic")),
    "set_component_property": lambda a: set_component_property(a["id"], a["key"], a["value"]),
    "add_symbol": lambda a: add_symbol(a["def"], a.get("x", 0), a.get("y", 0), a.get("rotation", 0)),
    "auto_place_pcb": lambda a: auto_place_pcb(),
    "auto_place_sch": lambda a: auto_place_sch(),
    "rotate_component": lambda a: rotate_component(a["id"], a.get("delta", 90)),
    "auto_route_all": lambda a: auto_route_all(),
    "add_zone": lambda a: add_zone(a.get("layer", 0), a.get("net", "GND"), a.get("poly")),
    "remove_zone": lambda a: remove_zone(a["id"]),
    "clear_zones": lambda a: clear_zones(),
    "set_netclass": lambda a: set_netclass(a["name"], a.get("track_width"), a.get("clearance"), a.get("via_dia"), a.get("via_drill")),
    "assign_net": lambda a: assign_net(a["net"], a["netclass"]),
    "export_bom": lambda a: export_bom(a.get("path")),
    "run_erc": lambda a: run_erc(),
    "save_project": lambda a: save_project(a["path"]),
    "load_project": lambda a: load_project(a["path"]),
    "add_wire": lambda a: add_wire(a["from_comp"], a["from_pin"], a["to_comp"], a["to_pin"], a.get("net")),
    "get_schematic": lambda a: {"ok": True, **get_schematic()},
    "get_context": lambda a: {"ok": True, "context": get_context()},
    "reset": lambda a: reset_schematic(),
    "get_library": lambda a: {"ok": True, "library": {k: {kk: vv for kk, vv in v.items() if kk != "svg"} for k, v in COMPONENT_LIB.items()}},
    "export_kicad": lambda a: export_kicad(a.get("path")),
    "add_track": lambda a: add_track(a.get("track") or a),
    "remove_track": lambda a: remove_track(a.get("id")),
    "clear_tracks": lambda a: clear_tracks(),
    "export_pcb": lambda a: export_pcb(a.get("path")),
}


# ── HTTP Server ────────────────────────────────────────────────────────────

# tools that don't change the board — no autosave needed
_NO_AUTOSAVE = {"get_schematic", "get_context", "get_library", "run_erc",
                "export_bom", "export_kicad", "export_pcb", "save_project"}

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
            # mirror the board to disk after any mutation (skip read-only / export / explicit-save tools)
            if tool_name not in _NO_AUTOSAVE and isinstance(result, dict) and result.get("ok", True):
                _autosave()
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
            # Enrich each type with its real footprint geometry (pads/courtyard/silk) so the
            # PCB view can draw actual land patterns; None for power flags. Includes the
            # session's placed KiCad symbols so custom parts render like the built-ins.
            lib = {}
            for k, v in list(COMPONENT_LIB.items()) + list(session.get("custom_lib", {}).items()):
                entry = dict(v)
                try:
                    entry["footprint"] = footprint_geometry(k)
                except Exception:
                    entry["footprint"] = None
                lib[k] = entry
            self.respond(200, {"ok": True, "library": lib})
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
    _restore_autosave()
    server.serve_forever()


if __name__ == "__main__":
    main()
