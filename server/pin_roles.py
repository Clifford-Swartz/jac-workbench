"""Pin role inference for JAC — what a pin *does*, not just where it sits.

JAC pins carry position and (for KiCad-imported symbols) the KiCad electrical
type: passive | input | output | bidirectional | tri_state | power_in |
power_out | open_collector | open_emitter | no_connect | free | unspecified.

Electrical type alone is not enough. Surveying KiCad 10's shipped libraries,
a regulator's FB pin is declared `input` on some parts and `passive` on
others - 231 pins named FB across Regulator_Switching alone, split across both
types. So a role is (name pattern) first, (electrical type) second.

Roles are what motif patterns constrain on: an `fb_divider` is only a feedback
divider if the IC pin its mid-tap drives is actually a feedback/sense input.
Structurally it is otherwise identical to a sense divider into an ADC.
"""
from __future__ import annotations

import re

# -- role table -------------------------------------------------------------
# Ordered: first match wins, so put specific patterns before generic ones.
_NAME_ROLES: list[tuple[str, str]] = [
    (r"^(vfb|fb|feedback)\d*$", "feedback"),
    (r"^(v?sense|isense|cs|csense)\d*$", "sense"),
    (r"^(comp|compensation)$", "compensation"),
    (r"^(adj|trim)$", "feedback"),
    (r"^(en|enable|shdn|shutdown|nshdn|ce)\d*$", "enable"),
    (r"^(rst|reset|nrst|nreset|mr|por)\d*$", "reset"),
    (r"^(x?in|xtal1|osc_?in|xi)$", "clock_in"),
    (r"^(x?out|xtal2|osc_?out|xo)$", "clock_out"),
    (r"^(clk|sclk|xck|clkin|clkout)\d*$", "clock"),
    (r"^(sda|scl|sdi|sdo|miso|mosi|cs|ss|tx|rx|d[+-])\d*$", "io"),
    (r"^(sw|lx|phase|switch)\d*$", "switch_node"),
    (r"^(boot|bst|bootstrap)\d*$", "bootstrap"),
    (r"^(vin|vcc|vdd|vbus|vbat|avdd|avcc|vddio)\d*$", "power_in"),
    (r"^(vout|vo)\d*$", "power_out"),
    (r"^(gnd|vss|agnd|dgnd|pgnd|epad|pad|thermal)\d*$", "ground"),
    (r"^(nc|no_?connect)\d*$", "no_connect"),
]
_NAME_ROLES_C = [(re.compile(p, re.I), r) for p, r in _NAME_ROLES]

# Fallback when the name says nothing useful (e.g. "~", "1", "PA0").
_ETYPE_ROLES = {
    "power_in": "power_in",
    "power_out": "power_out",
    "input": "input",
    "output": "output",
    "bidirectional": "io",
    "tri_state": "io",
    "open_collector": "output",
    "open_emitter": "output",
    "no_connect": "no_connect",
    "passive": "passive",
    "free": "passive",
    "unspecified": "unknown",
}

# Roles that mean "this pin is a control/measurement input the circuit feeds"
FEEDBACK_ROLES = frozenset({"feedback", "sense", "compensation"})


def pin_role(pin: dict | None, pin_name: str | None = None) -> str:
    """Infer a role from a JAC pin dict (or a bare pin name).

    `pin` is JAC's per-pin dict: {"x":..,"y":..,"name":..,"etype":..}.
    Name patterns win over electrical type (see module docstring).
    """
    name = ""
    etype = ""
    if isinstance(pin, dict):
        name = str(pin.get("name") or "")
        etype = str(pin.get("etype") or "").lower()
    if pin_name:
        name = pin_name
    n = name.strip().strip("~").replace("/", "").replace("#", "")
    for rx, role in _NAME_ROLES_C:
        if rx.match(n):
            return role
    return _ETYPE_ROLES.get(etype, "unknown")


def component_pin_roles(comp_def: dict) -> dict:
    """{pin_number: role} for a component library definition."""
    return {num: pin_role(p) for num, p in (comp_def.get("pins") or {}).items()}


def net_pin_roles(session: dict, net_name: str, lib_of) -> list:
    """Roles of every pin attached to a net.

    `lib_of` is pcb_tools._lib_of (comp_type -> definition), injected so this
    module stays import-clean and testable on its own.
    Returns [{"comp_id", "ref", "pin", "role"}, ...].
    """
    by_id = {c["id"]: c for c in session.get("components", [])}
    out = []
    for m in (session.get("nets") or {}).get(net_name, []):
        comp = by_id.get(m.get("comp_id"))
        if not comp:
            continue
        pins = (lib_of(comp.get("type")) or {}).get("pins") or {}
        pin_key = m.get("pin")
        out.append({
            "comp_id": comp["id"],
            "ref": comp.get("ref", ""),
            "pin": pin_key,
            "role": pin_role(pins.get(pin_key), pin_name=pin_key),
        })
    return out


def net_has_role(session: dict, net_name: str, roles, lib_of) -> bool:
    """True if any pin on this net has one of `roles`."""
    want = {roles} if isinstance(roles, str) else set(roles)
    return any(p["role"] in want for p in net_pin_roles(session, net_name, lib_of))
