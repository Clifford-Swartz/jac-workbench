"""Motif recognition for JAC schematics - canonical sub-circuit detection.

Prototype after salitronic/eda-agent (Apache-2.0), reimplemented against
JAC's own session format:

    session["components"] = [{id, type, ref, x, y, properties}, ...]
    session["nets"]       = {net_name: [{"comp_id", "pin"}, ...]}

Why: a force-directed / greedy placer produces an "emergent constellation".
Recognising canonical sub-circuits first lets the placer treat each match as
ONE meta-node with a frozen, human-looking internal layout, so it optimises
~5-15 metas instead of ~50-200 raw parts - and a divider *looks* like a
divider.

Method: bipartite VF2 subgraph isomorphism on a component<->net graph, with
two constraints that kill the false positives:

  1. CLOSED INTERNAL NETS - a pattern net flagged internal must map to a host
     net of the EXACT same degree. External fan-out kills the match. This is
     what stops every R-R pair matching `voltage_divider`: the mid-tap must
     touch only the two resistors.
  2. ROLE COHERENCE - power/ground pattern nets only map to host nets that
     JAC classifies as rails (same rules as pcb_tools.net_class_of).

Overlap arbitration: several motifs can claim one component (a divider's top
resistor also matches pull_up_r). Resolved as a greedy maximum independent
set ranked by specificity -> component count -> stable refdes order.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable

import networkx as nx
from networkx.algorithms.isomorphism import GraphMatcher

# -- net role classification ------------------------------------------------
_POWER_NETS = {"VCC", "VDD", "VDDA", "VSS", "VEE", "VBUS", "VBAT", "VIN", "VOUT",
               "AVCC", "AVDD", "3V3", "5V"}
_GROUND_NETS = {"GND", "AGND", "DGND", "PGND", "VSSA"}
_VOLT_RE = re.compile(r"^[+-]?\d+(\.\d+)?V\d*$")


def net_role(net_name: str) -> str:
    """Return 'ground' | 'power' | 'signal' for a net name."""
    n = (net_name or "").upper().lstrip("+")
    if n in _GROUND_NETS:
        return "ground"
    if n in _POWER_NETS or _VOLT_RE.match(n):
        return "power"
    return "signal"


# JAC component "type" -> coarse kind used for matching
_KIND_BY_TYPE = {
    "resistor": "R", "capacitor": "C", "cap_polar": "C", "inductor": "L",
    "led": "D", "diode": "D", "npn": "Q", "pnp": "Q",
    "ic_generic": "U", "555": "U", "esp32": "U",
    "connector_2pin": "J", "usb_c": "J",
    "vcc": "PWR", "gnd": "PWR", "3v3": "PWR",
}
_KIND_BY_PREFIX = {"FB": "L", "R": "R", "C": "C", "L": "L", "D": "D",
                   "Q": "Q", "U": "U", "J": "J", "Y": "Y", "X": "Y"}
# Catch-all JAC types that carry no real class information: the refdes the
# user assigned is more specific (a crystal placed as "ic_generic" but named
# Y1 is a crystal), so these fall through to the prefix table.
_GENERIC_TYPES = {"ic_generic", ""}


def comp_kind(comp: dict) -> str:
    """Coarse component class: refdes prefix wins over a catch-all type."""
    t = (comp.get("type") or "").lower()
    ref = (comp.get("ref") or "").upper()
    if t not in _GENERIC_TYPES and t in _KIND_BY_TYPE:
        return _KIND_BY_TYPE[t]
    for pfx in sorted(_KIND_BY_PREFIX, key=len, reverse=True):
        if ref.startswith(pfx):
            return _KIND_BY_PREFIX[pfx]
    return _KIND_BY_TYPE.get(t, "?")


# -- host graph -------------------------------------------------------------
def build_circuit_graph(session: dict) -> nx.Graph:
    """Bipartite component<->net graph from a JAC session dict."""
    g = nx.Graph()
    by_id = {c["id"]: c for c in session.get("components", [])}
    for cid, c in by_id.items():
        g.add_node(("comp", cid), bip="component", kind=comp_kind(c),
                   ref=c.get("ref", ""), ctype=c.get("type", ""))
    for net_name, members in (session.get("nets") or {}).items():
        g.add_node(("net", net_name), bip="net", role=net_role(net_name),
                   name=net_name)
        for m in members:
            cid = m.get("comp_id")
            if ("comp", cid) in g:
                g.add_edge(("comp", cid), ("net", net_name), pin=m.get("pin"))
    return g


def net_degree(g: nx.Graph, net_name: str) -> int:
    return g.degree(("net", net_name))


# -- motif definition -------------------------------------------------------
@dataclass
class Motif:
    name: str
    comps: dict                      # local id -> kind ('R', 'C', ...)
    nets: dict                       # local id -> role ('power'|'ground'|'signal'|'any')
    edges: list                      # [(comp local id, net local id), ...]
    internal_nets: tuple = ()        # must be degree-exact (closed)
    anchors: tuple = ()              # matched but NOT claimed (e.g. the IC a
                                     # divider feeds back to - it belongs to
                                     # itself, not to the divider)
    # {net local id: frozenset(roles)} - at least one pin on the mapped host
    # net must have one of these roles. Needs pin metadata; when a design has
    # none the check is skipped (see require_roles in find_matches).
    net_roles: dict = field(default_factory=dict)
    specificity: int = 1             # higher wins arbitration
    layout: dict = field(default_factory=dict)   # frozen relative placement, mils

    def pattern(self) -> nx.Graph:
        p = nx.Graph()
        for lid, kind in self.comps.items():
            p.add_node(("comp", lid), bip="component", kind=kind)
        for lid, role in self.nets.items():
            p.add_node(("net", lid), bip="net", role=role)
        for c, n in self.edges:
            p.add_edge(("comp", c), ("net", n))
        return p


# -- the catalog ------------------------------------------------------------
MOTIFS = [
    Motif(name="bypass_cap", specificity=2,
          comps={"C1": "C"}, nets={"PWR": "power", "GND": "ground"},
          edges=[("C1", "PWR"), ("C1", "GND")],
          layout={"C1": (0, 0)}),
    # A feedback divider's mid-tap legitimately touches the controller's FB
    # pin, so MID is degree-3 closed and the IC is an anchor, not a member.
    Motif(name="fb_divider", specificity=9,
          comps={"Rtop": "R", "Rbot": "R", "U": "U"},
          nets={"IN": "any", "MID": "signal", "GND": "ground"},
          edges=[("Rtop", "IN"), ("Rtop", "MID"), ("Rbot", "MID"),
                 ("Rbot", "GND"), ("U", "MID")],
          internal_nets=("MID",), anchors=("U",),
          net_roles={"MID": frozenset({"feedback", "sense", "compensation"})},
          layout={"Rtop": (0, 0), "Rbot": (0, -300)}),
    # Same shape, mid-tap drives a plain input (ADC / GPIO sense) rather than
    # a regulator feedback pin. Lower specificity so fb_divider wins the tie.
    Motif(name="sense_divider", specificity=7,
          comps={"Rtop": "R", "Rbot": "R", "U": "U"},
          nets={"IN": "any", "MID": "signal", "GND": "ground"},
          edges=[("Rtop", "IN"), ("Rtop", "MID"), ("Rbot", "MID"),
                 ("Rbot", "GND"), ("U", "MID")],
          internal_nets=("MID",), anchors=("U",),
          layout={"Rtop": (0, 0), "Rbot": (0, -300)}),
    Motif(name="voltage_divider", specificity=5,
          comps={"Rtop": "R", "Rbot": "R"},
          nets={"IN": "any", "MID": "signal", "GND": "ground"},
          edges=[("Rtop", "IN"), ("Rtop", "MID"), ("Rbot", "MID"), ("Rbot", "GND")],
          internal_nets=("MID",),
          layout={"Rtop": (0, 0), "Rbot": (0, -300)}),
    Motif(name="pull_up_r", specificity=3,
          comps={"R1": "R"}, nets={"PWR": "power", "SIG": "signal"},
          edges=[("R1", "PWR"), ("R1", "SIG")],
          layout={"R1": (0, 0)}),
    Motif(name="pull_down_r", specificity=3,
          comps={"R1": "R"}, nets={"SIG": "signal", "GND": "ground"},
          edges=[("R1", "SIG"), ("R1", "GND")],
          layout={"R1": (0, 0)}),
    Motif(name="rc_lowpass", specificity=6,
          comps={"R1": "R", "C1": "C"},
          nets={"IN": "any", "OUT": "signal", "GND": "ground"},
          edges=[("R1", "IN"), ("R1", "OUT"), ("C1", "OUT"), ("C1", "GND")],
          internal_nets=("OUT",),
          layout={"R1": (0, 0), "C1": (300, -200)}),
    Motif(name="lc_output", specificity=6,
          comps={"L1": "L", "C1": "C"},
          nets={"SW": "any", "OUT": "any", "GND": "ground"},
          edges=[("L1", "SW"), ("L1", "OUT"), ("C1", "OUT"), ("C1", "GND")],
          layout={"L1": (0, 0), "C1": (350, -200)}),
    Motif(name="crystal_load", specificity=7,
          comps={"Y1": "Y", "C1": "C", "C2": "C"},
          nets={"XIN": "signal", "XOUT": "signal", "GND": "ground"},
          edges=[("Y1", "XIN"), ("Y1", "XOUT"),
                 ("C1", "XIN"), ("C1", "GND"), ("C2", "XOUT"), ("C2", "GND")],
          layout={"Y1": (0, 0), "C1": (-250, -250), "C2": (250, -250)}),
    Motif(name="led_indicator", specificity=5,
          comps={"R1": "R", "D1": "D"},
          nets={"SRC": "any", "MID": "signal", "GND": "ground"},
          edges=[("R1", "SRC"), ("R1", "MID"), ("D1", "MID"), ("D1", "GND")],
          internal_nets=("MID",),
          layout={"R1": (0, 0), "D1": (0, -300)}),
    Motif(name="pi_filter", specificity=8,
          comps={"C1": "C", "L1": "L", "C2": "C"},
          nets={"IN": "any", "OUT": "any", "GND": "ground"},
          edges=[("C1", "IN"), ("C1", "GND"), ("L1", "IN"), ("L1", "OUT"),
                 ("C2", "OUT"), ("C2", "GND")],
          layout={"C1": (-300, -200), "L1": (0, 0), "C2": (300, -200)}),
]


# -- matching ---------------------------------------------------------------
def _node_match(host: dict, pat: dict) -> bool:
    if host.get("bip") != pat.get("bip"):
        return False
    if pat["bip"] == "component":
        return pat.get("kind") in ("?", host.get("kind"))
    want = pat.get("role", "any")
    return want == "any" or host.get("role") == want


@dataclass
class Match:
    motif: str
    specificity: int
    comps: dict      # local id -> JAC comp id (members + anchors)
    refs: dict       # local id -> refdes
    nets: dict       # local id -> host net name
    anchors: tuple = ()   # local ids that are context, not members

    def members(self) -> dict:
        """Local id -> comp id, excluding anchors."""
        return {k: v for k, v in self.comps.items() if k not in self.anchors}

    def claimed(self) -> set:
        """Comp ids this match consumes for arbitration (anchors excluded)."""
        return set(self.members().values())

    def __repr__(self) -> str:
        parts = ", ".join(f"{k}={v}" for k, v in sorted(self.refs.items())
                          if k not in self.anchors)
        return f"<{self.motif}: {parts}>"


def find_matches(g: nx.Graph, motif: Motif, by_id: dict, role_of_net=None) -> list:
    """`role_of_net(net_name) -> set(roles)`; None disables role checks."""
    pat = motif.pattern()
    gm = GraphMatcher(g, pat, node_match=_node_match)
    seen = set()
    out = []
    for mapping in gm.subgraph_monomorphisms_iter():
        inv = {v: k for k, v in mapping.items()}      # pattern node -> host node
        comps = {lid: inv[("comp", lid)][1] for lid in motif.comps}
        nets = {lid: inv[("net", lid)][1] for lid in motif.nets}
        # constraint 1: closed internal nets - degree must match exactly
        if any(net_degree(g, nets[lid]) != pat.degree(("net", lid))
               for lid in motif.internal_nets):
            continue
        # constraint 3: pin roles - skipped entirely when the design carries
        # no pin metadata, so role-free sessions behave exactly as before
        if role_of_net is not None and motif.net_roles:
            bad = False
            for lid, want in motif.net_roles.items():
                have = role_of_net(nets[lid])
                if have and not (have & set(want)):
                    bad = True
                    break
            if bad:
                continue
        # distinct components only (monomorphism can fold two locals onto one host)
        if len(set(comps.values())) != len(comps):
            continue
        # distinct nets too
        if len(set(nets.values())) != len(nets):
            continue
        key = frozenset(comps.values())
        if key in seen:
            continue
        seen.add(key)
        out.append(Match(motif=motif.name, specificity=motif.specificity, comps=comps,
                         refs={lid: by_id[cid].get("ref", cid) for lid, cid in comps.items()},
                         nets=nets, anchors=motif.anchors))
    return out


def resolve(matches: Iterable) -> list:
    """Greedy maximum independent set: specificity -> #comps -> stable order."""
    ranked = sorted(matches, key=lambda m: (-m.specificity, -len(m.members()),
                                            sorted(m.refs.values())))
    taken = set()
    keep = []
    for m in ranked:
        if m.claimed() & taken:
            continue
        taken |= m.claimed()
        keep.append(m)
    return keep


