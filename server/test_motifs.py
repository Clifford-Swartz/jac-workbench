"""Exercise the motif matcher on a realistic JAC session (buck + MCU board)."""
from motifs import recognize, coverage, splat, build_circuit_graph, MOTIFS
from pin_roles import pin_role, net_pin_roles

# Pin metadata as the KiCad importer now delivers it: name + electrical type.
# U1 is a buck controller (real FB pin); U2 is an MCU whose IO34 is a plain
# ADC input. Structurally their dividers are identical - only roles differ.
LIB = {
    "ic_generic": {"pins": {
        "VIN": {"x": -30, "y": 0, "name": "VIN", "etype": "power_in"},
        "SW": {"x": 30, "y": 0, "name": "SW", "etype": "output"},
        "FB": {"x": 30, "y": 10, "name": "FB", "etype": "input"},
        "BOOT": {"x": 30, "y": -10, "name": "BOOT", "etype": "passive"},
        "GND": {"x": 0, "y": 20, "name": "GND", "etype": "power_in"},
        "1": {"x": -20, "y": 0, "name": "1", "etype": "passive"},
        "2": {"x": 20, "y": 0, "name": "2", "etype": "passive"},
    }},
    "esp32": {"pins": {
        "VDD": {"x": -30, "y": 0, "name": "VDD", "etype": "power_in"},
        "GND": {"x": 0, "y": 20, "name": "GND", "etype": "power_in"},
        "IO21": {"x": 30, "y": 0, "name": "IO21", "etype": "bidirectional"},
        "IO22": {"x": 30, "y": 5, "name": "IO22", "etype": "bidirectional"},
        "IO34": {"x": 30, "y": 10, "name": "IO34", "etype": "input"},
        "IO15": {"x": 30, "y": 15, "name": "IO15", "etype": "bidirectional"},
        "IO16": {"x": 30, "y": 20, "name": "IO16", "etype": "bidirectional"},
        "EN": {"x": -30, "y": 10, "name": "EN", "etype": "input"},
    }},
}
_PASSIVE2 = {"1": {"name": "1", "etype": "passive"}, "2": {"name": "2", "etype": "passive"}}
for _t in ("resistor", "capacitor", "inductor", "led"):
    LIB[_t] = {"pins": _PASSIVE2}


def lib_of(comp_type):
    return LIB.get(comp_type, {})

# A board with: buck converter (fb divider, LC output, boot/bypass caps),
# an MCU with decoupling + crystal + I2C pull-ups + a status LED,
# and two DELIBERATE TRAPS for the matcher:
#   - R90/R91: two resistors in series whose midpoint ALSO drives U2 -> the
#     mid-tap has external fan-out, so it must NOT match voltage_divider.
#   - R92: a lone resistor between two signal nets -> matches nothing.
COMPS = [
    ("c1", "ic_generic", "U1"), ("c2", "esp32", "U2"),
    ("c3", "inductor", "L1"), ("c4", "capacitor", "C1"), ("c5", "capacitor", "C2"),
    ("c6", "resistor", "R1"), ("c7", "resistor", "R2"),
    ("c8", "capacitor", "C3"), ("c9", "capacitor", "C4"), ("c10", "capacitor", "C5"),
    ("c11", "resistor", "R3"), ("c12", "resistor", "R4"),
    ("c13", "led", "D1"), ("c14", "resistor", "R5"),
    ("c15", "capacitor", "C6"), ("c16", "capacitor", "C7"), ("c17", "ic_generic", "Y1"),
    ("c18", "resistor", "R6"), ("c19", "capacitor", "C8"),
    ("c20", "resistor", "R90"), ("c21", "resistor", "R91"), ("c22", "resistor", "R92"),
]
components = [{"id": i, "type": t, "ref": r, "x": 0, "y": 0, "properties": {}}
              for i, t, r in COMPS]
# Y1 is a crystal: JAC has no crystal type yet, so refdes prefix drives the kind.

