"""End-to-end simulation on kg/tools/sim_runner.py, a synthetic twin with a known ground truth.

Three questions, each a group of tests:
  1. does the graph update correctly when the gate promotes?
  2. does it correct itself: refuse what hurts, catch stale and abandoned work, revert when the world moves?
  3. can people and agents get the information back out?

The gate policy here is tools.demo.toy_gate (pass when a zone improves and none gets worse on any seed).
"""
from __future__ import annotations

import datetime as dt
import threading

import pytest

from kg.core import KG, KGError, StalePromotion, setting_component
from kg.db import connect as db_connect
from kg.hashing import effective_edits
from kg.tools.demo import toy_gate
from kg.tools.sim_runner import SimRunner

from conftest import DB, reset

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"
BACKOFF = "sim.WAIT_BACKOFF_TICKS"
CHARGE = "sim.CHARGE_AT_PCT"
SPEED = "class.HUM-1.max_speed"
PARK = "sim.IDLE_TO_PARK_TICKS"
WDIST = "assign.W_DISTANCE"
HABIT = "habit:stairs-when-queued"


@pytest.fixture
def sim():
    return SimRunner()


@pytest.fixture
def sgate(user_uris, sink, sim):
    db = db_connect(user_uris["gate"], DB, app="kg-sim-gate")
    reset(db)
    g = KG(db, "gate", sink=sink)
    g.use_runner(sim)
    g.seed()
    return g


@pytest.fixture
def simp(user_uris, sgate, sink, sim):
    k = KG(db_connect(user_uris["improver"], DB, app="kg-sim-improver"), "improver", sink=sink)
    k.use_runner(sim)
    return k


def value(kg, V, target):
    e = effective_edits(kg.export_brain(V)).get(target)
    return e["value"] if e else None


def propose(imp, gate, V, cand, *, rnd=1, origin="gepa", attempt=None):
    p = imp.record_proposal(V, cand, origin=origin, round=rnd, policy="sim", attempt=attempt)
    res = imp.evaluate(p)
    verdict = toy_gate(gate, p.gate_run_id) if p.status != "invalid" else "invalid"
    return p, res, verdict


# ═══ 1. the graph updates ═════════════════════════════════════

def test_a_helpful_edit_becomes_a_new_version_with_evidence(sgate, simp, sink):
    p, res, verdict = propose(simp, sgate, 1, {STAIR: 3})
    assert verdict == "passed" and res["zones"]["M"]["delta"] > 0.2 and res["zones"]["M"]["seeds_worse"] == 0
    assert res["failures"]["LIFT_QUEUE_JAM"]["cand"] < res["failures"]["LIFT_QUEUE_JAM"]["base"]
    out = sgate.promote(p.gate_run_id, "stairs at queue 3")
    assert out["version"] == 2 and out["retired"] == [f"rule:{STAIR}@site:main:v1"]
    assert value(sgate, 1, STAIR) == 99 and value(sgate, 2, STAIR) == 3
    old = sgate.db.brain_nodes.find_one({"_id": f"rule:{STAIR}@site:main:v1"})
    new = sgate.db.brain_nodes.find_one({"_id": f"rule:{STAIR}@site:main:v2"})
    assert old["until"] == 2 and new["since"] == 2 and new["until"] is None
    assert new["evidence"]["gate_run_id"] == p.gate_run_id and new["evidence"]["signal"] == "LIFT_QUEUE_JAM"
    assert new["evidence"]["observed_at"] == "zone:M" and len(new["evidence"]["episode_ids"]) > 0
    v2 = sgate.db.brain_versions.find_one({"_id": "v2"})
    assert v2["status"] == "committed" and v2["parent"] == "v1" and v2["promoted_by"] == p.gate_run_id
    assert v2["scores"]["train"]["M"] == res["zones"]["M"]["cand"]
    ctx = simp.get_brain_context("task:M:PICK")
    stair = next(c for c in ctx["components"] if c["key"] == STAIR)
    assert stair["since"] == 2 and "3 or more" in stair["when"] and "stairs" in stair["then"]
    snap = simp.graph_snapshot(2)
    assert snap["counts"]["added"] == 1 and snap["counts"]["retired"] == 1
    assert sink.signal_names() == ["gate_passed"]