def make_role_oracle(session: dict, lib_of=None):
    """net name -> set of pin roles on it, or None if no pin metadata exists."""
    try:
        from pin_roles import net_pin_roles
    except ImportError:
        return None
    if lib_of is None:
        try:
            from pcb_tools import _lib_of as lib_of
        except ImportError:
            return None
    cache: dict = {}

    def role_of_net(net_name: str) -> set:
        if net_name not in cache:
            cache[net_name] = {p["role"] for p in
                               net_pin_roles(session, net_name, lib_of)}
        return cache[net_name]
    return role_of_net


def recognize(session: dict, arbitrate: bool = True, role_of_net="auto") -> list:
    """Detect canonical sub-circuits in a JAC session."""
    g = build_circuit_graph(session)
    by_id = {c["id"]: c for c in session.get("components", [])}
    if role_of_net == "auto":
        role_of_net = make_role_oracle(session)
    found = []
    for motif in MOTIFS:
        found.extend(find_matches(g, motif, by_id, role_of_net))
    return resolve(found) if arbitrate else found


def splat(match: Match, origin: tuple) -> dict:
    """Frozen relative layout -> absolute positions, keyed by JAC comp id."""
    motif = next(m for m in MOTIFS if m.name == match.motif)
    ox, oy = origin
    members = match.members()
    return {members[lid]: (ox + dx, oy + dy)
            for lid, (dx, dy) in motif.layout.items() if lid in members}


def coverage(session: dict, matches: list) -> dict:
    """How much the placer's job shrinks once motifs collapse to meta-nodes."""
    total = len(session.get("components", []))
    claimed = set().union(*[m.claimed() for m in matches]) if matches else set()
    return {"components": total, "in_motifs": len(claimed), "metas": len(matches),
            "placer_nodes": len(matches) + (total - len(claimed)),
            "pct_covered": round(100.0 * len(claimed) / total, 1) if total else 0.0}
