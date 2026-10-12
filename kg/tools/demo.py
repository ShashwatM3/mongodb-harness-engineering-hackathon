"""The KG's presentable story on the fake runner: three rounds, a habit with a clip, a repeat, an invalid
proposal, and a locked edit that goes through the phone approval to promotion.

    python -m kg demo --uri mongodb://...            # one URI for both roles (local), database kg_demo
    python -m kg demo --raindrop                     # also send events to Raindrop (RAINDROP_WRITE_KEY)

The gate here is a stand-in (Person B owns the real one): pass when some zone improves and no zone
gets worse on any seed; a locked edit that passes goes to needs_approval.
"""
from __future__ import annotations

from typing import Optional

from ..core import KG
from ..raindrop_sink import RecordingSink

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"
HABIT = "habit:stairs-when-lift-queued"


def toy_gate(gate: KG, gid: str) -> str:
    run = gate.c("gate_runs").find_one({"_id": gid})
    zones = run["zones"]
    better = any(v["delta"] > 0 for v in zones.values())
    worse = any(v["seeds_worse"] > 0 or v["delta"] < 0 for v in zones.values())
    locked = bool(run.get("locked_edits"))
    if worse or not (better or locked):
        verdict = "rejected"
    else:
        verdict = "needs_approval" if locked else "passed"
    gate.record_verdict(gid, verdict, reason="toy gate: " + ("a zone got worse" if worse else
                                                            "no zone improved" if not (better or locked) else "ok"))
    return verdict


def run_demo(gate: KG, improver: KG, say=print, sink: Optional[RecordingSink] = None) -> dict:
    out: dict = {}
    say("Seeding the brain (skeleton, concepts, envelope, v1 components)...")
    say(f"  {gate.seed()['inserted']}")
    gate.add_habit(HABIT, "When three people already wait for the lift, walk to the stairs",
                   clip={"uri": "clips/lift-queue.mp4", "t0": 7.0, "t1": 12.5},
                   steps=["sees the lift queue", "turns to the west stairwell"],
                   lever_group="c:lever/floor_change", applies_to=["zone:M"])

    attempts = iter(range(10_000))

    def propose(V, cand, rnd, origin="gepa"):
        p = improver.record_proposal(V, cand, origin=origin, round=rnd, policy="demo", attempt=next(attempts))
        res = improver.evaluate(p)
        m = (res.get("zones") or {}).get("M")
        edits = ", ".join(f"{e['target']} {e['base_value']}→{e['value']}" for e in p.edits) or str(cand)
        tail = f"zone M {m['base']:.3f}→{m['cand']:.3f} ({m['delta']:+.3f})" if m else p.reason
        say(f"  [{p.status}{', repeat' if p.repeat else ''}] {edits}: {tail}")
        return p

    say("\nRound 1, from the human clip: take the stairs when 3+ robots queue")
    p = propose(1, {STAIR: 3}, 1, origin={"source": "habit", "ref": HABIT})
    say(f"  gate: {toy_gate(gate, p.gate_run_id)}; promote → v{gate.promote(p.gate_run_id, 'stairs at queue 3')['version']}")

    say("\nRound 2, the improver's top suggestions on v2")
    sug = improver.suggest(2)
    for c in sug["candidates"]:
        say(f"  suggest {c['target']}={c['value']} ({c['why']})")
    ps = [propose(2, {c["target"]: c["value"]}, 2) for c in sug["candidates"]]
    verdicts = {q.gate_run_id: toy_gate(gate, q.gate_run_id) for q in ps if q.status != "invalid"}
    best = max((q for q in ps if verdicts.get(q.gate_run_id) == "passed"),
               key=lambda q: gate.c("gate_runs").find_one({"_id": q.gate_run_id})["zones"]["M"]["delta"], default=None)
    if best:
        say(f"  promote → v{gate.promote(best.gate_run_id, 'stairs at queue 2')['version']}")
    say("  the improver proposes one of them again, and something out of range:")
    propose(2, {ps[0].edits[0]["target"]: ps[0].edits[0]["value"]}, 2)
    propose(2, {STAIR: 400}, 2)

    V = gate.latest_version()
    say(f"\nRound 3, a locked setting on v{V}: walk at 1.35 m/s (v1 is 1.2, the robot can do 1.5)")
    p = propose(V, {"class.HUM-1.max_speed": 1.35}, 3)
    say(f"  locked edits: {[e['target'] for e in p.locked_edits]} → simulated with allow_locked, not refused")
    say(f"  gate: {toy_gate(gate, p.gate_run_id)}")
    if gate.phone.enabled:
        call = gate.c("phone_calls").find_one({"gate_run_id": p.gate_run_id, "kind": "approval"}) or {}
        say(f"  phone call placed ({call.get('_id')}, {call.get('status')}): the Robotics Lead decides on the call")
    else:
        r = gate.record_approval("class.HUM-1.max_speed", 1.35, "approve", by="Robotics Lead", ref="call:demo")
        say(f"  phone call: approved → ready to promote {r['ready_to_promote']}")
        v = gate.promote(p.gate_run_id, "walk at 90% of top speed")
        say(f"  promote → v{v['version']} with approvals {[(a['target'], a['value']) for a in v['approvals']]}")

    V = gate.latest_version()
    say("\nLineage: " + improver.lineage(V)["markdown"])
    rule = gate.c("brain_nodes").find_one({"key": STAIR, "since": 2})["_id"]
    say("\nExplain " + rule + ":\n" + improver.explain(rule)["markdown"])
    snap = improver.graph_snapshot(V, compare_to=1)
    say(f"\nv1 → v{V}: " + ", ".join(f"{n['id']} ({n['status']})" for n in snap["nodes"]
                                     if n["status"] in ("added", "retired")))
    say("\nget_brain_context(task:M:PICK), the supervisor's read:")
    for c in improver.get_brain_context("task:M:PICK")["components"]:
        if c["since"] > 1:
            say(f"  {c['kind']} {c['key']}: when {c['when']}, then {c['then']}")
    if sink is not None:
        names = sink.signal_names()
        say(f"\nRaindrop: {len(sink.events)} events; " + ", ".join(f"{n} {names.count(n)}" for n in sorted(set(names))))
    out.update(version=V, snapshot=snap["counts"])
    return out