def test_a_two_setting_candidate_adds_two_components(sgate, simp):
    p, res, verdict = propose(simp, sgate, 1, {STAIR: 2, BACKOFF: 60})
    assert verdict == "passed" and sorted(e["target"] for e in p.edits) == sorted([BACKOFF, STAIR])
    out = sgate.promote(p.gate_run_id)
    assert sorted(out["added"]) == sorted([f"rule:{BACKOFF}@site:main:v2", f"rule:{STAIR}@site:main:v2"])
    assert out["retired"] == [f"rule:{STAIR}@site:main:v1"]  # BACKOFF had no v1 component (v1 == engine default)
    assert value(sgate, 2, STAIR) == 2 and value(sgate, 2, BACKOFF) == 60
    assert len(simp.lineage(2)["chain"][1]["edits"]) == 2


def test_a_zone_scoped_component_applies_to_its_zone_only(sgate, simp):
    policy = {"kind": "context_policy", "parent_id": "zone:M", "key": "lift_episodes",
              "when": "a robot is blocked in the lift lobby", "then": "show the last 3 LIFT_QUEUE_JAM episodes"}
    out = sgate.commit_brain_version([policy], [], {"origin": "manual"})
    assert out["version"] == 2
    for task in ("task:M:PICK", "task:M:RETURN"):
        assert any(c["key"] == "lift_episodes" for c in simp.get_brain_context(task)["components"])
    assert not any(c["key"] == "lift_episodes" for c in simp.get_brain_context("task:B:PICK")["components"])
    # a non-compiling component leaves the runner's brain identical: same patch hash, no runner call needed
    assert sgate.validate(sgate.export_brain(2)).patch_hash == sgate.validate(sgate.export_brain(1)).patch_hash


def test_a_deeper_rule_shadows_the_site_rule_and_can_still_be_changed(sgate, simp):
    """Doc 03: same key, deeper wins. The compiled patch is flat, so a zone-level rule sets the setting for
    the whole site; a later site-level candidate for the same setting must still be able to change it."""
    p, _, verdict = propose(simp, sgate, 1, {STAIR: 3})
    assert verdict == "passed"
    zone_rule = {"kind": "rule", "parent_id": "zone:M", "compiles_to": {"op": "set", "target": STAIR, "value": 3}}
    out = sgate.commit_brain_version([zone_rule], [], {"gate_run_id": p.gate_run_id})
    assert out["version"] == 2 and value(sgate, 2, STAIR) == 3
    lb = sgate.load_brain(2, "task:M:PICK")
    assert [c["_id"] for c in lb["shadowed"]] == [f"rule:{STAIR}@site:main:v1"]
    assert sgate.load_brain(2, "task:B:PICK")["shadowed"] == []
    # the next candidate changes the stair threshold again, at the site level
    q = simp.record_proposal(2, {STAIR: 2}, origin="gepa", round=2, policy="sim")
    assert q.status == "new", q.reason
    assert [(e["target"], e["base_value"], e["value"]) for e in q.edits] == [(STAIR, 3, 2)]


# ═══ 2. the graph corrects itself ═════════════════════════════

def test_a_harmful_edit_is_rejected_and_nothing_changes(sgate, simp, sink):
    before = sgate.export_brain(1).model_dump(mode="json")
    p, res, verdict = propose(simp, sgate, 1, {STAIR: 0})
    assert verdict == "rejected" and res["zones"]["M"]["delta"] < 0 and res["zones"]["M"]["seeds_worse"] > 0
    assert res["failures"]["STAIR_QUEUE"]["cand"] > res["failures"]["STAIR_QUEUE"]["base"]
    assert sgate.latest_version() == 1 and sgate.export_brain(1).model_dump(mode="json") == before
    with pytest.raises(KGError, match="rejected"):
        sgate.promote(p.gate_run_id)
    ctx = simp.get_context(1)
    row = ctx["data"]["B"]["floor_change"][0]
    assert row["verdict"] == "rejected" and row["zones"]["M"]["delta"] < 0
    assert "rejected" in ctx["markdown"] and "STAIR_QUEUE +" in ctx["markdown"]
    stair_row = next(r for r in ctx["data"]["C"]["settings"] if r["target"] == STAIR)
    assert stair_row["tested"] == [0] and 0 not in stair_row["untested"]
    assert sink.signal_names() == ["gate_failed"]


