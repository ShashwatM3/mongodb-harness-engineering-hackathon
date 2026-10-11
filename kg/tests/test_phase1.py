"""Phase 1: the evidence trunk. Done when three fake rounds produce v2 and v3, load_brain(1, ...) still
returns v1 exactly, a re-proposal is `cached` with `re_proposed`, a locked edit is not refused, and
Raindrop gets events with gate signals."""
from __future__ import annotations

import threading

import pytest

from kg.core import KGError, PermissionDenied, StalePromotion
from kg.hashing import Env, effective_edits

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"


def stair(kg, V):
    return effective_edits(kg.export_brain(V))[STAIR]["value"]


def test_three_rounds_make_v2_and_v3_and_v1_still_replays(gate, improver, play, sink):
    v1_before = gate.load_brain(1, "task:M:PICK")
    export_before = gate.export_brain(1).model_dump(mode="json")
    r1 = play(improver, gate, 1, {STAIR: 5}, round_=1)
    assert r1["promoted"]["version"] == 2
    r2 = play(improver, gate, 2, {STAIR: 3}, round_=2)
    assert r2["promoted"]["version"] == 3
    r3 = play(improver, gate, 3, {STAIR: 2}, round_=3)
    assert r3["promoted"]["version"] == 4
    assert [stair(gate, v) for v in (1, 2, 3, 4)] == [99, 5, 3, 2]
    # exact replay: the runner gets the identical v1 brain, component for component
    assert gate.export_brain(1).model_dump(mode="json") == export_before
    same = lambda lb: [(c["_id"], c["compiles_to"]) for c in lb["components"]]
    assert same(gate.load_brain(1, "task:M:PICK")) == same(v1_before)
    m = [r["result"]["zones"]["M"] for r in (r1, r2, r3)]
    assert all(z["delta"] > 0 and z["seeds_worse"] == 0 for z in m)
    v3 = gate.db.brain_versions.find_one({"_id": "v3"})
    assert v3["parent"] == "v2" and v3["retired"] == ["rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v2"]
    assert v3["scores"]["train"]["M"] == m[1]["cand"]
    assert sink.signal_names().count("gate_passed") == 3


def test_base_shifts_are_reused_from_the_candidate_run(gate, improver, play, runner):
    play(improver, gate, 1, {STAIR: 3})
    calls = len(runner.calls)
    p = improver.record_proposal(2, {STAIR: 2}, origin="gepa", round=2, policy="p1")
    assert not p.need_base and p.need_cand  # v2's shifts exist from when it was the candidate
    improver.evaluate(p)
    assert len(runner.calls) == calls + 1


def test_same_proposal_twice_is_one_gate_run_cached_and_re_proposed(gate, improver, sink):
    p1 = improver.record_proposal(1, {STAIR: 3}, origin="gepa", round=1, policy="p1")
    improver.evaluate(p1)
    p2 = improver.record_proposal(1, f'{{"{STAIR}": 3}}', origin="gepa", round=2, policy="p1")
    assert p2.gate_run_id == p1.gate_run_id and p2.status == "cached" and p2.repeat
    assert p2.cached_result["zones"]["M"]["delta"] > 0
    assert gate.db.gate_runs.count_documents({}) == 1
    assert sink.signal_names() == ["re_proposed"]
    assert [e for e, _ in sink.events] == [p1.event_id, p2.event_id]
    # the gate's decision goes to the original proposal only
    gate.record_verdict(p1.gate_run_id, "passed")
    assert sink.signals[-1] == (p1.event_id, "gate_passed")
    assert sink.signal_names().count("gate_passed") == 1
    # a retry of the very same call (same round and policy) records nothing new
    p3 = improver.record_proposal(1, {STAIR: 3}, origin="gepa", round=2, policy="p1")
    assert p3.event_id == p2.event_id and len(sink.events) == 2


def test_another_policy_arm_is_not_a_repeat(gate, improver, sink):
    p1 = improver.record_proposal(1, {STAIR: 3}, round=1, policy="p1")
    improver.evaluate(p1)
    gate.record_verdict(p1.gate_run_id, "passed")
    p2 = improver.record_proposal(1, {STAIR: 3}, round=1, policy="p2")
    assert p2.status == "cached" and not p2.repeat
    assert "re_proposed" not in sink.signal_names()
    assert (p2.event_id, "gate_passed") in sink.signals  # each arm gets the gate's decision once


