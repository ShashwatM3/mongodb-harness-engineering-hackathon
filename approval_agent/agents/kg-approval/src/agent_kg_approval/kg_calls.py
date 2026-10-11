"""The gate-side KG calls behind the approval agent's tools.

Only functions, never a raw query on the gate client (kg/README.md). Nothing here returns held-out data:
scores are training-seed scores, and evidence comes from episodes and habits, not `heldout_results`.
"""

from __future__ import annotations

import os
from typing import Any, Optional

_gate = None


def gate():
    """One gate client per process: `kg.connect("gate", with_runner=False)` with KG_MONGODB_URI_GATE."""
    global _gate
    if _gate is None:
        os.environ.setdefault("KG_RAINDROP", "0")  # the evaluator side owns the Raindrop events
        import kg

        _gate = kg.connect("gate", with_runner=False)
    return _gate


def _zone_effect(zones: Optional[dict]) -> dict:
    keep = ("base", "cand", "delta", "seeds_better", "seeds_worse")
    return {z: {k: v.get(k) for k in keep if k in v} for z, v in (zones or {}).items()}


def pending_approvals(limit: int = 5) -> list[dict]:
    """Gate runs waiting on a human: verdict needs_approval and not promoted yet, newest first."""
    runs = gate().c("gate_runs").find({"verdict": "needs_approval", "promoted_to": None},
                                      {"edits": 1, "locked_edits": 1, "base_version": 1, "created_at": 1})
    out = []
    for r in runs.sort("created_at", -1).limit(limit):
        out.append({"gate_run_id": r["_id"], "base_version": r.get("base_version"),
                    "locked": [(e.get("target"), e.get("value")) for e in r.get("locked_edits") or []]})
    return out


def _evidence_for(g, target: str) -> dict:
    """Episodes and the habit clip behind the component currently setting `target` (kg.explain)."""
    V = g.latest_version()
    comp = g.c("brain_nodes").find_one({"compiles_to.target": target, "since": {"$lte": V},
                                        "$or": [{"until": None}, {"until": {"$gt": V}}]}, {"_id": 1})
    if comp is None:
        return {"component": None}
    ex = g.explain(comp["_id"])
    habit = ex.get("habit") or {}
    episodes = [{k: e.get(k) for k in ("_id", "seed", "tick", "zone", "type", "desc") if e.get(k) is not None}
                for e in (ex.get("episodes") or [])[:5]]
    return {"component": comp["_id"],
            "habit": {k: habit.get(k) for k in ("_id", "text", "clip")} if habit else None,
            "episode_ids": [e["_id"] for e in episodes], "episodes": episodes}


def _scores(g, effect: dict) -> dict:
    """current_scores() for the latest brain; before it has any, the gate run's base side is the same thing."""
    s = g.current_scores()
    if not s.get("zones") and effect:
        s = {**s, "zones": {z: v.get("base") for z, v in effect.items()}, "source": "this gate run's base"}
    return s


def approval_context(gate_run_id: str = "") -> dict:
    """What the Robotics Lead needs to decide: the locked edit, its measured effect from the gate run,
    current per-zone scores, and the episodes and habit clip behind the setting it changes."""
    g = gate()
    if not gate_run_id:
        pending = pending_approvals(1)
        if not pending:
            return {"error": "no gate run is waiting for approval"}
        gate_run_id = pending[0]["gate_run_id"]
    run = g.c("gate_runs").find_one({"_id": gate_run_id})
    if run is None:
        return {"error": f"no gate run {gate_run_id}"}
    if run.get("verdict") != "needs_approval":
        return {"error": f"gate run {gate_run_id} has verdict {run.get('verdict')!r}, not needs_approval"}
    base_of = {e.get("target"): e.get("base_value") for e in run.get("edits") or []}
    locked = [{"target": e.get("target"), "value": e.get("value"),
               "from": base_of.get(e.get("target"), e.get("baseline")), "reason": e.get("reason")}
              for e in run.get("locked_edits") or []]
    effect = _zone_effect(run.get("zones"))
    moved = ", ".join(f"zone {z} {v.get('base', 0):.3f}→{v.get('cand', 0):.3f}" for z, v in effect.items()
                      if v.get("delta"))
    edits_txt = "; ".join(f"{e['target']} {e['from']}→{e['value']}" for e in locked) or "none"
    summary = (f"Gate run {gate_run_id} tested a change to brain v{run.get('base_version')} on "
               f"{len(run['env']['seeds'])} training seeds. "
               f"It changes a locked setting ({edits_txt}), so the gate needs a human decision. "
               f"Measured effect: {moved or 'no zone score moved'}.")
    return {
        "gate_run_id": gate_run_id,
        "summary": summary,
        "locked_edits": locked,
        "edits": run.get("edits"),
        "measured_effect": effect,
        "failures": run.get("failures"),
        "current_scores": _scores(g, effect),
        "evidence": {e["target"]: _evidence_for(g, e["target"]) for e in locked},
        "latest_version": g.latest_version(),
    }


def record_decision(gate_run_id: str, decision: str, by: str = "Robotics Lead", ref: str = "",
                    notes: str = "") -> dict:
    """The resume handler: record_approval for every locked edit, then promote() when it's ready.
    Lines in the reviewer notes that start with "preference:" go to save_preference."""
    g = gate()
    decision = decision.strip().lower()
    if decision not in ("approve", "reject"):
        return {"error": f"decision must be approve or reject, got {decision!r}"}
    run = g.c("gate_runs").find_one({"_id": gate_run_id})
    if run is None:
        return {"error": f"no gate run {gate_run_id}"}
    out: dict[str, Any] = {"gate_run_id": gate_run_id, "decision": decision, "approvals": []}
    ready: set[str] = set()
    for e in run.get("locked_edits") or []:
        r = g.record_approval(e["target"], e["value"], decision, by=by, ref=ref or None)
        out["approvals"].append({"target": e["target"], "value": e["value"], **r})
        ready.update(r.get("ready_to_promote") or [])
    prefs = [ln.split(":", 1)[1].strip() for ln in notes.splitlines()
             if ln.strip().lower().startswith("preference:") and ln.split(":", 1)[1].strip()]
    out["preferences"] = [g.save_preference(p, by=by, ref=ref or None).get("version") for p in prefs]
    if decision == "approve" and gate_run_id in ready:
        v = g.promote(gate_run_id, run.get("hypothesis") or f"approved by {by}")
        out["promoted_to"] = v["version"]
    return out
