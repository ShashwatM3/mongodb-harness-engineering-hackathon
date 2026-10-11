"""Wiring GEPA's optimize_anything (gepa 0.1.4) to the KG. GEPA is not a dependency of the KG;
this module only builds the evaluator functions, so it imports nothing from gepa.

Every evaluation goes record_proposal → runner → record_shifts (via KG.evaluate), and side_info carries
the KG's get_context(V) so the reflection LM sees what was already tried on this brain.

    import gepa.optimize_anything as oa
    imp = kg.connect("improver")                  # the GEPA side holds only the improver client
    V = imp.latest_version()
    seed = json.dumps({"sim.STAIR_MIN_LIFT_QUEUE": 99})
    # single-task mode: one call per candidate, measured on all training seeds
    result = oa.optimize_anything(seed, evaluator=make_evaluator(imp, lambda: V), objective=OBJECTIVE, ...)
    # generalization mode: dataset/valset are seed lists; each candidate is still measured once per split
    result = oa.optimize_anything(seed, evaluator=make_evaluator(imp, lambda: V),
                                  batch_evaluator=make_batch_evaluator(imp, lambda: V),
                                  dataset=imp.seed_sets["train"], valset=imp.seed_sets["val"], ...)
"""
from __future__ import annotations

import itertools
import json
from typing import Any, Callable, Optional

from .hashing import shift_id

OBJECTIVE = ("Propose a JSON object of brain setting edits {target: value} for a humanoid warehouse fleet. "
             "Raise the per-zone on-time scores, the worst zone first, without making any zone worse. "
             "Only targets listed in the context's section C may change, within their min and max. "
             "Locked settings need a phone approval from the Robotics Lead. Don't repeat what section B shows.")


def default_objective(result: dict) -> float:
    """Mean candidate score over zones. Swap in the gate's own rule if it differs."""
    zones = result.get("zones") or {}
    return sum(v["cand"] for v in zones.values()) / len(zones) if zones else 0.0


def _side_info(kg, V: int, p, result: dict, with_context: bool) -> dict:
    side = {"gate_run_id": p.gate_run_id, "status": p.status, "edits": p.edits, "verdict": result.get("verdict")}
    if p.status == "invalid":
        side["refused"] = p.reason
    else:
        side["zones"] = {z: {k: v[k] for k in ("base", "cand", "delta", "seeds_better", "seeds_worse")}
                         for z, v in (result.get("zones") or {}).items()}
        side["failures"] = result.get("failures")
    if p.repeat:
        side["repeat"] = "this candidate was already proposed under this policy; the result is cached"
    if p.locked_edits:
        side["needs_approval"] = "needs the Robotics Lead's approval for " + ", ".join(
            f"{e['target']}={e['value']}" for e in p.locked_edits)
    if with_context:
        side["brain_context"] = kg.get_context(V)["markdown"]
    return side


def make_evaluator(kg, base_version: Callable[[], int], *, split: str = "train", policy: str = "gepa",
                   round_: Callable[[], int] = lambda: 0, objective: Callable[[dict], float] = default_objective,
                   runner=None, with_context: bool = True):
    """GEPA evaluator(candidate, example=None) -> (score, side_info). One gate run per candidate and split;
    every call is its own Raindrop event, so a candidate GEPA proposes again counts as re_proposed."""
    calls = itertools.count()

    def evaluate(candidate: Any, example: Any = None, **_: Any):
        V = base_version()
        p = kg.record_proposal(V, candidate, origin={"source": "gepa"}, round=round_(), policy=policy, split=split,
                               attempt=next(calls))
        result = kg.evaluate(p, runner)
        score = 0.0 if p.status == "invalid" else objective(result)
        return score, _side_info(kg, V, p, result, with_context)

    return evaluate


def make_batch_evaluator(kg, base_version: Callable[[], int], *, split: str = "train", policy: str = "gepa",
                         round_: Callable[[], int] = lambda: 0, runner=None, with_context: bool = False):
    """GEPA batch_evaluator(pairs) for generalization mode, where each example is a seed. Each distinct
    candidate is measured once on the whole split; each pair gets that seed's mean zone score."""

    calls = itertools.count()

    def key_of(c: Any) -> str:
        return c if isinstance(c, str) else json.dumps(c, sort_keys=True)

    def batch(pairs: list, **_: Any) -> list:
        V = base_version()
        done: dict[str, tuple] = {}
        out = []
        for candidate, example in pairs:
            k = key_of(candidate)
            if k not in done:
                p = kg.record_proposal(V, candidate, origin={"source": "gepa"}, round=round_(), policy=policy,
                                       split=split, attempt=next(calls))
                result = kg.evaluate(p, runner)
                run = kg.c("gate_runs").find_one({"_id": p.gate_run_id}, {"cand_patch_hash": 1, "env_key": 1})
                done[k] = (p, result, run, _side_info(kg, V, p, result, with_context))
            p, result, run, side = done[k]
            if p.status == "invalid":
                out.append((0.0, side))
                continue
            if example is None:  # single-task mode: no per-seed examples
                out.append((default_objective(result), side))
                continue
            seed = int(example)
            doc = kg.c("shifts").find_one({"_id": shift_id(run["env_key"], run["cand_patch_hash"], seed)},
                                          {"result.zones": 1})
            zones = (doc or {}).get("result", {}).get("zones", {})
            score = sum(z["score"] for z in zones.values()) / len(zones) if zones else 0.0
            out.append((score, {**side, "seed": seed}))
        return out

    return batch


def gepa_config_hint(max_metric_calls: int = 60) -> dict:
    """Settings to pass to GEPAConfig/EngineConfig: cap the budget; keep GEPA's cache on, the KG dedups anyway."""
    return {"max_metric_calls": max_metric_calls}
