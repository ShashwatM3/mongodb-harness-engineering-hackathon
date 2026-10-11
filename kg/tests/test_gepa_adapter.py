"""The GEPA evaluator wiring, exercised without GEPA: the functions GEPA would call."""
from __future__ import annotations

import json

from kg.gepa_adapter import make_batch_evaluator, make_evaluator

STAIR = "sim.STAIR_MIN_LIFT_QUEUE"


def test_evaluator_scores_and_explains(gate, improver, sink):
    ev = make_evaluator(improver, lambda: 1, policy="gepa-p1")
    s99, side99 = ev(json.dumps({STAIR: 3}))
    s2, side2 = ev(json.dumps({STAIR: 2}))
    assert s2 > s99 > 0
    assert side2["zones"]["M"]["delta"] > 0 and "### C." in side2["brain_context"]
    again, side = ev(json.dumps({STAIR: 2}))
    assert again == s2 and "repeat" in side
    bad, side_bad = ev('{"sim.STAIR_MIN_LIFT_QUEUE": 500}')
    assert bad == 0.0 and "out of range" in side_bad["refused"]
    locked, side_locked = ev({"class.HUM-1.max_speed": 1.35})
    assert "needs the Robotics Lead's approval" in side_locked["needs_approval"]
    assert sorted(set(sink.signal_names())) == ["invalid_proposal", "re_proposed"]


def test_batch_evaluator_measures_each_candidate_once(gate, improver, runner):
    batch = make_batch_evaluator(improver, lambda: 1)
    seeds = improver.seed_sets["train"][:4]
    pairs = [(json.dumps({STAIR: 2}), s) for s in seeds] + [(json.dumps({STAIR: 5}), s) for s in seeds]
    out = batch(pairs, opt_states=None)
    assert len(out) == 8 and all(score > 0 for score, _ in out)
    assert gate.db.gate_runs.count_documents({}) == 2       # one gate run per candidate, not per seed
    assert len(runner.calls) == 3                           # base once, each candidate once
    assert batch([(json.dumps({STAIR: 2}), None)])[0][0] > 0  # single-task mode
