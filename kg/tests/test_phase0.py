"""Phase 0: the brain lives in Atlas. Done when export_brain(1) validates and runs through
fakeRunShift, load_brain(1, "task:M:PICK") returns all v1 components, and seed() twice changes nothing."""
from __future__ import annotations

import pytest

from kg.contract import Brain
from kg.hashing import effective_edits
from kg.ontology import SKELETON_ZONES, TASK_TYPES
from kg.registry import SETTINGS
from kg.runner import FixtureRunner, RunnerError, TsxFakeRunner

V1_SETTINGS = [s for s in SETTINGS if s.gets_v1_component]


def test_seed_writes_skeleton_concepts_envelope_and_v1(gate):
    db = gate.db
    assert db.brain_nodes.count_documents({"kind": {"$in": ["site", "zone", "task"]}}) == 1 + 5 + 20 == 26
    assert {d["zone"] for d in db.brain_nodes.find({"kind": "zone"})} == set(SKELETON_ZONES)
    assert db.brain_nodes.count_documents({"kind": "task"}) == len(SKELETON_ZONES) * len(TASK_TYPES)
    assert 40 <= db.concepts.count_documents({}) <= 60
    assert db.envelope.count_documents({}) == len(SETTINGS)
    v1 = db.brain_versions.find_one({"_id": "v1"})
    assert v1["version"] == 1 and v1["parent"] is None and len(v1["added"]) == len(V1_SETTINGS)
    # one baseline component per setting, all at site:main, since 1
    comps = list(db.brain_nodes.find({"kind": {"$in": ["rule", "guardrail"]}}))
    assert len(comps) == len(V1_SETTINGS)
    assert all(c["parent_id"] == "site:main" and c["since"] == 1 and c["until"] is None for c in comps)
    assert all(c["key"] == c["compiles_to"]["target"] for c in comps)
    assert db.brain_nodes.find_one({"_id": "rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1"})["compiles_to"]["value"] == 99
    assert db.brain_nodes.find_one({"_id": "guardrail:class.HUM-1.max_speed@site:main:v1"})["compiles_to"]["value"] == 1.2


def test_seed_twice_changes_nothing(gate):
    before = {n: list(gate.db[n].find({}, sort=[("_id", 1)])) for n in
              ("brain_nodes", "concepts", "envelope", "brain_versions")}
    report = gate.seed()
    assert report["inserted"] == {} and report["updated"] == {} and report["warnings"] == []
    after = {n: list(gate.db[n].find({}, sort=[("_id", 1)])) for n in before}
    assert before == after


def test_load_brain_returns_all_v1_components_for_a_task(gate):
    lb = gate.load_brain(1, "task:M:PICK")
    assert lb["scope"] == ["task:M:PICK", "zone:M", "site:main"]
    assert {c["key"] for c in lb["components"]} == {s.target for s in V1_SETTINGS}
    assert lb["shadowed"] == []


def test_load_brain_deeper_node_wins(gate):
    gate.db.brain_nodes.insert_one({
        "_id": "rule:sim.STAIR_MIN_LIFT_QUEUE@zone:M:v1", "kind": "rule", "parent_id": "zone:M",
        "key": "sim.STAIR_MIN_LIFT_QUEUE", "compiles_to": {"op": "set", "target": "sim.STAIR_MIN_LIFT_QUEUE", "value": 2},
        "since": 1, "until": None, "evidence": {}})
    lb = gate.load_brain(1, "task:M:PICK")
    win = next(c for c in lb["components"] if c["key"] == "sim.STAIR_MIN_LIFT_QUEUE")
    assert win["parent_id"] == "zone:M" and win["compiles_to"]["value"] == 2
    assert [s["_id"] for s in lb["shadowed"]] == ["rule:sim.STAIR_MIN_LIFT_QUEUE@site:main:v1"]
    # zone B is not on the path from task:B:PICK, so the site rule applies there
    lb_b = gate.load_brain(1, "task:B:PICK")
    assert next(c for c in lb_b["components"] if c["key"] == "sim.STAIR_MIN_LIFT_QUEUE")["compiles_to"]["value"] == 99


def test_export_brain_v1_is_a_valid_contract_brain(gate):
    b = gate.export_brain(1)
    Brain.model_validate(b.model_dump(mode="json"))
    assert len(b.nodes) == 26 + len(V1_SETTINGS)
    eff = effective_edits(b)
    assert eff["sim.STAIR_MIN_LIFT_QUEUE"]["value"] == 99
    assert eff["class.HUM-1.max_speed"]["value"] == 1.2
    assert b.approvals == []
    v = gate.validate(b)
    assert v.rejected == [] and v.locked_edits == [] and v.warnings == []


def test_omitting_a_setting_is_caught(gate):
    """The baseline bug: a brain without the v1 components runs 'always stairs' and gets a 422."""
    b = gate.export_brain(1)
    b.nodes = [n for n in b.nodes if n.level not in ("rule", "guardrail")]
    v = gate._local_validation(b)
    assert any("sim.STAIR_MIN_LIFT_QUEUE omitted" in w for w in v.warnings)
    assert [e["target"] for e in v.locked_edits] == ["class.HUM-1.max_speed"]


def test_export_brain_v1_runs_through_fake_run_shift(gate):
    try:
        fake = TsxFakeRunner()
    except RunnerError as e:
        pytest.skip(str(e))
    b = gate.export_brain(1)
    resp = fake.run_shift(b, [101, 102, 103])
    assert resp.brain_version == 1 and resp.patch_hash == "fake-q99"
    assert set(resp.mean.zones) == {"A", "B", "C", "D", "M"}
    # the saved fixtures still match TwinForge's fake runner for this brain
    fixture = FixtureRunner().run_shift(b, list(range(101, 113)))
    live = fake.run_shift(b, list(range(101, 113)))
    assert live.model_dump(mode="json") == fixture.model_dump(mode="json")


def test_v1_patch_hash_matches_brains_v1_json(gate, tmp_path):
    """Section 7's first test: without it every trial runs the wrong fleet or gets a 422. Runs TwinForge's
    own compiler (WP-B) through tsx, so it needs the physical-ai checkout with brains/v1.json."""
    from kg.runner import default_twinforge_dir
    from kg.tools.checks import check_v1
    v1 = default_twinforge_dir() / "brains" / "v1.json"
    if not v1.exists() or not (default_twinforge_dir() / "src" / "harness" / "brain.ts").exists():
        pytest.skip("needs physical-ai with brains/v1.json and src/harness/brain.ts (WP-B)")
    r = check_v1(gate, None, v1)
    assert r["ok"], r
    assert r["kg_patch_hash"] == r["v1_json_patch_hash"] == r["kg_local_patch_hash"]
    assert r["diffs"] == []
