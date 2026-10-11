"""SCRATCHPADS/interface-contracts.md: get_brain_context and commit_brain_version, the supervisor's two brain
calls, plus the call agent's helpers from iteration 03 (save_preference, current scores, playbook)."""
from __future__ import annotations

import pytest
from pymongo.errors import OperationFailure

from kg.core import KGError, NeedsApproval, PermissionDenied, setting_component
from kg.registry import SETTINGS

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"


def test_get_brain_context_has_the_contract_shape(gate, improver):
    ctx = improver.get_brain_context("task:M:PICK")
    assert ctx["version"] == 1 and ctx["scope"] == ["task:M:PICK", "zone:M", "site:main"]
    assert len(ctx["components"]) == sum(s.gets_v1_component for s in SETTINGS)
    for c in ctx["components"]:
        assert {"kind", "key", "when", "then", "since", "until", "evidence"} <= set(c)
        assert c["when"] and c["then"]
    stair = next(c for c in ctx["components"] if c["key"] == STAIR)
    assert "lift" in stair["then"] and stair["compiles_to"]["value"] == 99
    # the read is logged for the dashboard's node light-up
    read = gate.db.brain_reads.find_one({"node_id": "task:M:PICK"})
    assert read["scope"] == ctx["scope"] and len(read["component_ids"]) == len(ctx["components"])


def test_commit_brain_version_refuses_an_ungated_setting_change(gate):
    add = [setting_component(STAIR, 2, "editable", {"source": "supervisor"})]
    with pytest.raises(KGError, match="needs evidence.gate_run_id"):
        gate.commit_brain_version(add, [], {"signal": "LIFT_QUEUE_JAM"})
    # a human override is explicit
    out = gate.commit_brain_version(add, [], {"origin": "manual"}, force=True)
    assert out["version"] == 2 and out["retired"] == ["rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1"]


def test_commit_brain_version_with_a_gate_run(gate, improver):
    p = improver.record_proposal(1, {STAIR: 2}, origin="gepa", round=1, policy="p1")
    improver.evaluate(p)
    gate.record_verdict(p.gate_run_id, "passed")
    with pytest.raises(KGError, match="not the edit"):
        gate.commit_brain_version([setting_component(STAIR, 3, "editable", {"source": "supervisor"})], [],
                                  {"gate_run_id": p.gate_run_id})
    out = gate.commit_brain_version(
        [setting_component(STAIR, 2, "editable", {"source": "supervisor"})],
        ["rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1"],
        {"habit_id": None, "episode_ids": [], "signal": "LIFT_QUEUE_JAM", "gate_run_id": p.gate_run_id})
    assert out["version"] == 2
    run = gate.db.gate_runs.find_one({"_id": p.gate_run_id})
    assert run["verdict"] == "promoted" and run["promoted_to"] == 2
    v2 = gate.db.brain_versions.find_one({"_id": "v2"})
    assert v2["promoted_by"] == p.gate_run_id and v2["scores"]["train"]["M"] > 0.7
    comp = gate.db.brain_nodes.find_one({"_id": out["added"][0]})
    assert comp["evidence"]["gate_run_id"] == p.gate_run_id and comp["when"] and comp["since"] == 2


def test_commit_brain_version_add_and_retire_free_components(gate):
    policy = {"kind": "context_policy", "parent_id": "task:M:PICK", "key": "lift_episodes",
              "when": "a robot is blocked at the lift lobby", "then": "show the last 3 lift episodes in zone M",
              "body": {"show": "episodes", "type": "LIFT_QUEUE_JAM", "zone": "M", "limit": 3}}
    out = gate.commit_brain_version([policy], [], {"origin": "manual"})
    assert out["added"] == ["context_policy:lift_episodes@task:M:PICK:v2"]
    on_m = gate.get_brain_context("task:M:PICK")
    assert any(c["key"] == "lift_episodes" for c in on_m["components"])
    assert not any(c["key"] == "lift_episodes" for c in gate.get_brain_context("task:B:PICK")["components"])
    out3 = gate.commit_brain_version([], ["context_policy:lift_episodes@task:M:PICK:v2"], {"origin": "manual"})
    assert out3["version"] == 3
    assert not any(c["key"] == "lift_episodes" for c in gate.get_brain_context("task:M:PICK")["components"])
    assert any(c["key"] == "lift_episodes" for c in gate.get_brain_context("task:M:PICK", version=2)["components"])
    with pytest.raises(KGError, match="not active"):
        gate.commit_brain_version([], ["context_policy:lift_episodes@task:M:PICK:v2"], {})
    with pytest.raises(ValueError):
        gate.commit_brain_version([{"kind": "wish", "key": "x"}], [], {})
    with pytest.raises(ValueError):
        gate.commit_brain_version([{"kind": "rule", "key": "x", "parent_id": "zone:Q"}], [], {})