def test_an_edit_with_no_effect_shows_no_change(sgate, simp):
    p, res, verdict = propose(simp, sgate, 1, {PARK: 600})
    assert verdict == "rejected"
    assert all(v["delta"] == 0 and v["seeds_better"] == 0 and v["seeds_worse"] == 0 for v in res["zones"].values())
    assert res["failures"] and all(v["base"] == v["cand"] for v in res["failures"].values())
    assert "no zone changed" in simp.get_context(1)["markdown"]


def test_an_unknown_namespace_candidate_is_invalid_not_crashing(sgate, simp, sink):
    p = simp.record_proposal(1, {"robot.HUM-1.legs": 6}, origin="gepa", round=1, policy="sim")
    assert p.status == "invalid" and "unknown" in p.reason
    assert simp.evaluate(p)["verdict"] == "invalid"
    assert sink.signal_names() == ["invalid_proposal"]


def test_an_undecided_run_cannot_be_promoted(sgate, simp):
    p = simp.record_proposal(1, {STAIR: 3}, origin="gepa", round=1, policy="sim")
    assert simp.evaluate(p)["verdict"] == "evaluated"
    with pytest.raises(KGError, match="has not decided"):
        sgate.promote(p.gate_run_id)
    with pytest.raises(KGError, match="has not decided"):
        sgate.commit_brain_version([setting_component(STAIR, 3, "editable", {"source": "supervisor"})], [],
                                   {"gate_run_id": p.gate_run_id})
    assert sgate.latest_version() == 1
    sgate.record_verdict(p.gate_run_id, "passed")
    assert sgate.promote(p.gate_run_id)["version"] == 2


def test_zone_a_is_part_of_the_skeleton(sgate, simp):
    """The runner scores zone A on every shift; a fix seen there must have a node to attach to."""
    ctx = simp.get_brain_context("task:A:PICK")
    assert ctx["scope"] == ["task:A:PICK", "zone:A", "site:main"]
    # a human override sets a bad charge threshold; the sim strands robots in zone A below 30%
    sgate.commit_brain_version([setting_component(CHARGE, 25, "editable", {"source": "manual"})], [],
                               {"origin": "manual"}, force=True)
    p, res, verdict = propose(simp, sgate, 2, {CHARGE: 35})
    assert verdict == "passed" and res["failures"]["BATTERY_STRANDING"]["cand"] == 0
    sgate.promote(p.gate_run_id)
    ev = sgate.db.brain_nodes.find_one({"_id": f"rule:{CHARGE}@site:main:v3"})["evidence"]
    assert ev["signal"] == "BATTERY_STRANDING" and ev["observed_at"] == "zone:A"
    assert any(n["id"] == "zone:A" and n["kind"] == "zone" for n in simp.graph_snapshot(3)["nodes"])


def test_a_stale_run_is_refused_and_re_evaluation_reuses_shifts(sgate, simp, sim):
    a, _, va = propose(simp, sgate, 1, {STAIR: 3})
    b, _, vb = propose(simp, sgate, 1, {BACKOFF: 60})
    assert va == vb == "passed"
    sgate.promote(a.gate_run_id)
    with pytest.raises(StalePromotion):
        sgate.promote(b.gate_run_id)
    assert sgate.latest_version() == 2 and value(sgate, 2, BACKOFF) is None
    calls = len(sim.calls)
    b2 = simp.record_proposal(2, {BACKOFF: 60}, origin="gepa", round=2, policy="sim")
    assert b2.status == "new" and not b2.need_base and b2.need_cand  # v2's own shifts serve as the base
    simp.evaluate(b2)
    assert len(sim.calls) == calls + 1
    assert toy_gate(sgate, b2.gate_run_id) == "passed"
    assert sgate.promote(b2.gate_run_id)["version"] == 3
    assert value(sgate, 3, STAIR) == 3 and value(sgate, 3, BACKOFF) == 60


