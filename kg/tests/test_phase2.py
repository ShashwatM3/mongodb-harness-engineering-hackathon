"""Phase 2: humans, explanations and the firewall. Done when explain() on a promoted rule returns the clip
timestamp, at least one episode and the gate run; a locked edit goes from needs_approval through approval
to promotion; and the improver user gets "unauthorized" on heldout_results."""
from __future__ import annotations

import json

import pytest
from pymongo.errors import OperationFailure

from kg.core import NeedsApproval
from kg.db import probe_heldout_denied
from kg.hashing import effective_edits

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"
SPEED = "class.HUM-1.max_speed"
HABIT = "habit:skip-lift-when-queued"


def add_habit(gate):
    return gate.add_habit(HABIT, "When three people already wait for the lift, take the stairs",
                          clip={"uri": "gs://clips/lift-queue.mp4", "t0": 7.0, "t1": 12.5},
                          steps=["sees the lift queue", "turns to the stairwell"], lever_group="c:lever/floor_change")


def test_explain_a_promoted_rule_walks_habit_clip_episodes_gate_run(gate, improver, play):
    add_habit(gate)
    out = play(improver, gate, 1, {STAIR: 2}, origin={"source": "habit", "ref": HABIT})
    gid = out["proposal"].gate_run_id
    gate.record_heldout(gid, "heldout-a", True, {"M": 0.21})
    ex = improver.explain("rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v2")
    assert ex["habit"]["clip"]["t0"] == 7.0
    assert len(ex["episodes"]) >= 1 and all(e["type"] == "LIFT_QUEUE_JAM" for e in ex["episodes"])
    assert ex["gate_run"]["gate_run_id"] == gid and ex["gate_run"]["zones"]["M"]["delta"] > 0
    assert ex["heldout_passed"] is True
    ev = ex["component"]["evidence"]
    assert ev["habit_id"] == HABIT and ev["signal"] == "LIFT_QUEUE_JAM" and ev["observed_at"] == "zone:M"
    assert "7-12.5 s" in ex["markdown"] and "LIFT_QUEUE_JAM" in ex["markdown"]
    habit = gate.db.playbook.find_one({"_id": HABIT})
    assert habit["helpful"] == 1 and habit["harmful"] == 0


def test_explain_a_baseline_component(improver):
    ex = improver.explain("rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1")
    assert ex["habit"] is None and ex["gate_run"] is None and "Baseline" in ex["markdown"]


def test_rejected_habit_counts_as_harmful(gate, improver, play):
    add_habit(gate)
    play(improver, gate, 1, {STAIR: 0}, origin={"source": "habit", "ref": HABIT}, verdict="rejected")
    assert gate.db.playbook.find_one({"_id": HABIT})["harmful"] == 1


def test_locked_edit_from_needs_approval_through_approval_to_promotion(gate, improver, sink):
    p = improver.record_proposal(1, {SPEED: 1.35}, origin="gepa", round=1, policy="p1")
    improver.evaluate(p)
    gate.record_verdict(p.gate_run_id, "needs_approval", reason="locked: max_speed 1.35")
    with pytest.raises(NeedsApproval):
        gate.promote(p.gate_run_id)
    r = gate.record_approval(SPEED, 1.35, "approve", by="Robotics Lead", ref="call:el-001")
    assert r["ready_to_promote"] == [p.gate_run_id]
    out = gate.promote(p.gate_run_id, "walk at 90% of top speed")
    assert out["version"] == 2 and out["added"] == ["guardrail:class.HUM-1.max_speed@site:main:v2"]
    assert out["approvals"][0]["approved_by"] == "Robotics Lead"
    b2 = gate.export_brain(2)
    assert effective_edits(b2)[SPEED]["value"] == 1.35
    assert [(a.target, a.value, a.ref) for a in b2.approvals] == [(SPEED, 1.35, "call:el-001")]
    assert gate.validate(b2).locked_edits == []
    assert gate.db.brain_versions.find_one({"_id": "v2"})["approvals"][0]["value"] == 1.35
    env = gate.db.envelope.find_one({"_id": SPEED})
    assert env["approved_value"] == 1.35 and env["approvals"][-1]["ref"] == "call:el-001"
    assert sink.signal_names() == ["gate_passed"]


def test_declined_call_rejects_the_run(gate, improver):
    p = improver.record_proposal(1, {SPEED: 1.5}, origin="gepa", round=1, policy="p1")
    improver.evaluate(p)
    gate.record_verdict(p.gate_run_id, "needs_approval")
    r = gate.record_approval(SPEED, 1.5, "reject", by="Robotics Lead", ref="call:el-002")
    assert r["rejected"] == [p.gate_run_id]
    run = gate.db.gate_runs.find_one({"_id": p.gate_run_id})
    assert run["verdict"] == "rejected" and "declined by Robotics Lead" in run["reason"]


def test_approvals_only_for_locked_settings_within_bounds(gate):
    from kg.core import KGError
    with pytest.raises(KGError):
        gate.record_approval(STAIR, 2, "approve", by="x")
    with pytest.raises(KGError):
        gate.record_approval(SPEED, 2.5, "approve", by="x")


def test_improver_is_unauthorized_on_heldout(gate, improver):
    gate.db.heldout_results.insert_one({"_id": "probe", "passed": True})
    gate.db.heldout_stress.insert_one({"_id": "probe", "kind": "scenario"})
    assert probe_heldout_denied(improver.db) is None
    for coll in ("heldout_results", "heldout_seeds", "heldout_stress"):
        with pytest.raises(OperationFailure) as e:
            improver.db[coll].find_one({})
        assert e.value.code == 13
        with pytest.raises(OperationFailure):
            improver.db[coll].insert_one({"x": 1})
    assert probe_heldout_denied(gate.db) is not None  # the gate can read it
    from kg.core import PermissionDenied
    with pytest.raises(PermissionDenied):
        improver.record_heldout("gr-x", "a", True, {})


