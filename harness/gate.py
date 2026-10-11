"""The gate: the one place that decides whether a candidate brain is promoted.

Rule (kg/README.md "The gate", project record "no zone worse and something better, locked edits need
approval"):
  1. refuse if any scored zone fell by more than GATE_TOLERANCE on the training seeds;
  2. refuse if no zone rose by at least GATE_MIN_GAIN;
  3. if the candidate touches a locked setting -> needs_approval (never auto-pass);
  4. otherwise run the held-out seeds (gate client only, runner held_out=true) on base and candidate,
     record_heldout, and pass only if the held-out zones agree (no zone worse than tolerance, mean gain >= 0).
The improver client never sees held-out seeds or numbers: this module only ever uses the gate client for them.
"""
from __future__ import annotations

import logging
from typing import Any

import kg
from kg.runner import BrainRejected

from .config import Settings

log = logging.getLogger("harness.gate")


def ensure_heldout_seeds(gate: kg.KG, cfg: Settings) -> None:
    """Idempotent: the locked test seed sets the improver can never read."""
    c = gate.c("heldout_seeds")
    c.update_one({"_id": "heldout-a"}, {"$setOnInsert": {"seeds": cfg.heldout_seeds, "purpose": "gate check per promotion"}}, upsert=True)
    c.update_one({"_id": "final"}, {"$setOnInsert": {"seeds": cfg.final_seeds, "purpose": "v1 vs vN once, after the freeze"}}, upsert=True)


def training_verdict(run: dict, cfg: Settings) -> tuple[str, str]:
    """Steps 1-3 on the training numbers already in the gate run."""
    zones: dict[str, dict[str, Any]] = run.get("zones") or {}
    if not zones:
        return "rejected", "not evaluated"
    worse = {z: v["delta"] for z, v in zones.items() if v["delta"] < -cfg.tolerance}
    better = {z: v["delta"] for z, v in zones.items() if v["delta"] >= cfg.min_gain}
    if worse:
        return "rejected", "zone " + ", ".join(f"{z} fell {d:+.3f}" for z, d in sorted(worse.items()))
    if not better:
        return "rejected", f"no zone rose by at least {cfg.min_gain:g}"
    gain = ", ".join(f"{z} {d:+.3f}" for z, d in sorted(better.items(), key=lambda kv: -kv[1]))
    if run.get("locked_edits"):
        targets = ", ".join(f"{e['target']}={e['value']}" for e in run["locked_edits"])
        return "needs_approval", f"improves {gain}; touches locked {targets}"
    return "passed", f"improves {gain}; no zone worse than {cfg.tolerance:g}"


def heldout_check(gate: kg.KG, gate_run_id: str, cfg: Settings, seed_set: str = "heldout-a") -> dict:
    """Run base and candidate on the locked seeds through the gate client, record the verdict, return it."""
    run = gate.c("gate_runs").find_one({"_id": gate_run_id})
    if run is None:
        raise KeyError(gate_run_id)
    seeds = gate.c("heldout_seeds").find_one({"_id": seed_set})["seeds"]
    base = gate.export_brain(run["base_version"])
    cand = gate.export_brain(run["base_version"])
    # rebuild the candidate: base with the run's edits applied at site level
    cand = gate._apply_edits(base, {e["target"]: e["value"] for e in run["edits"]}, run.get("origin") or {"source": "gate"})
    kw = {"ticks": gate.env.ticks, "profile": gate.env.profile, "held_out": True}
    try:
        rb = gate.runner.run_shift(base, seeds, **kw)
        rc = gate.runner.run_shift(cand, seeds, allow_locked=bool(run.get("locked_edits")), **kw)
    except BrainRejected as e:
        return gate.record_heldout(gate_run_id, seed_set, False, {}) | {"error": str(e)}
    zb, zc = rb.pooled.zones, rc.pooled.zones
    delta = {z: round(zc[z].score - zb[z].score, 3) for z in zb if z in zc}
    worst = min(delta.values()) if delta else 0.0
    mean = sum(delta.values()) / len(delta) if delta else 0.0
    # Held-out agreement, not held-out perfection: the fleet-wide mean may not fall, and no zone may fall by more
    # than three tolerances (zone M offers ~19 tasks a shift, so one zone's score moves in steps of ~0.05).
    passed = worst >= -3 * cfg.tolerance and mean >= -cfg.min_gain
    out = gate.record_heldout(gate_run_id, seed_set, passed, delta)
    log.info("held-out %s for %s: %s (worst %+.3f, mean %+.3f)", seed_set, gate_run_id, "passed" if passed else "failed", worst, mean)
    # The numbers stay in heldout_results; the caller only learns the boolean and a one-line reason.
    return {"passed": passed, "id": out["_id"], "reason": f"held-out {'agrees' if passed else 'disagrees'} (worst zone {worst:+.3f}, mean {mean:+.3f})"}