def test_parallel_repeats_signal_exactly_once_each(gate, improver, sink):
    p = improver.record_proposal(1, {STAIR: 3}, round=0, policy="p1")
    improver.evaluate(p)
    threads = [threading.Thread(target=improver.record_proposal, args=(1, {STAIR: 3}),
                                kwargs={"round": r, "policy": "p1"}) for r in range(1, 9)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sink.signal_names().count("re_proposed") == 8
    run = gate.db.gate_runs.find_one({"_id": p.gate_run_id})
    assert len(run["events"]) == 9 and run["events"][0]["event_id"] == p.event_id


def test_locked_edit_is_not_refused(gate, improver):
    p = improver.record_proposal(1, {"class.HUM-1.max_speed": 1.35}, origin="gepa", round=1, policy="p1")
    assert p.status == "new" and p.allow_locked
    assert [e["target"] for e in p.locked_edits] == ["class.HUM-1.max_speed"]
    res = improver.evaluate(p)
    assert res["verdict"] == "evaluated"
    gate.record_verdict(p.gate_run_id, "needs_approval", reason="locked: max_speed 1.35")
    assert gate.db.gate_runs.find_one({"_id": p.gate_run_id})["verdict"] == "needs_approval"


@pytest.mark.parametrize("candidate,why", [
    ({STAIR: 150}, "out of range"),
    ({"sim.HUMAN_CLEARANCE_M": 1.5}, "fixed setting"),
    ({"sim.STAIR_CAPACITY": 4}, "spec setting"),
    ({"sim.NOT_A_SETTING": 1}, "unknown setting"),
    ({STAIR: 99}, "no-op"),
    ("this is not json", "unparseable"),
    ({STAIR: "two"}, "unparseable"),
])
def test_refused_candidates_are_invalid(gate, improver, sink, candidate, why):
    p = improver.record_proposal(1, candidate, origin="gepa", round=1, policy="p1")
    assert p.status == "invalid" and why in p.reason and p.brain is None
    assert sink.signal_names() == ["invalid_proposal"]
    again = improver.record_proposal(1, candidate, origin="gepa", round=2, policy="p1")
    assert again.status == "invalid" and again.gate_run_id == p.gate_run_id
    assert sorted(sink.signal_names()) == ["invalid_proposal", "invalid_proposal", "re_proposed"]


def test_candidate_formats_agree(gate, improver):
    b = gate.export_brain(1)
    for n in b.nodes:
        if n.body is not None and getattr(n.body, "target", None) == STAIR:
            n.body.value = 2
    forms = [{STAIR: 2}, [{"op": "set", "target": STAIR, "value": 2}], {"edits": [{"target": STAIR, "value": 2.0}]},
             f'[{{"target": "{STAIR}", "value": 2}}]', b.model_dump(mode="json")]
    ids = {improver.record_proposal(1, f, round=i, policy="p1").gate_run_id for i, f in enumerate(forms)}
    assert len(ids) == 1


def test_stale_promotion_is_refused(gate, improver):
    a = improver.record_proposal(1, {STAIR: 3}, round=1, policy="p1")
    b = improver.record_proposal(1, {STAIR: 2}, round=1, policy="p1")
    improver.evaluate(a), improver.evaluate(b)
    gate.record_verdict(a.gate_run_id, "passed"), gate.record_verdict(b.gate_run_id, "passed")
    gate.promote(a.gate_run_id)
    with pytest.raises(StalePromotion):
        gate.promote(b.gate_run_id)
    assert gate.promote(a.gate_run_id)["already"]  # promoting twice is a no-op


def test_improver_cannot_decide(gate, improver):
    p = improver.record_proposal(1, {STAIR: 3}, round=1, policy="p1")
    improver.evaluate(p)
    with pytest.raises(PermissionDenied):
        improver.promote(p.gate_run_id)
    with pytest.raises(PermissionDenied):
        improver.record_verdict(p.gate_run_id, "passed")


def test_heldout_split_never_enters(gate, improver, runner):
    with pytest.raises(KGError):
        improver.record_proposal(1, {STAIR: 3}, split="heldout")
    resp = runner.run_shift(gate.export_brain(1), list(range(101, 113)))
    with pytest.raises(KGError):
        improver.record_shifts(resp, "heldout", brain=gate.export_brain(1))
    gate.db.heldout_seeds.insert_one({"_id": "locked-a", "seeds": [105]})
    with pytest.raises(KGError, match="held-out test seeds"):
        gate.record_shifts(resp, "train", brain=gate.export_brain(1))


def test_env_key_changes_with_epoch_or_spec_hash(gate, runner):
    base = dict(engine_sha="abc1234", spec_id="warehouse-humanoid", ticks=12000, profile="standard")
    keys = {Env(**base, spec_hash_or_epoch=t).key for t in ("epoch:e1", "epoch:e2", "spec:9f2c", "spec:9f2d")}
    assert len(keys) == 4
    e1 = gate.use_runner(runner, env_epoch="e1").key
    e2 = gate.use_runner(runner, env_epoch="e2").key
    assert e1 != e2

    class SpecHashHealth:
        def health(self):
            from kg.contract import HealthResponse
            return HealthResponse(ok=True, engine_sha="abc1234-dirty", spec_id="warehouse-humanoid", mode="real",
                                  spec_hash="9f2c")
        validate_brain = settings = lambda self, *a: None

    env = gate.use_runner(SpecHashHealth())
    assert env.spec_hash_or_epoch == "spec:9f2c" and env.engine_sha.endswith("-dirty")


def test_results_from_another_env_are_refused(gate, improver, runner):
    p = improver.record_proposal(1, {STAIR: 3}, round=1, policy="p1")
    resp = runner.run_shift(p.brain, p.seeds)
    resp.engine_sha = "abc1234"
    from kg.core import EnvMismatch
    with pytest.raises(EnvMismatch):
        improver.record_shifts(resp, "train", gate_run_id=p.gate_run_id)


def test_raindrop_event_properties(gate, improver, play, sink):
    play(improver, gate, 1, {STAIR: 3})
    eid, props = sink.events[0]
    for k in ("brain_version", "base_patch_hash", "cand_patch_hash", "lever_groups", "time_state", "origin",
              "policy", "split", "zone_M_score"):
        assert k in props, k
    assert props["brain_version"] == 1 and props["lever_groups"] == "floor_change"
    assert props["time_state"] == "lift_wait" and props["engine"] == "fake"
    assert all(isinstance(v, (str, int, float, bool)) for v in props.values())


def test_context_orders_floor_change_first_and_skips_tested_values(gate, improver, play):
    p = improver.record_proposal(1, {STAIR: 2}, round=1, policy="p1")
    improver.evaluate(p)
    improver.record_proposal(1, {STAIR: 400}, round=1, policy="p1")  # invalid, still "tested"
    ctx = improver.get_context(1)
    d = ctx["data"]
    assert d["A"]["worst_zone"] == "M"
    order = [o["group"] for o in d["C"]["lever_group_order"]]
    assert order[0] == "floor_change" and "lift_wait" in d["C"]["lever_group_order"][0]["why"]
    row = next(r for r in d["C"]["settings"] if r["target"] == STAIR)
    assert row["tested"] == [2, 400] and 2 not in row["untested"] and row["current"] == 99
    assert d["C"]["settings"][0]["lever_group"] == "floor_change"
    locked = [r for r in d["C"]["settings"] if r["needs_call"]]
    assert locked and d["C"]["settings"][-len(locked):] == locked  # editable first, then locked
    assert "floor_change" in d["B"] and len(d["B"]["floor_change"]) == 2
    md = ctx["markdown"]
    assert "### A." in md and "### B." in md and "### C." in md and "locked: needs a call" in md


def test_ablation_reverts_to_the_replaced_value(gate, improver, play):
    play(improver, gate, 1, {STAIR: 3})
    play(improver, gate, 2, {STAIR: 2})
    ab = gate.ablate(3, "rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v3")
    assert effective_edits(ab)[STAIR]["value"] == 3
    assert gate.validate(ab).warnings == []
