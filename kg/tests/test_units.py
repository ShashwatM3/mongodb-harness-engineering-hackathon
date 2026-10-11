"""Pure-Python pieces: hashing, the local compiler mirror, metrics, the ontology. No database."""
from __future__ import annotations

from kg.contract import Brain
from kg.core import order_time_states, parse_candidate
from kg.hashing import (canonical_json, compile_patch, effective_edits, episode_ids, event_id, gate_run_id,
                        local_patch_hash, shift_id)
from kg.metrics import capped_types, pooled_zone, r3
from kg.ontology import concept_docs, skeleton_nodes
from kg.registry import SETTINGS


def brain(*nodes):
    return Brain.model_validate({"version": 1, "nodes": [
        {"node_id": "w", "parent_id": None, "level": "site"},
        {"node_id": "z", "parent_id": "w", "level": "zone"},
        *nodes]})


def edit(nid, parent, target, value):
    return {"node_id": nid, "parent_id": parent, "level": "rule", "body": {"op": "set", "target": target, "value": value}}


def test_precedence_matches_the_fake_runner():
    # deeper wins
    b = brain(edit("a", "w", "sim.X", 1), edit("b", "z", "sim.X", 2))
    assert effective_edits(b)["sim.X"] == {"value": 2, "node_id": "b", "depth": 2}
    # same depth: the later node wins
    b = brain(edit("a", "w", "sim.X", 1), edit("b", "w", "sim.X", 3))
    assert effective_edits(b)["sim.X"]["value"] == 3
    # a node whose parent is missing counts from depth 0 (fake.ts depthOf)
    b = brain(edit("a", "nowhere", "sim.X", 5), edit("b", "w", "sim.X", 4))
    assert effective_edits(b)["sim.X"]["value"] == 4
    # non-edit bodies are carried through and ignored
    b = brain({"node_id": "h", "parent_id": "z", "level": "habit", "body": {"text": "wait by the door"}})
    assert effective_edits(b) == {}


def test_patch_hash_ignores_node_ids_and_number_spelling():
    a = brain(edit("a", "w", "sim.STAIR_MIN_LIFT_QUEUE", 2), edit("b", "w", "class.HUM-1.max_speed", 1.2))
    b = brain(edit("q", "w", "class.HUM-1.max_speed", 1.2), edit("r", "w", "sim.STAIR_MIN_LIFT_QUEUE", 2.0))
    pa, ua = compile_patch(effective_edits(a))
    pb, _ = compile_patch(effective_edits(b))
    assert ua == [] and pa == {"sim": {"STAIR_MIN_LIFT_QUEUE": 2}, "classes": {"HUM-1": {"max_speed": 1.2}}}
    assert local_patch_hash(pa) == local_patch_hash(pb)
    assert canonical_json({"b": 2.0, "a": [1.0, -0.0]}) == '{"a":[1,0],"b":2}'


def test_assign_weights_compile_to_sim_and_zone_capacity_to_zones():
    p, unknown = compile_patch(effective_edits(brain(edit("a", "w", "assign.W_DISTANCE", 0.5),
                                                     edit("b", "w", "zone.M.capacity", 10),
                                                     edit("c", "w", "bogus", 1))))
    assert p == {"sim": {"W_DISTANCE": 0.5}, "zones": {"M": {"capacity": 10}}}
    assert [u["target"] for u in unknown] == ["bogus"]


def test_ids_are_content_hashes():
    assert gate_run_id("env-1", [3, 1, 2, 2], "h0", "h1") == gate_run_id("env-1", [1, 2, 3], "h0", "h1")
    assert gate_run_id("env-1", [1, 2, 3], "h0", "h1") != gate_run_id("env-2", [1, 2, 3], "h0", "h1")
    assert shift_id("env-1", "h0", 7) != shift_id("env-1", "h0", 8)
    e = event_id("gr-1", 4, "p1")
    assert e == event_id("gr-1", 4, "p1") and e != event_id("gr-1", 4, "p2") and len(e) == 36
    fails = [{"type": "LIFT_QUEUE_JAM", "tick": 5}, {"type": "LIFT_QUEUE_JAM", "tick": 5}, {"type": "LATE_TASK", "tick": 5}]
    assert episode_ids("sh-1", fails) == ["ep:sh-1:LIFT_QUEUE_JAM:5", "ep:sh-1:LIFT_QUEUE_JAM:5:2", "ep:sh-1:LATE_TASK:5"]


def test_pooled_score_follows_the_contract():
    z = lambda on_time, offered, censored, safety: {"zones": {"M": {"offered": offered, "on_time": on_time, "late": 0,
                                                                    "failed": 0, "dropped": 0, "censored": censored,
                                                                    "safety_events": safety, "score": 0}}}
    p = pooled_zone([z(8, 12, 2, 1), z(5, 10, 0, 0)], "M")
    # (8 + 5) / (22 - 2) - 0.05 * (1 / 2) = 0.65 - 0.025
    assert p["score"] == r3(0.625) and p["offered"] == 22
    assert r3(0.0005) == 0.001 and r3(0.2344) == 0.234


def test_capped_types():
    r = {"failures": [{"type": "LATE_TASK"}] * 25 + [{"type": "LIFT_QUEUE_JAM"}] * 2,
         "failure_counts": {"LATE_TASK": 31, "LIFT_QUEUE_JAM": 2, "STAIR_QUEUE": 0}}
    assert capped_types(r) == {"LATE_TASK"}


def test_lift_ride_never_ranks_ahead_of_lift_wait():
    assert order_time_states({"travel": 0.5, "lift_ride": 0.2, "lift_wait": 0.1, "blocked": 0.15, "stairs": 0}) == \
        ["blocked", "lift_wait", "lift_ride"]
    assert order_time_states({"travel": 1.0}) == []


def test_parse_candidate_rejects_booleans_and_text():
    assert parse_candidate('{"sim.X": 2.0}') == {"sim.X": 2}
    for bad in ({"sim.X": True}, {"sim.X": "2"}, 42):
        try:
            parse_candidate(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


def test_skeleton_and_ontology_shapes():
    sk = skeleton_nodes()
    assert len(sk) == 21 and sum(n["kind"] == "task" for n in sk) == 16
    docs = concept_docs()
    ids = {d["_id"] for d in docs}
    assert all(d["parent_id"] is None or d["parent_id"] in ids for d in docs)
    assert {"c:failure", "c:time", "c:outcome", "c:lever"} <= ids
    yielding = next(d for d in docs if d["_id"] == "c:lever/yielding")
    assert yielding["capability_gap"] is True
    motion_leaves = [d for d in docs if d.get("parent_id") == "c:lever/motion"]
    assert motion_leaves and all(d["status"] == "locked" for d in motion_leaves)
    # every lever group named by a concept exists
    groups = {g for d in docs for g in d.get("candidate_lever_groups") or []}
    assert groups <= ids
    # every setting the brain may change belongs to a lever group or is pinned (min == max)
    assert all(s.group or not s.gets_v1_component for s in SETTINGS)