def test_the_world_changes_and_the_brain_reverts(sgate, simp, sim):
    """WP-T retunes the stairs: the spec_hash changes, nothing measured before counts, and the gate finds
    that v3's stair threshold now hurts. The revert is a normal gate run, built from ablate()."""
    p2, _, _ = propose(simp, sgate, 1, {STAIR: 3})
    sgate.promote(p2.gate_run_id, "stairs at queue 3")
    p3, _, v3 = propose(simp, sgate, 2, {STAIR: 2}, rnd=2)
    assert v3 == "passed"
    sgate.promote(p3.gate_run_id, "stairs at queue 2")
    assert value(sgate, 3, STAIR) == 2
    old_env = sgate.env.key
    pending, _, vp = propose(simp, sgate, 3, {WDIST: 0.5}, rnd=3)
    assert vp == "passed"  # passed in the old world, not promoted yet

    sim.retune("stairs_slow")
    new_env = sgate.use_runner(sim).key
    simp.use_runner(sim)
    assert new_env != old_env
    ctx = simp.get_context(3)
    assert ctx["data"]["A"] is None and "Not evaluated yet" in ctx["markdown"]
    assert ctx["data"]["B"] == {}  # old-world runs are not shown as evidence about this world
    # a run measured in the old world must not be promoted into the new one
    with pytest.raises(KGError, match="env"):
        sgate.promote(pending.gate_run_id)

    comp = sgate.db.brain_nodes.find_one({"key": STAIR, "since": 3})["_id"]
    reverted = sgate.ablate(3, comp)
    assert effective_edits(reverted)[STAIR]["value"] == 3
    r, res, vr = propose(simp, sgate, 3, reverted, rnd=4)
    assert [(e["target"], e["base_value"], e["value"]) for e in r.edits] == [(STAIR, 2, 3)]
    assert vr == "passed" and res["zones"]["M"]["delta"] > 0, res["zones"]["M"]
    out = sgate.promote(r.gate_run_id, "stairs are slower now: back to queue 3")
    assert out["version"] == 4 and out["retired"] == [comp]
    assert value(sgate, 4, STAIR) == 3 and value(sgate, 3, STAIR) == 2 and value(sgate, 2, STAIR) == 3
    lin = simp.lineage(4)
    assert [c["version"] for c in lin["chain"]] == [1, 2, 3, 4]
    assert lin["chain"][3]["edits"][0]["base_value"] == 2 and lin["chain"][3]["edits"][0]["value"] == 3
    # the two components that set 3 are distinct history, not one revived
    ids = [c["_id"] for c in sgate.db.brain_nodes.find({"key": STAIR}).sort("since", 1)]
    assert ids == [f"rule:{STAIR}@site:main:v{v}" for v in (1, 2, 3, 4)]


def test_heldout_failure_is_visible_everywhere(sgate, simp):
    p, _, _ = propose(simp, sgate, 1, {STAIR: 3})
    sgate.promote(p.gate_run_id)
    sgate.record_heldout(p.gate_run_id, "heldout-a", True, {"M": 0.2})
    sgate.record_heldout(p.gate_run_id, "heldout-b", False, {"M": -0.1})
    assert sgate.db.brain_versions.find_one({"_id": "v2"})["heldout_passed"] is False
    ex = simp.explain(f"rule:{STAIR}@site:main:v2")
    assert ex["heldout_passed"] is False and "Held-out: failed" in ex["markdown"]
    assert "held-out failed" in simp.lineage(2)["markdown"]
    assert "heldout" not in str(simp.get_context(2)["data"]).lower()  # no numbers leak, only the boolean
    with pytest.raises(Exception):
        simp.db.heldout_results.find_one({})


