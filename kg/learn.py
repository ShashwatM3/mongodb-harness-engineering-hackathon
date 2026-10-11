"""Phase 3 (stretch): the ontology improves itself.

From promoted gate runs, learn which lever groups held the winning edit when a given time state, outcome
or failure group was the worst. Then check it prequentially: for each promotion t, learn only from the
promotions before t, rank lever groups as section C would have at t, and see where the winner's group
landed. Compare with the hand-written order and a random order (its expected rank, (n + 1) / 2, is the
average over every shuffle). Few promotions (5-10) make this a proxy measure, not proof.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Optional

from .registry import LEVER_GROUPS
from .views import time_concept_id


def winners(kg, env_key: Optional[str] = None) -> list[dict]:
    q: dict = {"verdict": "promoted", "context": {"$ne": None}}
    if env_key:
        q["env_key"] = env_key
    out = []
    for r in kg.c("gate_runs").find(q, {"promoted_to": 1, "context": 1, "edits": 1}).sort("promoted_to", 1):
        groups = sorted({e.get("lever_group") for e in r["edits"] if e.get("lever_group")})
        if groups:
            out.append({"gate_run_id": r["_id"], "version": r["promoted_to"], "context": r["context"],
                        "groups": groups, "targets": [e["target"] for e in r["edits"]]})
    return out


def _context_concepts(ctx: dict) -> list[str]:
    """The concepts section C consults for this context, in its ranking-key order."""
    out = []
    if ctx.get("time_state"):
        out.append(time_concept_id(ctx["time_state"]))
    if ctx.get("late_dropped"):
        out.append("c:outcome/late")
    if ctx.get("failure_group"):
        out.append(f"c:failure/{ctx['failure_group']}")
    return out


def learn(wins: list[dict], concepts: dict[str, dict]) -> dict[str, list[str]]:
    """concept id → lever groups, those that won under it first (by count), then its hand-written ones."""
    counts: dict[str, Counter] = defaultdict(Counter)
    for w in wins:
        for cid in _context_concepts(w["context"]):
            for g in w["groups"]:
                counts[cid][f"c:lever/{g}"] += 1
    learned = {}
    for cid, c in counts.items():
        ranked = [g for g, _ in sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))]
        learned[cid] = ranked + [g for g in (concepts.get(cid, {}).get("candidate_lever_groups") or []) if g not in ranked]
    return learned


def order_for(ctx: dict, concepts: dict[str, dict], learned: Optional[dict] = None) -> list[str]:
    order: list[str] = []
    for cid in _context_concepts(ctx):
        groups = (learned or {}).get(cid) or concepts.get(cid, {}).get("candidate_lever_groups") or []
        for g in groups:
            name = g.removeprefix("c:lever/")
            if name not in order:
                order.append(name)
    return order + [g for g in LEVER_GROUPS if g not in order]


def prequential(kg, env_key: Optional[str] = None, margin: float = 0.5) -> dict:
    concepts = {d["_id"]: d for d in kg.c("concepts").find({}, {"candidate_lever_groups": 1})}
    wins = winners(kg, env_key)
    rows = []
    for t, w in enumerate(wins):
        learned = learn(wins[:t], concepts)
        hand, lrn = order_for(w["context"], concepts), order_for(w["context"], concepts, learned)
        rank = lambda order: min(order.index(g) for g in w["groups"]) + 1  # evaluations to reach a winning group
        rows.append({"version": w["version"], "groups": w["groups"], "context": w["context"],
                     "hand_rank": rank(hand), "learned_rank": rank(lrn), "random_rank": (len(LEVER_GROUPS) + 1) / 2,
                     "learned_from": t})
    mean = lambda k: sum(r[k] for r in rows) / len(rows) if rows else None
    summary = {"promotions": len(rows), "hand": mean("hand_rank"), "learned": mean("learned_rank"),
               "random": mean("random_rank")}
    summary["keep_learned"] = bool(rows) and summary["learned"] + margin <= min(summary["hand"], summary["random"])
    return {"rows": rows, "summary": summary,
            "note": "proxy measure on our own promotions, not proof; random is the expected rank over all shuffles"}


def store(kg, env_key: Optional[str] = None) -> dict:
    """Write the learned orders into concepts.learned_lever_groups (gate only). get_context uses them when
    asked (use_learned=True); the hand-written candidate_lever_groups stay untouched."""
    kg._require_gate("learn.store()")
    concepts = {d["_id"]: d for d in kg.c("concepts").find({}, {"candidate_lever_groups": 1})}
    wins = winners(kg, env_key)
    learned = learn(wins, concepts)
    for cid, groups in learned.items():
        kg.c("concepts").update_one({"_id": cid}, {"$set": {"learned_lever_groups": groups,
                                                            "learned_from_promotions": len(wins)}})
    return learned
