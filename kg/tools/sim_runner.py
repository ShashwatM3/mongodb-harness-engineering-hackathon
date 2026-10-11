"""SimRunner: a synthetic twin with a known ground truth, for end-to-end simulation of the KG.

The saved fixtures only react to sim.STAIR_MIN_LIFT_QUEUE, so they can't show the KG telling a good
edit from a bad one on any other lever, nor a world that changes under the brain. This runner is a
closed-form model of the warehouse where several settings matter and the optimum is known, so a test
can check that the graph promotes what helps, rejects what hurts, and reverts when the world moves.

What it models (per seed, deterministic; the seed's jitter is the same for every brain, as in a real
twin with a fixed scenario, so a strictly better brain is better on every seed):
  sim.STAIR_MIN_LIFT_QUEUE  zone M: lift jams fall as the threshold drops, stair queues rise below 2;
                            best at 2 (world "v1") or 3 (world "stairs_slow", after a retune)
  sim.WAIT_BACKOFF_TICKS    deadlocks everywhere: fewest in [55, 70]; thrash below 50, slow above 120
  sim.CHARGE_AT_PCT         strandings when below 30
  class.HUM-1.max_speed     fewer late tasks when faster; safety events above 1.35 m/s
  assign.W_DISTANCE         a small gain in B and D at 0.5
  everything else           no effect (so a no-effect edit shows up as exactly that)

It refuses an unapproved locked edit with a 422 unless allow_locked is set, like the real runner,
and its patch_hash uses the same scheme as the KG's local compiler mirror.
"""
from __future__ import annotations

import random
from typing import Optional

from .. import registry
from ..contract import (Brain, BrainRejection, FAILURES_CAP_PER_TYPE, HealthResponse, RunShiftResponse)
from ..hashing import compile_patch, effective_edits, local_patch_hash, same_value
from ..runner import BrainRejected

ZONES = ["A", "B", "C", "D", "M"]
WORLDS = {
    "v1": {"spec_hash": "sim-spec-a1", "stair_cost": 1.0},
    "stairs_slow": {"spec_hash": "sim-spec-b2", "stair_cost": 5.0},  # the stairwell got a slower, safer gait
}


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