def test_an_abandoned_commit_is_rolled_back_not_fatal(sgate, simp):
    """A gate process dies between inserting the pending brain_versions row (the lock) and committing.
    The next commit must not fail forever with 'being created by another commit'."""
    p, _, _ = propose(simp, sgate, 1, {STAIR: 3})
    stale = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)
    sgate.db.brain_versions.insert_one({"_id": "v2", "version": 2, "parent": "v1", "status": "pending", "added": [],
                                        "retired": [], "hypothesis": "crashed", "created_at": stale})
    sgate.db.brain_nodes.insert_one({"_id": f"rule:{BACKOFF}@site:main:v2", "kind": "rule", "parent_id": "site:main",
                                     "key": BACKOFF, "since": 2, "until": None,
                                     "compiles_to": {"op": "set", "target": BACKOFF, "value": 60}})
    sgate.db.brain_nodes.update_one({"_id": f"rule:{STAIR}@site:main:v1"}, {"$set": {"until": 2}})
    assert sgate.latest_version() == 1
    out = sgate.promote(p.gate_run_id)
    assert out["version"] == 2
    assert value(sgate, 2, STAIR) == 3 and value(sgate, 2, BACKOFF) is None  # the orphan component is gone
    assert sgate.db.brain_versions.find_one({"_id": "v2"})["status"] == "committed"
    assert sgate.db.brain_nodes.find_one({"_id": f"rule:{STAIR}@site:main:v1"})["until"] == 2


def test_a_fresh_pending_commit_is_not_stolen(sgate, simp):
    p, _, _ = propose(simp, sgate, 1, {STAIR: 3})
    sgate.db.brain_versions.insert_one({"_id": "v2", "version": 2, "parent": "v1", "status": "pending", "added": [],
                                        "retired": [], "created_at": dt.datetime.now(dt.timezone.utc)})
    with pytest.raises(KGError, match="another commit"):
        sgate.promote(p.gate_run_id)