def test_locked_commit_needs_an_approval(gate):
    add = [setting_component("class.HUM-1.max_speed", 1.35, "locked", {"source": "supervisor"})]
    with pytest.raises(NeedsApproval):
        gate.commit_brain_version(add, [], {}, force=True)


def test_only_the_gate_writes_the_brain(gate, improver):
    with pytest.raises(PermissionDenied):
        improver.commit_brain_version([], ["x"], {})
    with pytest.raises(PermissionDenied):
        improver.save_preference("slow down near the packing stations", by="lead")
    with pytest.raises(OperationFailure):
        improver.db.brain_nodes.insert_one({"_id": "rule:sneaky@site:main:v99", "kind": "rule", "since": 99})
    with pytest.raises(OperationFailure):
        improver.db.brain_nodes.update_one({"_id": "rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1"},
                                           {"$set": {"until": 2}})


def test_a_saved_preference_does_not_stale_pending_runs(gate, improver):
    p = improver.record_proposal(1, {STAIR: 2}, origin="gepa", round=1, policy="p1")
    improver.evaluate(p)
    gate.record_verdict(p.gate_run_id, "passed")
    pref = gate.save_preference("Never send a loaded robot up the stairs during the lunch rush", by="Robotics Lead",
                                ref="call:el-003")
    assert pref["version"] == 2
    ctx = improver.get_brain_context("task:M:PICK")
    pc = next(c for c in ctx["components"] if c["key"].startswith("preference:"))
    assert pc["then"].startswith("Never send") and pc["evidence"]["said_by"] == "Robotics Lead"
    # v2 runs exactly like v1, so the run measured on v1 is still promotable
    out = gate.promote(p.gate_run_id)
    assert out["version"] == 3
    keys = {c["key"] for c in gate.get_brain_context("task:M:PICK")["components"]}
    assert pc["key"] in keys and STAIR in keys


def test_current_scores_and_playbook(gate, improver):
    assert improver.current_scores()["zones"] == {}
    p = improver.record_proposal(1, {STAIR: 2}, round=1, policy="p1")
    improver.evaluate(p)
    s = improver.current_scores()
    assert s["worst_zone"] == "M" and set(s["zones"]) == {"A", "B", "C", "D", "M"} and s["source"] == "shifts"
    gate.add_habit("habit:stairs-when-queued", "Take the stairs when the lift queue is long",
                   applies_to=["zone:M"], helpful=0)
    gate.add_habit("habit:wait-beside-door", "Wait beside the doorway, not in it")
    gate.add_habit("habit:dock-b", "Stage totes by dock B", applies_to=["zone:B"])
    ids = [h["_id"] for h in improver.get_playbook("task:M:PICK")]
    assert set(ids) == {"habit:stairs-when-queued", "habit:wait-beside-door"}


def test_call_agent_helpers_work_without_a_runner(gate, improver, user_uris, sink):
    """The approval agent connects with with_runner=False: scores come from the promoted version."""
    from kg.core import KG
    from kg.db import connect as db_connect
    p = improver.record_proposal(1, {STAIR: 2}, round=1, policy="p1")
    improver.evaluate(p)
    gate.record_verdict(p.gate_run_id, "passed")
    gate.promote(p.gate_run_id)
    agent = KG(db_connect(user_uris["gate"], gate.db.name), "gate", sink=sink)  # no use_runner()
    s = agent.current_scores()
    assert s["source"] == "brain_versions" and s["version"] == 2 and s["zones"]["M"] > 0.7
    assert agent.get_brain_context("task:M:PICK")["version"] == 2