NETS = {
    "VIN":  [("c1", "VIN"), ("c4", "1")],
    "SW":   [("c1", "SW"), ("c3", "1")],
    "3V3":  [("c3", "2"), ("c5", "1"), ("c6", "1"),
             ("c2", "VDD"), ("c8", "1"), ("c9", "1"), ("c10", "1"),
             ("c11", "1"), ("c12", "1"), ("c14", "1"), ("c20", "1")],
    "FB":   [("c6", "2"), ("c7", "1"), ("c1", "FB")],
    "BOOT": [("c19", "1"), ("c1", "BOOT")],
    "SDA":  [("c11", "2"), ("c2", "IO21")],
    "SCL":  [("c12", "2"), ("c2", "IO22")],
    "LEDA": [("c14", "2"), ("c13", "1")],
    "XIN":  [("c17", "1"), ("c15", "1"), ("c2", "IO15")],
    "XOUT": [("c17", "2"), ("c16", "1"), ("c2", "IO16")],
    "RSTN": [("c18", "2"), ("c2", "EN")],
    "MIDX": [("c20", "2"), ("c21", "1"), ("c2", "IO34")],   # TRAP: external fan-out
    "SIGA": [("c22", "1")],
    "SIGB": [("c22", "2")],                                  # TRAP: matches nothing
    "GND":  [("c1", "GND"), ("c2", "GND"), ("c4", "2"), ("c5", "2"), ("c7", "2"),
             ("c8", "2"), ("c9", "2"), ("c10", "2"), ("c13", "2"),
             ("c15", "2"), ("c16", "2"), ("c19", "2"), ("c21", "2")],
}
session = {
    "components": components,
    "nets": {n: [{"comp_id": c, "pin": p} for c, p in members]
             for n, members in NETS.items()},
}
# R6 pull-up: 3V3 -> RSTN
session["nets"]["3V3"].append({"comp_id": "c18", "pin": "1"})

g = build_circuit_graph(session)
print(f"graph: {g.number_of_nodes()} nodes "
      f"({len(session['components'])} comps + {len(session['nets'])} nets), "
      f"{g.number_of_edges()} edges")
print(f"catalog: {len(MOTIFS)} motifs\n")

from motifs import make_role_oracle
oracle = make_role_oracle(session, lib_of=lib_of)
raw = recognize(session, arbitrate=False, role_of_net=oracle)
final = recognize(session, role_of_net=oracle)

print("pin roles on the two mid-taps:")
for net in ("FB", "MIDX"):
    roles = {p["ref"] + "." + str(p["pin"]): p["role"]
             for p in net_pin_roles(session, net, lib_of)}
    print(f"  {net:5s} -> {roles}")
print()
print(f"raw matches (before arbitration): {len(raw)}")
print(f"after greedy MIS arbitration:     {len(final)}\n")

for m in sorted(final, key=lambda x: (-x.specificity, x.motif)):
    nets = ", ".join(f"{k}={v}" for k, v in sorted(m.nets.items()))
    print(f"  {m.motif:16s} {str(sorted(m.refs.values())):32s}  [{nets}]")

cov = coverage(session, final)
print(f"\ncoverage: {cov['in_motifs']}/{cov['components']} components "
      f"({cov['pct_covered']}%) folded into {cov['metas']} metas")
print(f"placer optimises {cov['placer_nodes']} nodes instead of {cov['components']} "
      f"({round(100*(1-cov['placer_nodes']/cov['components']))}% fewer)")

# -- trap checks -----------------------------------------------------------
print("\ntrap checks:")
member_of = {}
for m in final:
    for lid, cid in m.members().items():
        member_of[m.refs[lid]] = m.motif


def refs_of(motif_name):
    return {tuple(sorted(m.refs[l] for l in m.members()))
            for m in final if m.motif == motif_name}


plain = refs_of("voltage_divider")
fb = refs_of("fb_divider")
checks = [
    # the closed-internal-net rule: a bare 2-degree mid-tap is required for
    # voltage_divider, so R90/R91 (mid also drives U2) must NOT match it
    ("R90/R91 rejected by plain voltage_divider", ("R90", "R91") not in plain),
    ("R1/R2 recognised as fb_divider", ("R1", "R2") in fb),
    ("R92 (floating) claimed by nothing", "R92" not in member_of),
    ("crystal_load found (Y1+C6+C7)", any(m.motif == "crystal_load" for m in final)),
    ("U1 anchored, not consumed by divider", "U1" not in member_of),
    ("every comp in <=1 motif (MIS holds)",
     sum(len(m.members()) for m in final) == cov["in_motifs"]),
    # the whole point of pin roles: same shape, different meaning
    ("R1/R2 -> fb_divider (U1.FB is a feedback pin)", ("R1", "R2") in fb),
    ("R90/R91 -> sense_divider (U2.IO34 is a plain input)",
     ("R90", "R91") in refs_of("sense_divider")),
    ("R90/R91 NOT fb_divider", ("R90", "R91") not in fb),
]
for label, ok in checks:
    print(f"  {label:44s} {'PASS' if ok else 'FAIL'}")

fb_only = refs_of("fb_divider")
print("\n  Pin roles disambiguate two structurally identical dividers:")
print(f"    fb_divider    {sorted(fb_only)}   (mid-tap -> regulator FB)")
print(f"    sense_divider {sorted(refs_of('sense_divider'))}   (mid-tap -> ADC input)")

# -- splat demo ------------------------------------------------------------
fb = next((m for m in final if m.motif == "voltage_divider"), None)
if fb:
    print(f"\nsplat {fb.motif} at (2000, 1500):")
    for cid, (x, y) in splat(fb, (2000, 1500)).items():
        ref = next(c["ref"] for c in components if c["id"] == cid)
        print(f"    {ref:4s} -> ({x}, {y})")
