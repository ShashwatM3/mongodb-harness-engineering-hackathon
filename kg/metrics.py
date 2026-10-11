"""Numbers derived from raw per-seed results (SeedResult dicts as stored in `shifts`).

Everything here is recomputable from `shifts`, which is why the raw results are
kept: a later phase can derive something new without re-running the twin.
"""
from __future__ import annotations

import math
from typing import Iterable

from .contract import TIME_STATES

COUNT_KEYS = ["offered", "on_time", "late", "failed", "dropped", "censored", "safety_events"]
FLEET_KEYS = ["on_time_rate", "completed", "energy_kwh", "stair_trips", "lift_trips", "avg_lift_wait_s",
              "battery_strandings"]


def r3(x: float) -> float:
    """Round half up to 3 decimals, like the runner's Math.round(x * 1000) / 1000."""
    return math.floor(x * 1000 + 0.5) / 1000


def zones_in(results: Iterable[dict]) -> list[str]:
    return sorted({z for r in results for z in r.get("zones", {})})


def pooled_zone(results: list[dict], zone: str) -> dict:
    """Counts summed across seeds, score recomputed from the sums (contract.ts PooledZone)."""
    sums = {k: 0 for k in COUNT_KEYS}
    for r in results:
        zm = r.get("zones", {}).get(zone)
        if zm:
            for k in COUNT_KEYS:
                sums[k] += int(zm.get(k, 0))
    n = max(1, len(results))
    scored = max(1, sums["offered"] - sums["censored"])
    score = sums["on_time"] / scored - 0.05 * (sums["safety_events"] / n)
    return {**sums, "score": r3(min(1.0, max(0.0, score)))}


def seed_zone_score(result: dict, zone: str):
    zm = result.get("zones", {}).get(zone)
    return None if zm is None else float(zm["score"])


def mean_time_split(results: list[dict], zone: str) -> dict:
    """Plain mean of per-seed shares, renormalised. (Per-seed task-time weights aren't reported.)"""
    acc = {s: 0.0 for s in TIME_STATES}
    n = 0
    for r in results:
        ts = r.get("zones", {}).get(zone, {}).get("time_split")
        if ts:
            n += 1
            for s in TIME_STATES:
                acc[s] += float(ts.get(s, 0) or 0)
    tot = sum(acc.values())
    if n == 0 or tot <= 0:
        return {s: 0.0 for s in TIME_STATES}
    return {s: r3(v / tot) for s, v in acc.items()}


def failure_totals(results: list[dict]) -> dict[str, int]:
    """Uncapped totals per failure type (from failure_counts), summed over seeds."""
    out: dict[str, int] = {}
    for r in results:
        for t, c in (r.get("failure_counts") or {}).items():
            out[t] = out.get(t, 0) + int(c)
    return out


def capped_types(result: dict) -> set[str]:
    """Types whose `failures` list was cut at 25 for this seed (the per-entry list undercounts them)."""
    listed: dict[str, int] = {}
    for f in result.get("failures") or []:
        listed[f["type"]] = listed.get(f["type"], 0) + 1
    counts = result.get("failure_counts") or {}
    return {t for t, c in counts.items() if int(c) > listed.get(t, 0)}


def failures_by_zone(results: list[dict]) -> dict[str, dict]:
    """type → {zone: count, ...} from the per-entry lists, plus `capped` when any seed was cut."""
    out: dict[str, dict] = {}
    for r in results:
        cut = capped_types(r)
        for f in r.get("failures") or []:
            d = out.setdefault(f["type"], {"zones": {}, "capped": False})
            z = f.get("zone") or "-"
            d["zones"][z] = d["zones"].get(z, 0) + 1
        for t in cut:
            out.setdefault(t, {"zones": {}, "capped": False})["capped"] = True
    return out


def fleet_means(results: list[dict]) -> dict[str, float]:
    n = max(1, len(results))
    return {k: r3(sum(float(r.get("fleet", {}).get(k, 0) or 0) for r in results) / n) for k in FLEET_KEYS}


def compare(base: list[dict], cand: list[dict]) -> dict:
    """The gate run's numbers: per-zone pooled scores, seeds better/worse, outcomes, time split, failures."""
    by_seed_b = {int(r["seed"]): r for r in base}
    by_seed_c = {int(r["seed"]): r for r in cand}
    zones, outcomes, time_split = {}, {}, {}
    for z in zones_in(list(base) + list(cand)):
        pb, pc = pooled_zone(base, z), pooled_zone(cand, z)
        better = worse = 0
        for s, rc in by_seed_c.items():
            rb = by_seed_b.get(s)
            if rb is None:
                continue
            sb, sc = seed_zone_score(rb, z), seed_zone_score(rc, z)
            if sb is None or sc is None:
                continue
            if sc > sb + 1e-12:
                better += 1
            elif sc < sb - 1e-12:
                worse += 1
        zones[z] = {"base": pb["score"], "cand": pc["score"], "delta": r3(pc["score"] - pb["score"]),
                    "seeds_better": better, "seeds_worse": worse}
        outcomes[z] = {"base": {k: pb[k] for k in COUNT_KEYS}, "cand": {k: pc[k] for k in COUNT_KEYS}}
        time_split[z] = {"base": mean_time_split(base, z), "cand": mean_time_split(cand, z)}
    fb, fc = failure_totals(base), failure_totals(cand)
    failures = {t: {"base": fb.get(t, 0), "cand": fc.get(t, 0)} for t in sorted(set(fb) | set(fc))
                if fb.get(t, 0) or fc.get(t, 0)}
    mb, mc = fleet_means(base), fleet_means(cand)
    fleet = {k: {"base": mb[k], "cand": mc[k]} for k in FLEET_KEYS}
    return {"zones": zones, "outcomes": outcomes, "time_split": time_split, "failures": failures, "fleet": fleet}


def summarize(results: list[dict]) -> dict:
    """One brain on one seed set: pooled zones, worst zone, its time split, failures (section A)."""
    zones = {z: pooled_zone(results, z) for z in zones_in(results)}
    worst = min(zones, key=lambda z: (zones[z]["score"], z)) if zones else None
    return {
        "seeds": sorted(int(r["seed"]) for r in results),
        "zones": zones,
        "worst_zone": worst,
        "worst_time_split": mean_time_split(results, worst) if worst else {},
        "failures": failure_totals(results),
        "failures_by_zone": failures_by_zone(results),
        "fleet": fleet_means(results),
    }