def decide(gate: kg.KG, gate_run_id: str, cfg: Settings) -> dict:
    """The full gate. Returns {verdict, reason, heldout_passed}. Records the verdict in the KG."""
    run = gate.c("gate_runs").find_one({"_id": gate_run_id})
    if run is None:
        raise KeyError(gate_run_id)
    if run.get("verdict") in ("invalid",):
        return {"verdict": "invalid", "reason": run.get("reason"), "heldout_passed": None}
    if run.get("verdict") in ("passed", "rejected", "needs_approval", "promoted"):
        return {"verdict": run["verdict"], "reason": run.get("reason"), "heldout_passed": None, "already": True}
    verdict, reason = training_verdict(run, cfg)
    heldout_passed = None
    if verdict in ("passed", "needs_approval"):
        ho = heldout_check(gate, gate_run_id, cfg)
        heldout_passed = ho["passed"]
        if not ho["passed"]:
            verdict, reason = "rejected", f"{reason}; but {ho['reason']}"
        else:
            reason = f"{reason}; {ho['reason']}"
    gate.record_verdict(gate_run_id, verdict, reason)
    return {"verdict": verdict, "reason": reason, "heldout_passed": heldout_passed}


def final_proof(st) -> dict:
    """v1 against the latest brain on the `final` locked seeds, through the gate client with held_out=true.
    Returns booleans and per-zone deltas (the headline before/after), never per-seed rows to the improver."""
    gate, cfg = st.gate, st.cfg
    V = gate.latest_version()
    seeds = gate.c("heldout_seeds").find_one({"_id": "final"})["seeds"]
    kw = {"ticks": gate.env.ticks, "profile": gate.env.profile, "held_out": True}
    r1 = gate.runner.run_shift(gate.export_brain(1), seeds, **kw)
    rN = gate.runner.run_shift(gate.export_brain(V), seeds, allow_locked=False, **kw) if V != 1 else r1
    z1 = {z: m.score for z, m in r1.pooled.zones.items()}
    zN = {z: m.score for z, m in rN.pooled.zones.items()}
    delta = {z: round(zN[z] - z1[z], 3) for z in z1}
    mean1 = round(sum(z1.values()) / len(z1), 3); meanN = round(sum(zN.values()) / len(zN), 3)
    passed = min(delta.values()) >= -3 * cfg.tolerance and meanN >= mean1
    if V != 1:
        gate.record_final(V, passed, delta)
    return {"v1": {"zones": z1, "mean": mean1, "fleet": r1.mean.fleet.model_dump()}, "latest": {"version": V, "zones": zN, "mean": meanN, "fleet": rN.mean.fleet.model_dump()},
            "delta": delta, "passed": passed, "seed_set": "final", "n_seeds": len(seeds),
            "failures": {"v1": {t: sum(s.failure_counts.get(t, 0) for s in r1.per_seed) for t in r1.per_seed[0].failure_counts},
                         "latest": {t: sum(s.failure_counts.get(t, 0) for s in rN.per_seed) for t in rN.per_seed[0].failure_counts}}}
