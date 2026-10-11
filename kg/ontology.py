"""The two hierarchies: the scope skeleton (team doc 03) and the concept trees.

Scope says where a component applies: site:main → zone → task.
Concepts say what went wrong, where time goes, and what can be changed:
  failure  congestion / throughput / energy / disruption, each with candidate lever groups
  time     the time_split states; non-productive ones point at lever groups
  outcome  late and dropped tasks (from uncapped ZoneMetrics) → dispatch, energy
  lever    floor_change, waiting, energy, dispatch, motion (locked), yielding (empty on purpose)
"""
from __future__ import annotations

from typing import Optional

from .registry import LEVER_GROUP_LABELS, LEVER_GROUPS, SETTINGS, Setting

# Zone C is added to doc 03's skeleton: the stairwell sits there (decision D1).
SKELETON_ZONES = ["B", "C", "D", "M"]
TASK_TYPES = ["PICK", "REPLENISH", "TRANSPORT", "RETURN"]
SITE_ID = "site:main"

SKELETON_KINDS = ["site", "zone", "task"]
COMPONENT_KINDS = ["rule", "guardrail", "context_policy", "tool_grant"]


def skeleton_nodes() -> list[dict]:
    """1 site, 4 zones, 16 task nodes. Written once; the improver never changes them."""
    nodes = [{"_id": SITE_ID, "kind": "site", "parent_id": None, "label": "Main warehouse", "order": 0}]
    for zi, z in enumerate(SKELETON_ZONES):
        label = "Zone M (mezzanine, reached by lift or the west stairs)" if z == "M" else f"Zone {z}"
        nodes.append({"_id": f"zone:{z}", "kind": "zone", "parent_id": SITE_ID, "zone": z,
                      "label": label, "order": 10 + zi})
        for ti, t in enumerate(TASK_TYPES):
            nodes.append({"_id": f"task:{z}:{t}", "kind": "task", "parent_id": f"zone:{z}", "zone": z,
                          "task_type": t, "label": f"{t} in zone {z}", "order": 100 + 10 * zi + ti})
    return nodes


def _lev(*groups: str) -> list[str]:
    return [f"c:lever/{g}" for g in groups]


FAILURE_GROUPS = {
    "congestion": {
        "label": "Congestion: robots waiting on each other or on shared resources",
        "candidate_lever_groups": _lev("floor_change", "waiting", "yielding"),
        "leaves": {
            "LIFT_QUEUE_JAM": ("A robot stayed in a lift queue for more than 30 s", _lev("floor_change")),
            "STAIR_QUEUE": ("A robot waited because the stairwell was full", _lev("floor_change")),
            "DEADLOCK_BACKOFF": ("The engine's collision back-off fired", _lev("waiting", "yielding")),
        },
    },
    "throughput": {
        "label": "Throughput: tasks finished late or never entered",
        "candidate_lever_groups": _lev("dispatch", "energy"),
        "leaves": {
            "LATE_TASK": ("A task finished after its deadline", _lev("dispatch", "energy")),
            "DROPPED_DEMAND": ("A task was dropped because the waiting queue was full", _lev("dispatch")),
        },
    },
    "energy": {
        "label": "Energy: robots running out of battery on the job",
        "candidate_lever_groups": _lev("energy"),
        "leaves": {
            "BATTERY_STRANDING": ("A robot hit critical battery while carrying a load", _lev("energy")),
        },
    },
    "disruption": {
        "label": "Disruption: people in the robots' way",
        "candidate_lever_groups": _lev("waiting", "dispatch"),
        "leaves": {
            "HUMAN_REPLAN": ("A robot rerouted around a zone blocked by a person", _lev("waiting", "dispatch")),
        },
    },
}

#: state → (productive, candidate lever groups, rank_after)
TIME_STATES = {
    "travel": (True, [], None),
    "pick_drop": (True, [], None),
    "lift_wait": (False, _lev("floor_change"), None),
    "blocked": (False, _lev("waiting", "yielding"), None),
    "stairs": (False, _lev("floor_change"), None),
    # riding the lift is an unavoidable cost of changing floors, so it never outranks lift_wait
    "lift_ride": (False, _lev("floor_change"), "c:time/non_productive/lift_wait"),
}

OUTCOMES = {
    "late": "Tasks finished after their deadline (uncapped, from ZoneMetrics)",
    "dropped": "Tasks dropped because the waiting queue was full (uncapped, from ZoneMetrics)",
}


def failure_group_of(failure_type: str) -> Optional[str]:
    for g, spec in FAILURE_GROUPS.items():
        if failure_type in spec["leaves"]:
            return g
    return None


def concept_docs(settings: Optional[list[Setting]] = None) -> list[dict]:
    """About 50 static documents. Phase 3 writes learned orderings into separate fields."""
    settings = settings if settings is not None else SETTINGS
    docs: list[dict] = []

    def add(_id, tree, kind, parent, label, **extra):
        docs.append({"_id": _id, "tree": tree, "kind": kind, "parent_id": parent, "label": label, **extra})

    add("c:failure", "failure", "root", None, "What went wrong")
    for g, spec in FAILURE_GROUPS.items():
        gid = f"c:failure/{g}"
        add(gid, "failure", "group", "c:failure", spec["label"],
            candidate_lever_groups=spec["candidate_lever_groups"])
        for ftype, (desc, levers) in spec["leaves"].items():
            add(f"{gid}/{ftype}", "failure", "leaf", gid, desc, failure_type=ftype,
                candidate_lever_groups=levers)

    add("c:time", "time", "root", None, "Where task time goes (time_split)")
    add("c:time/productive", "time", "group", "c:time", "Productive time")
    add("c:time/non_productive", "time", "group", "c:time", "Non-productive time")
    for state, (productive, levers, rank_after) in TIME_STATES.items():
        parent = "c:time/productive" if productive else "c:time/non_productive"
        add(f"{parent}/{state}", "time", "leaf", parent, state.replace("_", " "), state=state,
            productive=productive, candidate_lever_groups=levers, rank_after=rank_after)

    add("c:outcome", "outcome", "root", None, "Outcomes in the worst zone (second ranking key)")
    for metric, desc in OUTCOMES.items():
        add(f"c:outcome/{metric}", "outcome", "leaf", "c:outcome", desc, metric=metric,
            candidate_lever_groups=_lev("dispatch", "energy"))

    add("c:lever", "lever", "root", None, "What the brain can change")
    for g in LEVER_GROUPS:
        members = [s for s in settings if s.group == g and s.is_lever]
        statuses = sorted({s.status for s in members})
        add(f"c:lever/{g}", "lever", "group", "c:lever", LEVER_GROUP_LABELS[g],
            status=statuses[0] if len(statuses) == 1 else ("mixed" if statuses else "empty"),
            capability_gap=not members)
        for s in members:
            add(s.lever_id, "lever", "leaf", f"c:lever/{g}", s.description, target=s.target,
                min=s.min, max=s.max, v1=s.v1, status=s.status)
    return docs