def test_two_passed_runs_only_one_lands_as_v2(sgate, simp):
    a, _, _ = propose(simp, sgate, 1, {STAIR: 3})
    b, _, _ = propose(simp, sgate, 1, {STAIR: 2})
    errors, done = [], []

    def go(gid):
        try:
            done.append(sgate.promote(gid)["version"])
        except KGError as e:
            errors.append(type(e).__name__)

    ts = [threading.Thread(target=go, args=(g,)) for g in (a.gate_run_id, b.gate_run_id)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert done == [2] and len(errors) == 1
    assert sgate.db.brain_versions.count_documents({"status": "pending"}) == 0
    assert sgate.db.brain_nodes.count_documents({"key": STAIR, "since": 2}) == 1


def test_a_nondeterministic_twin_is_reported(sgate, simp):
    flaky = SimRunner(nondeterministic=True)
    sgate.use_runner(flaky)
    simp.use_runner(flaky)
    b = sgate.export_brain(1)
    r1 = flaky.run_shift(b, [101, 102, 103])
    r2 = flaky.run_shift(b, [101, 102, 103])
    assert r1.per_seed[0].zones["M"].late != r2.per_seed[0].zones["M"].late
    out1 = simp.record_shifts(r1, "train", brain=b)
    out2 = simp.record_shifts(r2, "train", brain=b)
    assert out1["nondeterministic"] == [] and out2["nondeterministic"]
    stored = sgate.db.shifts.find_one({"_id": out1["shift_ids"][0]})["result"]
    assert stored["zones"]["M"]["late"] == r1.per_seed[0].zones["M"].late  # first result wins


def test_runner_refusal_marks_the_run_invalid(sgate, simp, sim):
    class Picky(SimRunner):
        def run_shift(self, brain, seeds, **kw):
            if effective_edits(brain).get(PARK):
                from kg.contract import BrainRejection
                from kg.runner import BrainRejected
                raise BrainRejected(BrainRejection(error="rejected", message="IDLE_TO_PARK_TICKS is not served"))
            return super().run_shift(brain, seeds, **kw)

    picky = Picky()
    sgate.use_runner(picky)
    simp.use_runner(picky)
    p = simp.record_proposal(1, {PARK: 600}, origin="gepa", round=1, policy="sim")
    res = simp.evaluate(p)
    assert res["verdict"] == "invalid" and "runner refused" in sgate.db.gate_runs.find_one({"_id": p.gate_run_id})["reason"]
    assert sgate.db.shifts.count_documents({}) == 12  # the base ran; the candidate never did


def test_locked_edit_goes_through_the_call_and_then_runs_unaided(sgate, simp, sim):
    p, res, verdict = propose(simp, sgate, 1, {SPEED: 1.35})
    assert p.allow_locked and verdict == "needs_approval" and res["zones"]["A"]["delta"] > 0
    assert sim.calls[-1]["eff"][SPEED] == 1.35
    r = sgate.record_approval(SPEED, 1.35, "approve", by="Robotics Lead", ref="call:sim-1")
    assert r["ready_to_promote"] == [p.gate_run_id]
    out = sgate.promote(p.gate_run_id)
    assert out["version"] == 2 and out["approvals"][0]["ref"] == "call:sim-1"
    b2 = sgate.export_brain(2)
    assert [(a.target, a.value) for a in b2.approvals] == [(SPEED, 1.35)]
    sim.run_shift(b2, [101])  # the runner accepts the approved brain with no allow_locked
    q = simp.record_proposal(2, {STAIR: 3}, origin="gepa", round=2, policy="sim")
    assert q.locked_edits == []  # the approved speed is no longer flagged
    too_fast = simp.record_proposal(2, {SPEED: 1.5}, origin="gepa", round=2, policy="sim")
    assert [e["target"] for e in too_fast.locked_edits] == [SPEED]


def test_values_rejected_on_earlier_versions_are_deprioritised(sgate, simp):
    p0, _, v0 = propose(simp, sgate, 1, {STAIR: 0})
    assert v0 == "rejected"
    p3, _, _ = propose(simp, sgate, 1, {STAIR: 3}, rnd=2)
    sgate.promote(p3.gate_run_id)
    row = next(r for r in simp.get_context(2)["data"]["C"]["settings"] if r["target"] == STAIR)
    assert row["tested"] == []  # nothing measured on v2 yet
    assert row["rejected_before"] == [0] and row["superseded"] == [99]
    assert row["untested"] and 0 not in row["untested"]  # still allowed, but no longer among the first to try
    assert "0 (rejected)" in simp.get_context(2)["markdown"]  # the improver still sees it was rejected before


def test_a_setting_with_no_effect_sinks_in_section_c(sgate, simp):
    propose(simp, sgate, 1, {PARK: 600})
    rows = simp.get_context(1)["data"]["C"]["settings"]
    park = next(r for r in rows if r["target"] == PARK)
    assert park["inert"] and park["no_effect"] == [600]
    editable = [r for r in rows if not r["needs_call"]]
    assert editable.index(park) == len(editable) - 1
    assert "no effect so far" in simp.get_context(1)["markdown"]
    assert PARK not in [c["target"] for c in simp.suggest(1)["candidates"]]


def test_suggest_spreads_proposals_over_lever_groups(sgate, simp):
    groups = [c["lever_group"] for c in simp.suggest(1)["candidates"]]
    assert len(groups) == 3 and len(set(groups)) == 3 and groups[0] == "floor_change"
    assert not any(c["needs_call"] for c in simp.suggest(1, k=5)["candidates"][:4])


# ═══ 3. information comes back out ════════════════════════════

def test_the_improver_converges_toward_the_known_optimum(sgate, simp, sim):
    """Eight rounds driven only by suggest() and the toy gate. Zone M must never get worse across promoted
    versions, and the stair threshold must end at the world's optimum (2)."""
    sgate.add_habit(HABIT, "When three people already wait for the lift, walk to the stairs",
                    clip={"uri": "clips/lift.mp4", "t0": 7.0, "t1": 12.5}, lever_group="c:lever/floor_change",
                    applies_to=["zone:M"])
    attempts = iter(range(10_000))
    scores, promoted = [], []
    for rnd in range(1, 9):
        V = sgate.latest_version()
        sug = simp.suggest(V)
        results = []
        for c in sug["candidates"]:
            origin = {"source": "habit", "ref": HABIT} if c["target"] == STAIR else "gepa"
            p, res, verdict = propose(simp, sgate, V, {c["target"]: c["value"]}, rnd=rnd, origin=origin,
                                      attempt=next(attempts))
            if verdict == "passed":
                results.append((res["zones"]["M"]["delta"], p))
        if not results:
            continue
        best = max(results, key=lambda x: x[0])[1]
        out = sgate.promote(best.gate_run_id, f"round {rnd}")
        promoted.append(out["version"])
        scores.append(sgate.current_scores()["zones"]["M"])
    assert len(promoted) >= 3, promoted
    assert scores == sorted(scores), scores
    assert value(sgate, sgate.latest_version(), STAIR) == 2
    habit = sgate.db.playbook.find_one({"_id": HABIT})
    assert habit["helpful"] >= 1
    from kg import learn
    preq = learn.prequential(sgate)
    assert preq["summary"]["promotions"] == len(promoted)
    # every promoted component explains itself
    for v in promoted:
        for cid in sgate.db.brain_versions.find_one({"version": v})["added"]:
            ex = simp.explain(cid)
            assert ex["gate_run"]["verdict"] == "promoted" and ex["component"]["evidence"]["gate_run_id"]


def test_context_markdown_tells_the_whole_story(sgate, simp):
    propose(simp, sgate, 1, {STAIR: 0})
    p, _, _ = propose(simp, sgate, 1, {STAIR: 3}, rnd=2)
    propose(simp, sgate, 1, {BACKOFF: 60}, rnd=2)
    md = simp.get_context(1)["markdown"]
    assert "### A. The current brain" in md and "| M (worst) |" in md
    assert "lift_wait" in md and "LIFT_QUEUE_JAM" in md
    assert "### B. Already evaluated on this brain (3 candidates)" in md
    assert "sim.STAIR_MIN_LIFT_QUEUE 99→0" in md and "rejected" in md
    assert "sim.STAIR_MIN_LIFT_QUEUE 99→3" in md and "passed" in md
    assert "### C. Untested settings" in md and "floor_change (zone M: lift_wait" in md
    sug = simp.suggest(1)
    assert [r["gate_run_id"] for r in sug["passed_not_promoted"]] and sug["candidates"]
    assert all(c["value"] not in (0, 3) for c in sug["candidates"] if c["target"] == STAIR)


def test_evidence_names_the_cause_and_the_zone_where_it_was_fixed(sgate, simp):
    synthetic = {"_id": "gr-x", "failures": {"LATE_TASK": {"base": 100, "cand": 10}, "LIFT_QUEUE_JAM": {"base": 20, "cand": 5}},
                 "shift_ids": {"base": [], "cand": []}, "zones": {"M": {"delta": 0.1}}, "origin": {"source": "gepa"}}
    assert sgate._evidence_for(synthetic)["signal"] == "LIFT_QUEUE_JAM"  # 15 jams fixed beat 90 late tasks
    p, res, _ = propose(simp, sgate, 1, {STAIR: 3})
    sgate.promote(p.gate_run_id)
    ev = sgate.db.brain_nodes.find_one({"_id": f"rule:{STAIR}@site:main:v2"})["evidence"]
    assert ev["signal"] == "LIFT_QUEUE_JAM"  # the cause, not the late tasks it produced
    ex = simp.explain(f"rule:{STAIR}@site:main:v2")
    assert all(e["zone"] == "M" for e in ex["episodes"]) and "zone:M" in ex["markdown"]
    # a fix that only shows up as late tasks in B and D is placed there, with examples from there
    q, _, _ = propose(simp, sgate, 2, {WDIST: 0.5}, rnd=2)
    sgate.promote(q.gate_run_id)
    ev = sgate.db.brain_nodes.find_one({"_id": f"rule:{WDIST}@site:main:v3"})["evidence"]
    assert ev["signal"] == "LATE_TASK" and ev["observed_at"] in ("zone:B", "zone:D")
    ex = simp.explain(f"rule:{WDIST}@site:main:v3")
    assert {e["zone"] for e in ex["episodes"][:3]} <= {"B", "D"}


def test_a_setting_has_a_history(sgate, simp):
    p, _, _ = propose(simp, sgate, 1, {STAIR: 3})
    sgate.promote(p.gate_run_id, "queue 3")
    sgate.save_preference("Never send a loaded robot up the stairs at lunch", by="Robotics Lead", ref="call:x")
    q, _, _ = propose(simp, sgate, 3, {STAIR: 2}, rnd=2)
    sgate.promote(q.gate_run_id, "queue 2")
    h = simp.history(STAIR)
    assert [(r["version"], r["value"]) for r in h["versions"]] == [(1, 99), (2, 3), (3, 3), (4, 2)]
    changes = h["changes"]
    assert [(c["version"], c["from"], c["to"]) for c in changes] == [(2, 99, 3), (4, 3, 2)]
    assert changes[0]["gate_run_id"] == p.gate_run_id and changes[0]["hypothesis"] == "queue 3"
    assert changes[1]["component_id"] == f"rule:{STAIR}@site:main:v4"
    assert "99→3" in h["markdown"] and "3→2" in h["markdown"]
    assert simp.history(BACKOFF)["changes"] == []  # never changed: v1 == engine default, no component


def test_explain_lineage_and_snapshot_agree(sgate, simp):
    sgate.add_habit(HABIT, "take the stairs when the lift is queued", clip={"uri": "c.mp4", "t0": 1, "t1": 2})
    p, _, _ = propose(simp, sgate, 1, {STAIR: 3}, origin={"source": "habit", "ref": HABIT})
    sgate.promote(p.gate_run_id)
    q, _, _ = propose(simp, sgate, 2, {BACKOFF: 60}, rnd=2)
    sgate.promote(q.gate_run_id)
    V = sgate.latest_version()
    lin, snap = simp.lineage(V), simp.graph_snapshot(V, compare_to=1)
    ids = {n["id"] for n in snap["nodes"]}
    assert all(l["source"] in ids and l["target"] in ids for l in snap["links"])
    added = {n["id"] for n in snap["nodes"] if n["status"] == "added"}
    assert added == set(lin["chain"][1]["added"]) | set(lin["chain"][2]["added"])
    assert {n["id"] for n in snap["nodes"] if n["status"] == "retired"} == set(lin["chain"][1]["retired"])
    assert {n["kind"] for n in snap["nodes"] if n["status"] == "evidence"} == {"gate_run", "habit"}
    ex = simp.explain(lin["chain"][1]["added"][0])
    assert ex["habit"]["_id"] == HABIT and ex["gate_run"]["gate_run_id"] == p.gate_run_id
    assert ex["episodes"] and all(e["type"] == "LIFT_QUEUE_JAM" for e in ex["episodes"])
    assert lin["chain"][1]["habit"]["_id"] == HABIT and lin["markdown"].count(" → ") == 2
    reads = list(sgate.db.brain_reads.find({}))
    assert reads == []  # views never count as a brain read; only get_brain_context does
    simp.get_brain_context("task:M:PICK", reader="supervisor")
    assert sgate.db.brain_reads.find_one({})["reader"] == "supervisor"


def test_old_versions_replay_exactly_after_many_changes(sgate, simp):
    exports = {1: sgate.export_brain(1).model_dump(mode="json")}
    for rnd, cand in enumerate(({STAIR: 3}, {BACKOFF: 60}, {STAIR: 2}, {WDIST: 0.5}), start=1):
        V = sgate.latest_version()
        p, _, verdict = propose(simp, sgate, V, cand, rnd=rnd)
        assert verdict == "passed", (cand, verdict)
        sgate.promote(p.gate_run_id)
        exports[V + 1] = sgate.export_brain(V + 1).model_dump(mode="json")
    assert sgate.latest_version() == 5
    for V, snapshot in exports.items():
        assert sgate.export_brain(V).model_dump(mode="json") == snapshot
    assert [value(sgate, v, STAIR) for v in range(1, 6)] == [99, 3, 3, 2, 2]
    assert sgate.get_brain_context("task:M:PICK", version=2)["version"] == 2