def test_improver_cannot_remove_or_rewrite_history(gate, improver):
    with pytest.raises(OperationFailure):
        improver.db.brain_nodes.delete_one({"_id": "site:main"})
    with pytest.raises(OperationFailure):
        improver.db.brain_versions.insert_one({"_id": "v99"})
    with pytest.raises(OperationFailure):
        improver.db.envelope.update_one({"_id": SPEED}, {"$set": {"max": 9}})
    with pytest.raises(OperationFailure):
        improver.db.gate_runs.delete_many({})


def test_get_context_never_contains_a_heldout_seed_or_score(gate, improver, play):
    add_habit(gate)
    out = play(improver, gate, 1, {STAIR: 3}, origin={"source": "habit", "ref": HABIT})
    gid = out["proposal"].gate_run_id
    secret_seeds = [3141592653, 2718281828]
    gate.db.heldout_seeds.insert_one({"_id": "heldout-a", "seeds": secret_seeds})
    gate.record_heldout(gid, "heldout-a", True, {"M": 0.123457, "A": -0.010101})
    texts = []
    for V in (1, 2):
        ctx = improver.get_context(V)
        texts += [ctx["markdown"], json.dumps(ctx["data"], default=str)]
        texts.append(json.dumps(improver.suggest(V), default=str))
        texts.append(json.dumps(improver.graph_snapshot(V), default=str))
        texts.append(json.dumps(improver.lineage(V), default=str))
    texts.append(json.dumps(improver.explain("rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v2"), default=str))
    blob = "\n".join(texts)
    for secret in [*map(str, secret_seeds), "0.123457", "0.010101", "heldout-a"]:
        assert secret not in blob, secret
    # only the boolean reaches brain_versions
    assert gate.db.brain_versions.find_one({"_id": "v2"})["heldout_passed"] is True


def test_heldout_recorded_before_promotion_reaches_the_version(gate, improver):
    p = improver.record_proposal(1, {STAIR: 3}, round=1, policy="p1")
    improver.evaluate(p)
    gate.record_heldout(p.gate_run_id, "heldout-a", False, {"M": -0.02})
    gate.record_verdict(p.gate_run_id, "passed")
    gate.promote(p.gate_run_id)
    assert gate.db.brain_versions.find_one({"_id": "v2"})["heldout_passed"] is False


def test_final_result_is_stored_on_the_version(gate, improver, play):
    play(improver, gate, 1, {STAIR: 3})
    f = gate.record_final(2, True, {"M": 0.2})
    assert gate.db.brain_versions.find_one({"_id": "v2"})["final"]["vs"] == "v1" and f["passed"]


def test_lineage_and_graph_snapshot(gate, improver, play):
    add_habit(gate)
    play(improver, gate, 1, {STAIR: 3}, origin={"source": "habit", "ref": HABIT})
    play(improver, gate, 2, {STAIR: 2})
    lin = improver.lineage(3)
    assert [c["version"] for c in lin["chain"]] == [1, 2, 3]
    assert lin["chain"][1]["habit"]["_id"] == HABIT and lin["chain"][2]["edits"][0]["value"] == 2
    assert lin["markdown"].startswith("v1: baseline → v2:")
    snap = improver.graph_snapshot(3, compare_to=1)
    by_status = {}
    for n in snap["nodes"]:
        by_status.setdefault(n["status"], []).append(n["id"])
    assert by_status["added"] == ["rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v3"]
    assert by_status["retired"] == ["rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1"]
    assert len(by_status["skeleton"]) == 26
    ids = {n["id"] for n in snap["nodes"]}
    assert all(l["source"] in ids and l["target"] in ids for l in snap["links"])
    assert any(l["kind"] == "evidence" for l in snap["links"])


def test_suggest_top_three_and_passed_not_promoted(gate, improver):
    s0 = improver.suggest(1)
    assert len(s0["candidates"]) == 3
    assert (s0["candidates"][0]["target"], s0["candidates"][0]["value"]) == (STAIR, 2)
    p = improver.record_proposal(1, {STAIR: 2}, round=1, policy="p1")
    improver.evaluate(p)
    gate.record_verdict(p.gate_run_id, "passed")
    s1 = improver.suggest(1)
    assert s1["candidates"][0]["target"] == STAIR and s1["candidates"][0]["value"] == 3
    assert [r["gate_run_id"] for r in s1["passed_not_promoted"]] == [p.gate_run_id]
    assert not any(c["needs_call"] for c in s1["candidates"])


def test_capped_failures_are_flagged(gate, improver, runner):
    b = gate.export_brain(1)
    resp = runner.run_shift(b, list(range(101, 113)))
    r0 = resp.per_seed[0]
    from kg.contract import FailureEntry
    r0.failures = r0.failures + [FailureEntry(type="LATE_TASK", zone="M", tick=1000 + i, robots=["R01"], detail="late")
                                 for i in range(25)]
    r0.failure_counts["LATE_TASK"] = 40
    out = improver.record_shifts(resp, "train", brain=b)
    eps = list(gate.db.episodes.find({"shift_id": out["shift_ids"][0], "type": "LATE_TASK"}))
    assert len(eps) == 25 and all(e["capped"] for e in eps)
    jams = list(gate.db.episodes.find({"shift_id": out["shift_ids"][0], "type": "LIFT_QUEUE_JAM"}))
    assert jams and not any(e["capped"] for e in jams)
    ctx = improver.get_context(1)
    assert ctx["data"]["A"]["failures_by_zone"]["LATE_TASK"]["capped"] is True
    assert ctx["data"]["A"]["failures"]["LATE_TASK"] == 40