class SimRunner:
    def __init__(self, world: str = "v1", engine_sha: str = "sim-1", nondeterministic: bool = False):
        self.world = world
        self.engine_sha = engine_sha
        self.nondeterministic = nondeterministic
        self.calls: list[dict] = []
        self._settings = registry.by_target()

    # ── contract ────────────────────────────────────────────

    def retune(self, world: str):
        """WP-T retunes the spec: a new spec_hash, so results from before never mix with those after."""
        if world not in WORLDS:
            raise ValueError(f"unknown world {world!r}")
        self.world = world

    def health(self) -> HealthResponse:
        return HealthResponse(ok=True, engine_sha=self.engine_sha, spec_id="warehouse-sim",
                              spec_hash=WORLDS[self.world]["spec_hash"], mode="sim")

    def validate_brain(self, brain):
        return None  # the KG hashes locally; our patch_hash below uses the same scheme

    def settings(self):
        return None

    def run_shift(self, brain: Brain, seeds, ticks=None, profile=None, allow_locked=False, held_out=False):
        eff = {t: e["value"] for t, e in effective_edits(brain).items()}
        locked = self._locked(eff, brain)
        if locked and not allow_locked:
            raise BrainRejected(BrainRejection(error="locked_edits", message=f"locked edits without approval: "
                                               f"{', '.join(l['target'] for l in locked)}", locked_edits=locked))
        ticks, profile = ticks or 12000, profile or "standard"
        patch, _ = compile_patch(effective_edits(brain))
        self.calls.append({"seeds": list(seeds), "version": brain.version, "eff": eff, "held_out": held_out})
        per_seed = [self._seed_result(eff, int(s), ticks) for s in seeds]
        return RunShiftResponse(
            engine_sha=self.engine_sha, spec_id="warehouse-sim", spec_hash=WORLDS[self.world]["spec_hash"],
            brain_version=brain.version, patch_hash=local_patch_hash(patch), ticks=ticks, scenario_profile=profile,
            per_seed=per_seed, mean=self._mean(per_seed), pooled=self._pooled(per_seed),
            warnings=["sim runner: closed-form model, not a simulation"])

    # ── the world ───────────────────────────────────────────

    def _locked(self, eff, brain) -> list[dict]:
        approved = {(a.target, a.value) for a in brain.approvals}
        out = []
        for t, v in eff.items():
            s = self._settings.get(t)
            if s and s.status == "locked" and not same_value(v, s.v1) \
                    and not any(at == t and same_value(av, v) for at, av in approved):
                out.append({"target": t, "value": v, "baseline": s.v1, "node_id": None, "reason": "locked"})
        return out

    def _rates(self, eff: dict) -> dict:
        get = lambda t: eff.get(t, self._settings[t].engine_default)
        q = get("sim.STAIR_MIN_LIFT_QUEUE")
        stair_cost = WORLDS[self.world]["stair_cost"]
        # lift jams: everyone queues at q>=99; thresholds route more and more to the stairs
        jam = 0.30 if q >= 99 else 0.20 if q >= 4 else {3: 0.10, 2: 0.05, 1: 0.07, 0: 0.10}[int(q)]
        # stair queues: the stairwell fills up when the threshold is low; costlier stairs make that worse
        stairq = ({0: 0.30, 1: 0.10, 2: 0.03, 3: 0.01}.get(int(q), 0.0) if q < 4 else 0.0) * stair_cost
        b = get("sim.WAIT_BACKOFF_TICKS")
        deadlock = 0.04 if 55 <= b <= 70 else 0.06 if 70 < b <= 120 else 0.10 if b < 50 else 0.08 if b > 120 else 0.05
        charge = get("sim.CHARGE_AT_PCT")
        strand = 2 if charge < 30 else 0
        speed = get("class.HUM-1.max_speed")
        late_mult = (1.2 / speed) ** 1.5
        safety = max(0, round((speed - 1.35) * 20)) if speed > 1.35 else 0
        wdist = get("assign.W_DISTANCE")
        dispatch_gain = 0.03 if same_value(wdist, 0.5) else 0.0
        return {"jam": jam, "stairq": stairq, "deadlock": deadlock, "strand": strand, "late_mult": late_mult,
                "safety": safety, "dispatch_gain": dispatch_gain, "q": q, "stair_cost": stair_cost}

    def _seed_result(self, eff: dict, seed: int, ticks: int) -> dict:
        r = self._rates(eff)
        scn = random.Random(seed)                       # the scenario: the same for every brain, drawn up front
        scenario = {z: ((20 if z == "M" else 40) + scn.randint(-2, 2), 0.12 + 0.01 * scn.randint(-2, 2))
                    for z in ZONES}
        jit = random.Random(seed ^ 0xBEEF)              # ticks and robot ids of the failure entries
        zones, failures, counts = {}, [], {t: 0 for t in ("LIFT_QUEUE_JAM", "STAIR_QUEUE", "DEADLOCK_BACKOFF",
                                                             "LATE_TASK", "DROPPED_DEMAND", "BATTERY_STRANDING",
                                                             "HUMAN_REPLAN")}
        tick = jit.randint(200, 900)

        def fail(t, zone, detail, n):
            nonlocal tick
            for _ in range(int(n)):
                tick = (tick + jit.randint(150, 700)) % ticks or 1
                counts[t] += 1
                if counts[t] <= FAILURES_CAP_PER_TYPE:
                    failures.append({"type": t, "zone": zone, "tick": tick, "robots": [f"R{jit.randint(1, 12):02d}"],
                                     "detail": detail})

        for z in ZONES:
            offered, base_late = scenario[z]
            late_frac = base_late * r["late_mult"] + 0.5 * r["deadlock"]
            if z == "M":
                late_frac += r["jam"] + r["stairq"]
            if z in ("B", "D"):
                late_frac -= r["dispatch_gain"]
            if z in ("A", "B"):
                late_frac += 0.02 * r["strand"]
            if self.nondeterministic:            # a flaky twin: every other call runs 8% later
                late_frac += 0.08 if len(self.calls) % 2 else 0.0
            late = int(round(offered * _clamp(late_frac, 0, 0.9)))
            dropped = 1 if (z == "M" and r["jam"] >= 0.2) else 0
            on_time = offered - late - dropped
            safety = r["safety"] if z in ("A", "M") else 0
            score = on_time / max(1, offered) - 0.05 * safety
            lift_wait = _clamp(0.05 + r["jam"] * 0.6, 0, 0.5) if z == "M" else 0.01
            stairs = _clamp(0.02 + (0.25 if r["q"] < 4 else 0.0) * r["stair_cost"] / 2, 0, 0.4) if z == "M" else 0
            blocked = 0.05 + r["deadlock"]
            travel = max(0.1, 1 - lift_wait - stairs - blocked - 0.2 - (0.08 if z == "M" else 0))
            zones[z] = {"offered": offered, "on_time": on_time, "late": late, "failed": 0, "dropped": dropped,
                        "censored": 0, "safety_events": safety, "score": round(_clamp(score, 0, 1), 3),
                        "avg_task_s": 180 + int(60 * late_frac),
                        "time_split": {"travel": round(travel, 3), "lift_wait": round(lift_wait, 3),
                                       "lift_ride": 0.08 if z == "M" else 0, "stairs": round(stairs, 3),
                                       "blocked": round(blocked, 3), "pick_drop": 0.2}}
            fail("DEADLOCK_BACKOFF", z, "collision back-off fired", round(offered * r["deadlock"] * 0.5))
            fail("LATE_TASK", z, "finished after its deadline", max(0, late - 3))
        fail("LIFT_QUEUE_JAM", "M", f"robots queued at LIFT-1 (threshold {r['q']:g})", round(20 * r["jam"]))
        fail("STAIR_QUEUE", "M", "stairwell full", round(20 * r["stairq"]))
        fail("BATTERY_STRANDING", "A", "critical battery while loaded", r["strand"])
        if zones["M"]["dropped"]:
            fail("DROPPED_DEMAND", "M", "waiting queue full", 1)
        done = sum(z["on_time"] + z["late"] for z in zones.values())
        fleet = {"completed": done, "on_time_rate": round(sum(z["on_time"] for z in zones.values()) / max(1, done), 3),
                 "energy_kwh": round(1.5 + 0.02 * r["stairq"] * 100, 2),
                 "stair_trips": 0 if r["q"] >= 99 else int(40 / max(1, r["q"])) if r["q"] else 40,
                 "lift_trips": int(40 * r["jam"] / 0.3), "avg_lift_wait_s": round(60 * r["jam"], 1),
                 "battery_strandings": r["strand"]}
        return {"seed": seed, "ticks": ticks, "zones": zones, "fleet": fleet,
                "safety": {"human_proximity": 0, "near_misses": r["safety"], "separation_pushes": 2},
                "failures": failures, "failure_counts": counts, "scenario": []}

    @staticmethod
    def _pooled(per_seed: list[dict]) -> dict:
        from .. import metrics
        return {"zones": {z: metrics.pooled_zone(per_seed, z) for z in ZONES}}

    @staticmethod
    def _mean(per_seed: list[dict]) -> dict:
        n = max(1, len(per_seed))
        zones = {z: {"score": round(sum(r["zones"][z]["score"] for r in per_seed) / n, 3)} for z in ZONES}
        fleet = {k: round(sum(r["fleet"][k] for r in per_seed) / n, 3)
                 for k in ("on_time_rate", "completed", "stair_trips", "lift_trips", "avg_lift_wait_s")}
        return {"zones": zones, "fleet": fleet}

    # ── ground truth, for assertions ────────────────────────

    def truth_zone_m(self, eff: dict) -> float:
        """The expected zone M on-time share for a brain, to compare the KG's verdicts against."""
        r = self._rates(eff)
        return 1 - (0.12 * r["late_mult"] + 0.5 * r["deadlock"] + r["jam"] + r["stairq"])
