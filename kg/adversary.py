"""The adversary (document 07, idea 6): a second agent that writes scenario scripts on which the current brain
does much worse than some other known brain. It is rewarded for regret, not for raw failure (after PAIRED,
Dennis et al. 2020), so a scenario that every brain fails is "impossible", not a win. Accepted scenarios form a
curriculum that grows harder as the brain improves; one graduates once the current brain handles it.

    gate = kg.connect("gate")                       # a turn is trusted orchestration, like the gate
    adv = Adversary(gate, ClaudeProposer())         # or RandomProposer() / FixedProposer([...])
    adv.turn()                                      # against the latest version: propose, check, score, decide
    adv.graduate(V)                                 # after promote(): re-score the active scenarios against vV
    curriculum(kg)                                  # the active scenarios, for the next improvement epoch

The proposer (an LLM) sees only get_adversary_context(): it never touches the database or the runner. Its
memory is the `scenarios` collection itself, its last 10 scenarios with their outcomes (document 07, 3.6).

How a scenario is judged (thresholds calibrated with TwinForge's `npm run -s scenarios`, physical-ai README):
  score(b, s)   mean of brain b's pooled zone scores on script s, over the adversary's seeds (12 by default)
  regret(s)     the best alternative's score minus the current brain's
  accepted      regret >= 0.02 (the no-disruption noise floor is about 0.012 on 12 seeds), the best
                alternative ahead on at least 2/3 of the seeds, the current brain scoring below its quiet-shift
                score (a person blocking a zone *raises* scores in this twin, through a no-path artifact, so a
                scenario must hurt to count), and some brain scoring at least 0.35 (else "impossible")
  graduated     an active scenario whose regret against a newly promoted brain is below 0.01

Collections: scenarios (one per distinct script), adversary_turns, and heldout_stress (gate-only: the stress
set generated against v1, never in the curriculum, scored once at the end).
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import random
import re
import subprocess
import tempfile
import time
import uuid
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

from pymongo import ASCENDING, DESCENDING
from pymongo.errors import OperationFailure

from . import metrics
from .contract import Brain
from .core import KG, KGError, now
from .hashing import digest, same_value
from .raindrop_sink import ADVERSARY_EVENT, RaindropSink, sink_from_config
from .runner import RunnerError, ScenarioRejected

log = logging.getLogger("kg.adversary")

SCRIPT_KINDS = ("LIFT_FAULT", "HUMAN_INTRUSION", "TASK_BURST")
#: Scenario statuses. Only "accepted" is active (in the curriculum).
STATUSES = ("accepted", "too_easy", "impossible", "invalid", "graduated", "displaced")
ACTIVE = "accepted"
#: The empty script: a quiet shift, the baseline a scenario must push the current brain below
QUIET: list[dict] = []

#: The WP-T sweep's best zone-M variants of v1 (physical-ai README): the alternatives before any epoch has run
SWEEP_VARIANTS = [
    ("v1 + stairs at queue 1, no load on stairs", {"sim.STAIR_MIN_LIFT_QUEUE": 1, "sim.STAIR_MAX_LOAD": 0}),
    ("v1 + stairs at queue 2", {"sim.STAIR_MIN_LIFT_QUEUE": 2}),
    ("v1 + stairs at queue 1", {"sim.STAIR_MIN_LIFT_QUEUE": 1}),
]

# The envelope as TwinForge's scenario.ts has it (WP-C2), for runners without GET /scenario_envelope
FIRST_TICK, END_MARGIN, TICKS_PER_SECOND = 600, 1200, 10
DEFAULT_LIFTS = ["LIFT-1", "LIFT-2"]
DEFAULT_ZONES = ["A", "B", "C", "D", "M"]
LIMITS = {
    "LIFT_FAULT": {"max_per_shift": 2, "min_duration_ticks": 600, "max_duration_ticks": 3000, "max_down_at_once": 1},
    "HUMAN_INTRUSION": {"max_per_shift": 2, "min_duration_ticks": 600, "max_duration_ticks": 1800},
    "TASK_BURST": {"max_per_shift": 2, "min_count": 4, "max_count": 10, "priority": "HIGH"},
}
FIELDS = {
    "LIFT_FAULT": (["kind", "lift_id", "at_tick", "clear_at_tick"], [], ["at_tick", "clear_at_tick"]),
    "HUMAN_INTRUSION": (["kind", "zone_id", "at_tick", "duration_ticks"], [], ["at_tick", "duration_ticks"]),
    "TASK_BURST": (["kind", "at_tick", "count"], ["priority"], ["at_tick", "count"]),
}


# ── scripts: cleaning, normalizing, hashing (mirrors TwinForge's scenario.ts) ──

def stable_json(x: Any) -> str:
    """JSON with sorted keys and no spaces: the same bytes as TwinForge's stableStringify for scripts."""
    return json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def clean_script(raw: Any) -> Any:
    """A proposer's script as plain JSON: whole-number floats become ints, null fields go. Non-lists pass through
    (the check refuses them)."""
    if not isinstance(raw, list):
        return raw
    out = []
    for e in raw:
        if not isinstance(e, dict):
            out.append(e)
            continue
        d = {}
        for k, v in e.items():
            if v is None:
                continue
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            d[k] = v
        out.append(d)
    return out


def normalize_script(script: list[dict]) -> list[dict]:
    """Canonical form: fixed key order, defaults filled in, sorted by tick, then kind, then content."""
    canon = []
    for e in script:
        k = e.get("kind")
        if k == "LIFT_FAULT":
            canon.append({"kind": k, "lift_id": e["lift_id"], "at_tick": e["at_tick"], "clear_at_tick": e["clear_at_tick"]})
        elif k == "HUMAN_INTRUSION":
            canon.append({"kind": k, "zone_id": e["zone_id"], "duration_ticks": e["duration_ticks"], "at_tick": e["at_tick"]})
        elif k == "TASK_BURST":
            canon.append({"kind": k, "count": e["count"], "priority": e.get("priority", "HIGH"), "at_tick": e["at_tick"]})
        else:
            canon.append(dict(e))
    return sorted(canon, key=lambda e: (e["at_tick"], e["kind"], stable_json(e)))


def scenario_hash(normalized: list[dict]) -> str:
    """16 hex chars of SHA-256 over the key-sorted JSON: TwinForge's scenarioHash."""
    return hashlib.sha256(stable_json(normalized).encode("utf-8")).hexdigest()[:16]


def profile_of(h: str) -> str:
    return f"script:{h}"


def end_tick(e: dict) -> int:
    if e["kind"] == "LIFT_FAULT":
        return e["clear_at_tick"]
    if e["kind"] == "HUMAN_INTRUSION":
        return e["at_tick"] + e["duration_ticks"]
    return e["at_tick"]


def check_script_local(script: Any, ticks: int, lift_ids=DEFAULT_LIFTS, zone_ids=DEFAULT_ZONES) -> tuple[list, list]:
    """Python port of TwinForge's checkScript, for runners without POST /validate_scenario (the fake, the test
    stub). Returns (normalized script, problems). The runner's own check is authoritative when it has one."""
    if not isinstance(script, list):
        return [], [{"index": -1, "reason": "scenario_script must be an array of injections"}]
    lo, hi = FIRST_TICK, ticks - END_MARGIN
    problems, good = [], []
    is_int = lambda v: isinstance(v, int) and not isinstance(v, bool)
    for i, o in enumerate(script):
        def bad(reason, i=i):
            problems.append({"index": i, "reason": reason})
        if not isinstance(o, dict):
            bad("an injection must be an object")
            continue
        kind = o.get("kind")
        if kind not in FIELDS:
            bad(f"kind {json.dumps(kind)} is not allowed (allowed: {', '.join(SCRIPT_KINDS)})")
            continue
        req, opt, ints = FIELDS[kind]
        extra = [k for k in o if k not in req and k not in opt]
        if extra:
            bad(f"{kind} has unknown field(s) {', '.join(extra)} (fields: {', '.join(req + opt)})")
            continue
        missing = [k for k in req if o.get(k) is None]
        if missing:
            bad(f"{kind} is missing {', '.join(missing)}")
            continue
        not_int = [k for k in ints if not is_int(o[k])]
        if not_int:
            bad(f"{', '.join(not_int)} must be integer{'s' if len(not_int) > 1 else ''}")
            continue
        at = o["at_tick"]
        if not lo <= at <= hi:
            bad(f"at_tick {at} is outside [{lo}, {hi}]: start after the first minute and at least 2 minutes before the shift ends")
            continue
        L = LIMITS[kind]
        if kind == "LIFT_FAULT":
            if o["lift_id"] not in lift_ids:
                bad(f"lift_id {json.dumps(o['lift_id'])} is not a lift (lifts: {', '.join(lift_ids)})")
                continue
            d = o["clear_at_tick"] - at
            if not L["min_duration_ticks"] <= d <= L["max_duration_ticks"]:
                bad(f"a lift fault must last {L['min_duration_ticks']}–{L['max_duration_ticks']} ticks; this one lasts {d}")
                continue
            e = {"kind": kind, "lift_id": o["lift_id"], "at_tick": at, "clear_at_tick": o["clear_at_tick"]}
        elif kind == "HUMAN_INTRUSION":
            if o["zone_id"] not in zone_ids:
                bad(f"zone_id {json.dumps(o['zone_id'])} is not a zone (zones: {', '.join(zone_ids)})")
                continue
            d = o["duration_ticks"]
            if not L["min_duration_ticks"] <= d <= L["max_duration_ticks"]:
                bad(f"an intrusion must last {L['min_duration_ticks']}–{L['max_duration_ticks']} ticks; this one lasts {d}")
                continue
            e = {"kind": kind, "zone_id": o["zone_id"], "duration_ticks": d, "at_tick": at}
        else:
            n = o["count"]
            if not L["min_count"] <= n <= L["max_count"]:
                bad(f"a burst must have {L['min_count']}–{L['max_count']} tasks; this one has {n}")
                continue
            if o.get("priority", "HIGH") != "HIGH":
                bad('a burst\'s priority must be "HIGH"')
                continue
            e = {"kind": kind, "count": n, "priority": "HIGH", "at_tick": at}
        if end_tick(e) > ticks:
            bad(f"it ends at tick {end_tick(e)}, after the shift ends at {ticks}")
            continue
        good.append((i, e))
    seen: list[tuple[int, dict]] = []
    for i, e in sorted(good, key=lambda x: (x[1]["at_tick"], x[0])):
        k = e["kind"]
        if sum(1 for _, y in seen if y["kind"] == k) >= LIMITS[k]["max_per_shift"]:
            problems.append({"index": i, "reason": f"at most {LIMITS[k]['max_per_shift']} {k} per shift"})
        overlaps = lambda y: y["kind"] == k and y["at_tick"] < end_tick(e) and e["at_tick"] < end_tick(y)
        if k == "LIFT_FAULT":
            clash = next((j for j, y in seen if overlaps(y)), None)
            if clash is not None:
                problems.append({"index": i, "reason": f"overlaps the lift fault at index {clash}: at most 1 lift may be down at a time"})
        elif k == "HUMAN_INTRUSION":
            clash = next((j for j, y in seen if overlaps(y) and y["zone_id"] == e["zone_id"]), None)
            if clash is not None:
                problems.append({"index": i, "reason": f"overlaps the intrusion in zone {e['zone_id']} at index {clash}"})
        seen.append((i, e))
    if problems:
        return [], sorted(problems, key=lambda p: p["index"])
    return normalize_script([e for _, e in good]), []


def default_envelope(ticks: int) -> dict:
    """The envelope as data and sentences, like GET /scenario_envelope, for runners without it."""
    return {
        "ticks": ticks, "ticks_per_second": TICKS_PER_SECOND, "min_at_tick": FIRST_TICK, "max_at_tick": ticks - END_MARGIN,
        "kinds": {"LIFT_FAULT": {**LIMITS["LIFT_FAULT"], "lift_ids": DEFAULT_LIFTS},
                  "HUMAN_INTRUSION": {**LIMITS["HUMAN_INTRUSION"], "zone_ids": DEFAULT_ZONES},
                  "TASK_BURST": dict(LIMITS["TASK_BURST"])},
        "rules": [
            "A script is a list of at most 6 injections; the same script runs on every seed, and only demand changes with the seed.",
            f"Every at_tick is an integer in [{FIRST_TICK}, {ticks - END_MARGIN}] (ticks; 10 ticks = 1 s; the shift is {ticks} ticks), and every injection ends by tick {ticks}.",
            f"LIFT_FAULT {{kind, lift_id, at_tick, clear_at_tick}}: at most 2 per shift, each lasting 600–3000 ticks (clear_at_tick − at_tick); lift_id is one of {', '.join(DEFAULT_LIFTS)}; never more than 1 lift down at a time (fault windows must not overlap).",
            f"HUMAN_INTRUSION {{kind, zone_id, at_tick, duration_ticks}}: at most 2 per shift, each lasting 600–1800 ticks; zone_id is one of {', '.join(DEFAULT_ZONES)}; two intrusions in the same zone must not overlap.",
            'TASK_BURST {kind, at_tick, count, priority?}: at most 2 per shift, each of 4–10 tasks drawn from the normal demand mix (no zone); priority is "HIGH", the default.',
            "No other kinds and no other fields.",
        ],
    }


def clock(tick: int) -> str:
    s = int(tick) // TICKS_PER_SECOND
    return f"{s // 60:02d}:{s % 60:02d}"


def describe_script(script: Any) -> str:
    """One line a person can read: "LIFT-1 down 08:00–11:00; burst of 8 at 12:00". Tolerates malformed scripts."""
    if not isinstance(script, list):
        return str(script)[:200]
    if not script:
        return "no disruptions (a quiet shift)"
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    at = lambda v: clock(v) if num(v) is not None else "?"
    parts = []
    for e in script:
        if not isinstance(e, dict):
            parts.append(str(e)[:40])
            continue
        k, a = e.get("kind"), num(e.get("at_tick"))
        if k == "LIFT_FAULT":
            parts.append(f"{e.get('lift_id')} down {at(a)}–{at(e.get('clear_at_tick'))}")
        elif k == "HUMAN_INTRUSION":
            d = num(e.get("duration_ticks"))
            parts.append(f"person in zone {e.get('zone_id')} {at(a)}–{at(a + d) if a is not None and d is not None else '?'}")
        elif k == "TASK_BURST":
            parts.append(f"burst of {e.get('count')} at {at(a)}")
        else:
            parts.append(f"{k} at {at(a)}")
    return "; ".join(parts)


def kinds_of(script: Any) -> list[str]:
    if not isinstance(script, list):
        return []
    return sorted({e.get("kind") for e in script if isinstance(e, dict) and isinstance(e.get("kind"), str)})


def r4(x: float) -> float:
    return round(float(x) + 0.0, 4)


def event_uuid(*parts: Any) -> str:
    return str(uuid.UUID(hex=digest(list(parts), 32)))


# ── runners and KG views for scripted runs ──────────────────

class ScriptedRunner:
    """A runner that runs every shift with one scenario script (WP-C2) in place of the profile; everything else
    delegates. With it, a KG whose env profile is "script:<hash>" can record_proposal / evaluate as usual."""

    def __init__(self, base, script: list[dict]):
        self.base, self.script = base, script

    def health(self):
        return self.base.health()

    def settings(self):
        return self.base.settings()

    def validate_brain(self, brain):
        return self.base.validate_brain(brain)

    def validate_scenario(self, script, ticks=None):
        return self.base.validate_scenario(script, ticks)

    def scenario_envelope(self, ticks=None):
        return self.base.scenario_envelope(ticks)

    def run_shift(self, brain, seeds, ticks=None, profile=None, allow_locked=False, held_out=False, scenario_script=None):
        return self.base.run_shift(brain, seeds, ticks, None, allow_locked, held_out, scenario_script=self.script)


def adversary_sink(kg: KG):
    """The adversary's own events go where the KG's go, as user "kg-adversary". They carry against_version,
    never brain_version, so they can't fall into the v1-vs-vN Experiment's cohorts."""
    if isinstance(kg.sink, RaindropSink):
        _, project = kg.cfg.raindrop_target()
        return RaindropSink(kg.cfg.raindrop_write_key, user_id="kg-adversary", project_id=project)
    return kg.sink


def scripted_sink(kg: KG):
    """Evaluation events of gate runs measured on a script go to the dev project only (or nowhere): they differ
    from standard-profile runs only in env_key, and the real project's cohorts filter on brain_version."""
    if isinstance(kg.sink, RaindropSink):
        return sink_from_config(kg.cfg, dev=True)
    return kg.sink


def scenario_kg(kg: KG, script: list[dict], h: str, sink=None, runner=None) -> KG:
    """The same database and role, with the env's profile set to "script:<hash>" and a runner that sends the
    script: shifts, gate runs and caches for this scenario never mix with the standard profile's."""
    env = kg.env.model_copy(update={"profile": profile_of(h)})
    skg = KG(kg.db, kg.role, sink=sink if sink is not None else scripted_sink(kg),
             runner=ScriptedRunner(runner or kg.runner, script), env=env, config=kg.cfg, settings=kg.settings)
    skg._validation_cache = kg._validation_cache  # a brain's patch hash doesn't depend on the scenario
    return skg


def ensure_adversary_schema(db) -> None:
    """Indexes for the adversary's collections (idempotent). Collections are created on first write."""
    from .db import INDEXES
    for coll in ("scenarios", "adversary_turns", "epochs", "heldout_stress"):
        for keys in INDEXES.get(coll, []):
            db[coll].create_index(keys)


# ── brains and scores ───────────────────────────────────────

@dataclass
class BrainRef:
    label: str
    brain: Brain
    patch_hash: str
    version: Optional[int] = None


@dataclass
class Scored:
    """One brain on one script, over the adversary's seeds."""
    score: float                      # mean of the pooled zone scores
    zones: dict[str, float]           # pooled zone scores
    per_seed: dict[int, float]        # seed -> mean of that seed's zone scores
    failures: dict[str, int]          # uncapped totals
    results: list[dict] = field(default_factory=list, repr=False)  # raw SeedResults (for context; not stored)

    def to_doc(self) -> dict:
        return {"score": r4(self.score), "zones": self.zones, "per_seed": {str(k): r4(v) for k, v in self.per_seed.items()},
                "failures": {k: v for k, v in self.failures.items() if v}}


def scored_from(resp) -> Scored:
    zones = {z: float(p.score) for z, p in resp.pooled.zones.items()}
    per_seed = {}
    results = []
    for r in resp.per_seed:
        d = r.model_dump(mode="json")
        results.append(d)
        zs = [float(v["score"]) for v in d["zones"].values()]
        per_seed[int(r.seed)] = sum(zs) / len(zs) if zs else 0.0
    return Scored(score=sum(zones.values()) / len(zones) if zones else 0.0, zones=zones, per_seed=per_seed,
                  failures=metrics.failure_totals(results), results=results)


@dataclass
class AdversaryConfig:
    seeds: Optional[list[int]] = None   # None: the KG's training seeds
    m: int = 4                          # scripts per turn
    max_alternatives: int = 3
    accept_regret: float = 0.02
    agree_frac: float = 2 / 3
    floor: float = 0.35
    graduate_regret: float = 0.01
    cap: int = 6
    require_harm: bool = True
    memory: int = 10                    # past scenarios shown to the proposer
    parallel: int = 4                   # concurrent /run_shift requests

    @classmethod
    def from_env(cls) -> "AdversaryConfig":
        c = cls()
        raw = os.getenv("KG_ADV_SEEDS", "").strip()
        if raw:
            c.seeds = parse_seeds(raw)
        for name, cast in (("m", int), ("max_alternatives", int), ("accept_regret", float), ("agree_frac", float),
                           ("floor", float), ("graduate_regret", float), ("cap", int), ("memory", int), ("parallel", int)):
            v = os.getenv(f"KG_ADV_{name.upper()}")
            if v:
                setattr(c, name, cast(v))
        if os.getenv("KG_ADV_REQUIRE_HARM") in ("0", "false", "no"):
            c.require_harm = False
        return c


def parse_seeds(raw: str) -> list[int]:
    """"101-112" or "101,102,105" or a mix."""
    out: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = (int(x) for x in part.split("-", 1))
            out.extend(range(a, b + 1))
        else:
            out.append(int(part))
    return out


# ── proposers ───────────────────────────────────────────────

class ProposerError(RuntimeError):
    pass


@dataclass
class Proposals:
    scenarios: list[dict]               # [{"script": [...], "rationale": "..."}]
    proposer: str
    model: Optional[str] = None
    usage: dict = field(default_factory=dict)
    seconds: float = 0.0
    raw: Any = None


class Proposer(Protocol):
    name: str

    def propose(self, context: dict, m: int) -> Proposals: ...


class FixedProposer:
    """Hand-written scripts, one batch per call (tests, demos, the calibration scenarios)."""
    name = "hand"

    def __init__(self, batches: list[list[dict]]):
        self.batches = list(batches)

    def propose(self, context, m):
        if not self.batches:
            raise ProposerError("FixedProposer has no batches left")
        batch = self.batches.pop(0)
        return Proposals([{"script": s.get("script", s) if isinstance(s, dict) else s,
                           "rationale": s.get("rationale", "hand-written") if isinstance(s, dict) else "hand-written"}
                          for s in batch][:m], self.name)


class RandomProposer:
    """In-envelope random scripts: the no-LLM baseline (and a fallback). Deterministic per seed and turn."""
    name = "random"

    def __init__(self, seed: int = 0):
        self.seed = seed

    def propose(self, context, m):
        data = context["data"]
        rng = random.Random(f"{self.seed}:{data['turn']}")
        env = data["envelope"]
        return Proposals([{"script": random_script(rng, env), "rationale": "random in-envelope script (baseline)"}
                          for _ in range(m)], self.name)


def random_script(rng: random.Random, env: dict) -> list[dict]:
    ticks, lo, hi = env["ticks"], env["min_at_tick"], env["max_at_tick"]
    K = env["kinds"]
    out: list[dict] = []
    n_f, n_h, n_b = rng.randint(0, 2), rng.randint(0, 2), rng.randint(0, 2)
    if n_f + n_h + n_b == 0:
        n_f = 1
    t = lo
    for _ in range(n_f):  # faults one after another, never overlapping
        if t > hi:
            break
        at = rng.randint(t, min(hi, t + 3000))
        d = rng.randint(K["LIFT_FAULT"]["min_duration_ticks"], K["LIFT_FAULT"]["max_duration_ticks"])
        d = min(d, ticks - at)
        if d < K["LIFT_FAULT"]["min_duration_ticks"]:
            break
        out.append({"kind": "LIFT_FAULT", "lift_id": rng.choice(K["LIFT_FAULT"]["lift_ids"]), "at_tick": at, "clear_at_tick": at + d})
        t = at + d
    zones = rng.sample(K["HUMAN_INTRUSION"]["zone_ids"], k=min(n_h, len(K["HUMAN_INTRUSION"]["zone_ids"])))
    for z in zones:  # different zones, so they may overlap
        at = rng.randint(lo, hi)
        d = min(rng.randint(K["HUMAN_INTRUSION"]["min_duration_ticks"], K["HUMAN_INTRUSION"]["max_duration_ticks"]), ticks - at)
        if d >= K["HUMAN_INTRUSION"]["min_duration_ticks"]:
            out.append({"kind": "HUMAN_INTRUSION", "zone_id": z, "at_tick": at, "duration_ticks": d})
    for _ in range(n_b):
        out.append({"kind": "TASK_BURST", "at_tick": rng.randint(lo, hi),
                    "count": rng.randint(K["TASK_BURST"]["min_count"], K["TASK_BURST"]["max_count"])})
    return out


ADVERSARY_SYSTEM = """You are the adversary in a two-agent self-improvement loop for a fleet of legged warehouse robots in a deterministic digital twin. The other agent, the improver, edits the fleet's "brain" (typed settings) to raise on-time scores. You write disruption scripts (scenarios) that expose where the CURRENT brain is weak, so the improver has something real to learn next.

You are scored on regret: how much better the best OTHER known brain does than the current brain on your scenario, measured over 12 seeded shifts with the same script. Breaking everything earns nothing. A scenario is rejected as:
- impossible, when no known brain does well on it;
- too easy, when no other brain clearly beats the current one (regret under 0.02, or the better brain wins on fewer than 2/3 of the seeds);
- not an attack (also "too easy"), when it does not lower the current brain's score below a quiet shift with no disruptions;
- invalid, when it breaks the rules below.
Good scenarios target one decision the current brain gets wrong and another brain gets right.

How the twin works:
- Zones A, B, C and D are on the ground floor; zone M is the mezzanine (floor 2). Tasks to or from zone M change floors.
- Robots change floors by two freight lifts (LIFT-1 and LIFT-2, both on the east side) or by the west stairwell, whose ground-floor end is in zone C. A climb costs 24 s plus 4 s per tote carried, and at most 2 robots climb at once.
- The brain's main floor-change rule is sim.STAIR_MIN_LIFT_QUEUE: a robot takes the stairs when at least that many other robots are already committed to the best lift (99 means lifts only). sim.STAIR_MAX_LOAD limits the load a robot may carry up the stairs.
- A shift is 12000 ticks: 20 minutes, 10 ticks per second. A zone's score is its on-time tasks over its scored tasks, minus a safety penalty; a brain's score is the mean over the five zones.
- A known twin artifact: a person blocking a zone makes robots with no path work where they stand, which raises scores. A scenario built only from intrusions therefore rarely lowers the current brain's score; combine disruptions.

Use the exact field names from the rules. Give every scenario a one-sentence rationale naming the decision you attack and why another brain handles it better. Learn from your past scenarios: repeat what was accepted in new variations, and change what was too easy, impossible or invalid."""


def proposal_schema() -> dict:
    entry = {"type": "object", "additionalProperties": False, "required": ["kind", "at_tick"], "properties": {
        "kind": {"type": "string", "enum": list(SCRIPT_KINDS)},
        "lift_id": {"type": "string"}, "zone_id": {"type": "string"},
        "at_tick": {"type": "integer"}, "clear_at_tick": {"type": "integer"},
        "duration_ticks": {"type": "integer"}, "count": {"type": "integer"}}}
    scenario = {"type": "object", "additionalProperties": False, "required": ["rationale", "script"], "properties": {
        "rationale": {"type": "string"}, "script": {"type": "array", "items": entry}}}
    return {"type": "object", "additionalProperties": False, "required": ["scenarios"],
            "properties": {"scenarios": {"type": "array", "items": scenario}}}


class ClaudeProposer:
    """Claude through a headless Claude Code call (`claude -p`) on the user's subscription: no tools, no MCP, no
    project context, structured output checked against proposal_schema(). Swap in an Anthropic SDK backend when
    an API key is available; the prompt and the output shape stay the same."""
    name = "claude"

    def __init__(self, model: Optional[str] = None, effort: Optional[str] = None, timeout: float = 600.0,
                 cli: Optional[str] = None, retries: int = 1):
        self.model = model or os.getenv("KG_ADVERSARY_MODEL", "claude-opus-5-5")
        self.effort = effort or os.getenv("KG_ADVERSARY_EFFORT", "high")
        self.timeout, self.retries = timeout, retries
        self.cli = cli or os.getenv("KG_ADVERSARY_CLI", "claude")

    def command(self) -> list[str]:
        return [self.cli, "-p", "--model", self.model, "--effort", self.effort, "--output-format", "json",
                "--json-schema", json.dumps(proposal_schema()), "--tools", "", "--safe-mode", "--strict-mcp-config",
                "--no-session-persistence", "--permission-prompts", "none", "--system-prompt", ADVERSARY_SYSTEM]

    def propose(self, context, m):
        prompt = (context["markdown"] + f"\n\n## Your task\nPropose exactly {m} scenario scripts against the current "
                  "brain, each with a one-sentence rationale. Every script must follow the rules above.")
        last: Optional[Exception] = None
        for _ in range(self.retries + 1):
            t0 = time.monotonic()
            try:
                with tempfile.TemporaryDirectory(prefix="kg-adversary-") as cwd:  # no project files, no CLAUDE.md
                    p = subprocess.run(self.command(), input=prompt, text=True, capture_output=True,
                                       timeout=self.timeout, cwd=cwd)
                if p.returncode != 0:
                    raise ProposerError(f"claude exited {p.returncode}: {(p.stderr or p.stdout).strip()[-400:]}")
                out = json.loads(p.stdout)
                so = out.get("structured_output")
                if out.get("is_error") or not isinstance(so, dict) or not isinstance(so.get("scenarios"), list):
                    raise ProposerError(f"no structured output: {str(out.get('result') or out)[:400]}")
                usage = out.get("modelUsage") or {}
                model = max(usage, key=lambda k: usage[k].get("outputTokens", 0)) if usage else self.model
                scen = [{"script": clean_script(s.get("script")), "rationale": str(s.get("rationale") or "")}
                        for s in so["scenarios"] if isinstance(s, dict)][:m]
                return Proposals(scen, self.name, model=model, seconds=round(time.monotonic() - t0, 1), raw=so,
                                 usage={"cost_usd": out.get("total_cost_usd"), "duration_ms": out.get("duration_ms"),
                                        "output_tokens": (out.get("usage") or {}).get("output_tokens")})
            except (ProposerError, json.JSONDecodeError, subprocess.TimeoutExpired, OSError) as e:
                last = e
                log.warning("adversary proposer failed: %s", e)
        raise ProposerError(str(last))


# ── the adversary ───────────────────────────────────────────

class Adversary:
    """One instance per gate client. Every turn, re-score and stress-set operation is recorded in Atlas."""

    def __init__(self, kg: KG, proposer: Optional[Proposer] = None, config: Optional[AdversaryConfig] = None, *,
                 sink=None, runner=None):
        kg._require_gate("the adversary (it writes scenarios and heldout_stress)")
        self.kg = kg
        self.runner = runner or kg.runner
        if self.runner is None:
            raise KGError("the adversary needs a runner: kg.use_runner(...) first")
        self.cfg = config or AdversaryConfig.from_env()
        self.seeds = sorted(set(self.cfg.seeds or kg.seed_sets["train"]))
        self.ticks = kg.env.ticks
        self.proposer: Proposer = proposer or RandomProposer()
        self.sink = sink if sink is not None else adversary_sink(kg)
        self._envelope: Optional[dict] = None
        self._quiet: dict[str, Scored] = {}
        ensure_adversary_schema(kg.db)

    def c(self, name: str):
        return self.kg.c(name)

    # ── envelope and checks ──

    def envelope(self) -> dict:
        """The runner's envelope (GET /scenario_envelope), or the built-in copy for runners without it."""
        if self._envelope is None:
            env = None
            try:
                env = self.runner.scenario_envelope(self.ticks)
            except (AttributeError, RunnerError) as e:
                log.info("no scenario envelope from the runner (%s); using the built-in copy", e)
            self._envelope = env.model_dump(mode="json") if env is not None else default_envelope(self.ticks)
        return self._envelope

    def check(self, raw: Any) -> dict:
        """{"ok", "script" (normalized), "hash"} or {"ok": False, "problems"}; the runner's check when it has one."""
        script = clean_script(raw)
        v = None
        try:
            v = self.runner.validate_scenario(script, self.ticks) if isinstance(script, list) else None
        except AttributeError:
            v = None
        if v is not None:
            if not v.ok:
                return {"ok": False, "problems": [p.model_dump(mode="json") for p in v.rejected], "script": script}
            return {"ok": True, "script": v.scenario_script, "hash": v.scenario_hash, "checked_by": "runner"}
        env = self.envelope()
        norm, problems = check_script_local(script, self.ticks, env["kinds"]["LIFT_FAULT"].get("lift_ids", DEFAULT_LIFTS),
                                            env["kinds"]["HUMAN_INTRUSION"].get("zone_ids", DEFAULT_ZONES))
        if problems:
            return {"ok": False, "problems": problems, "script": script}
        return {"ok": True, "script": norm, "hash": scenario_hash(norm), "checked_by": "local"}

    # ── brains ──

    def brain_ref(self, V: int) -> BrainRef:
        b = self.kg.export_brain(V)
        return BrainRef(label=f"v{V}", brain=b, patch_hash=self.kg.validate(b).patch_hash, version=V)

    def variant(self, label: str, edits: dict[str, float]) -> BrainRef:
        b = self.kg._apply_edits(self.kg.export_brain(1), edits, {"source": "sweep", "ref": "WP-T"})
        b.version = 0  # not a brain version: the runner echoes it into shifts and events
        return BrainRef(label=label, brain=b, patch_hash=self.kg.validate(b).patch_hash)

    def alternatives(self, cur: BrainRef) -> list[BrainRef]:
        """A: v1 and the version before the current one, then the WP-T sweep's best variants; distinct patch
        hashes, never the current brain, at most max_alternatives (document 07, section 3.3)."""
        cands: list[BrainRef] = []
        versions = sorted(d["version"] for d in self.c("brain_versions").find({"status": {"$ne": "pending"}}, {"version": 1}))
        if cur.version != 1 and 1 in versions:
            cands.append(self.brain_ref(1))
        prev = [v for v in versions if cur.version is not None and v < cur.version and v != 1]
        if prev:
            cands.append(self.brain_ref(prev[-1]))
        cands += [self.variant(label, edits) for label, edits in SWEEP_VARIANTS]
        out, seen = [], {cur.patch_hash}
        for r in cands:
            if r.patch_hash not in seen:
                seen.add(r.patch_hash)
                out.append(r)
        return out[: self.cfg.max_alternatives]

    def settings_diff(self, a: BrainRef, b: BrainRef) -> list[str]:
        """Settings where brain a differs from brain b, as "target value (b: value)"."""
        env = self.kg._envelope()
        ea, eb = self.kg.validate(a.brain).effective, self.kg.validate(b.brain).effective
        out = []
        for t in sorted(set(ea) | set(eb)):
            va = ea.get(t, {}).get("value", (env.get(t) or {}).get("engine_default"))
            vb = eb.get(t, {}).get("value", (env.get(t) or {}).get("engine_default"))
            if not same_value(va, vb):
                out.append(f"{t} {va:g} ({b.label}: {vb:g})" if isinstance(va, (int, float)) and isinstance(vb, (int, float))
                           else f"{t} {va} ({b.label}: {vb})")
        return out

    # ── running ──

    def _run(self, ref: BrainRef, script: Optional[list[dict]], held_out: bool = False):
        if script is None:  # the KG's own profile (the standard exam)
            return self.runner.run_shift(ref.brain, self.seeds, self.ticks, self.kg.env.profile, allow_locked=True,
                                         held_out=held_out)
        return self.runner.run_shift(ref.brain, self.seeds, self.ticks, None, allow_locked=True, held_out=held_out,
                                     scenario_script=script)

    def score_brains(self, refs: list[BrainRef], script: Optional[list[dict]], h: Optional[str], *,
                     held_out: bool = False, record: bool = True) -> dict[str, Scored]:
        """Every brain on one script (or the KG's profile when script is None), in parallel. Recorded in
        `shifts` under the script's env unless held_out (the stress set never enters the KG)."""
        with ThreadPoolExecutor(max_workers=max(1, self.cfg.parallel)) as pool:
            resps = list(pool.map(lambda r: self._run(r, script, held_out), refs))
        out = {}
        target = None
        if record and not held_out:
            target = self.kg if script is None else scenario_kg(self.kg, script, h, runner=self.runner)
        for ref, resp in zip(refs, resps):
            if target is not None:
                target.record_shifts(resp, "train", brain=ref.brain)
            out[ref.label] = scored_from(resp)
        return out

    def quiet(self, cur: BrainRef) -> Scored:
        """The current brain on a quiet shift (no disruptions): the bar a scenario must push it below."""
        if cur.patch_hash not in self._quiet:
            self._quiet[cur.patch_hash] = self.score_brains([cur], QUIET, scenario_hash(QUIET))[cur.label]
        return self._quiet[cur.patch_hash]

    def judge(self, cur: BrainRef, scored: dict[str, Scored], quiet: Scored) -> dict:
        """Regret against the best alternative and the acceptance rules, in the order of document 07's table."""
        mine = scored[cur.label]
        alts = {k: v for k, v in scored.items() if k != cur.label}
        best = max(alts, key=lambda k: (alts[k].score, k)) if alts else None
        b = alts[best] if best else mine
        n = len(self.seeds)
        agree = sum(1 for s in self.seeds if b.per_seed.get(s, 0.0) > mine.per_seed.get(s, 0.0) + 1e-12)
        need = math.ceil(self.cfg.agree_frac * n - 1e-9)
        regret, harm = r4(b.score - mine.score), r4(quiet.score - mine.score)
        top = max([mine.score] + [v.score for v in alts.values()])
        if top < self.cfg.floor:
            status, reason = "impossible", f"no known brain does well: the best scores {top:.3f} (< {self.cfg.floor})"
        elif regret < self.cfg.accept_regret:
            status, reason = "too_easy", f"regret {regret:+.3f} is below {self.cfg.accept_regret} (best other: {best})"
        elif agree < need:
            status, reason = "too_easy", f"{best} is ahead on only {agree} of {n} seeds (needs {need})"
        elif self.cfg.require_harm and harm <= 0:
            status, reason = "too_easy", (f"not an attack: {cur.label} scores {mine.score:.3f} here, "
                                          f"{-harm:.3f} above a quiet shift ({quiet.score:.3f})")
        else:
            status, reason = "accepted", (f"{best} beats {cur.label} by {regret:.3f} on {agree} of {n} seeds; "
                                          f"{cur.label} loses {harm:.3f} against a quiet shift")
        return {"status": status, "reason": reason, "regret": regret, "harm": harm, "best": best,
                "agree": agree, "n_seeds": n, "top": r4(top)}

    # ── one scenario ──

    def consider(self, raw: Any, rationale: str, cur: BrainRef, alts: list[BrainRef], *, turn: int, epoch: int,
                 proposer: str, stress: Optional[set] = None) -> dict:
        """Check, deduplicate, score and decide one proposed script; writes `scenarios` and Raindrop."""
        chk = self.check(raw)
        at = now()
        prop = {"turn": turn, "epoch": epoch, "against_version": cur.version, "against": cur.patch_hash,
                "proposer": proposer, "rationale": rationale, "at": at}
        if not chk["ok"]:
            sid = "sc-bad-" + digest(stable_json(chk["script"]), 16)
            have = self.c("scenarios").find_one({"_id": sid}, {"proposals": 1})
            self.c("scenarios").update_one({"_id": sid}, {
                "$setOnInsert": {"scenario_hash": None, "script": chk["script"], "kinds": kinds_of(chk["script"]),
                                 "description": describe_script(chk["script"]),
                                 "rationale": rationale, "status": "invalid", "problems": chk["problems"],
                                 "reason": "; ".join(f"[{p['index']}] {p['reason']}" for p in chk["problems"]),
                                 "regret": None, "evals": [], "regret_history": [], "created_at": at},
                "$set": {"updated_at": at}, "$push": {"proposals": {**prop, "outcome": "cached" if have else "new"}}},
                upsert=True)
            outcome = {"scenario_id": sid, "status": "cached" if have else "invalid", "reason": "; ".join(p["reason"] for p in chk["problems"])}
            self._emit(sid, turn, "proposed", {"status": "invalid", "scenario_hash": "", "kinds": kinds_of(chk["script"])},
                       cur, epoch, proposer, ["re_proposed", "scenario_invalid"] if have else ["scenario_invalid"],
                       attempt=len(have.get("proposals", [])) if have else 0)
            return outcome
        script, h = chk["script"], chk["hash"]
        sid = "sc-" + h
        if stress and h in stress:
            return {"scenario_id": None, "status": "withheld", "reason": "matches a held-out stress scenario"}
        doc = self.c("scenarios").find_one({"_id": sid})
        if doc and any(e["against"] == cur.patch_hash for e in doc.get("evals", [])):
            self.c("scenarios").update_one({"_id": sid}, {"$push": {"proposals": {**prop, "outcome": "cached"}},
                                                          "$set": {"updated_at": at}})
            e = next(e for e in reversed(doc["evals"]) if e["against"] == cur.patch_hash)
            self._emit(sid, turn, "proposed", {"status": doc["status"], "scenario_hash": h, "regret": e["regret"],
                                               "kinds": doc.get("kinds")}, cur, epoch, proposer, ["re_proposed"],
                       attempt=len(doc.get("proposals", [])))
            return {"scenario_id": sid, "status": "cached", "regret": e["regret"], "kept_status": doc["status"],
                    "reason": "already measured against this brain"}
        scored = self.score_brains([cur] + alts, script, h)
        verdict = self.judge(cur, scored, self.quiet(cur))
        status = self._transition(doc, verdict)
        ev = {"against": cur.patch_hash, "against_version": cur.version, "at": at, "turn": turn, "epoch": epoch,
              "phase": "proposed", "seeds": self.seeds, "regret": verdict["regret"], "harm": verdict["harm"],
              "best": verdict["best"], "agree": verdict["agree"], "status": status, "reason": verdict["reason"],
              "scores": {k: v.to_doc() for k, v in scored.items()},
              "patch_hashes": {r.label: r.patch_hash for r in [cur] + alts}}
        self._write_eval(sid, h, script, rationale, doc, ev, status, verdict, prop, cur)
        displaced = self._enforce_cap(sid) if status == ACTIVE else []
        signals = {"accepted": ["scenario_accepted"], "too_easy": ["scenario_too_easy"],
                   "impossible": ["scenario_impossible"], "graduated": ["scenario_graduated"]}.get(status, [])
        self._emit(sid, turn, "proposed", {"status": status, "scenario_hash": h, "regret": verdict["regret"],
                                           "harm": verdict["harm"], "best_alternative": verdict["best"],
                                           "seeds_favouring": verdict["agree"], "kinds": kinds_of(script)},
                   cur, epoch, proposer, signals)
        return {"scenario_id": sid, "status": status, "regret": verdict["regret"], "harm": verdict["harm"],
                "best": verdict["best"], "agree": verdict["agree"], "reason": verdict["reason"],
                "description": describe_script(script), "displaced": displaced}

    def _transition(self, doc: Optional[dict], verdict: dict) -> str:
        """An active scenario re-measured against a new brain graduates or stays active; anything else is decided
        afresh (a graduated or rejected scenario can come back: the brain may have forgotten how to handle it)."""
        if doc and doc.get("status") == ACTIVE:
            return "graduated" if verdict["regret"] < self.cfg.graduate_regret else ACTIVE
        return verdict["status"]

    def _write_eval(self, sid, h, script, rationale, doc, ev, status, verdict, prop, cur):
        at = ev["at"]
        upd = {"$set": {"status": status, "regret": verdict["regret"], "harm": verdict["harm"], "reason": verdict["reason"],
                        "against": {"version": cur.version, "patch_hash": cur.patch_hash}, "best_alternative": verdict["best"],
                        "updated_at": at},
               "$push": {"evals": ev, "regret_history": {"version": cur.version, "regret": verdict["regret"],
                                                         "status": status, "phase": ev["phase"], "turn": ev["turn"],
                                                         "epoch": ev["epoch"], "at": at}}}
        if prop is not None:
            upd["$push"]["proposals"] = {**prop, "outcome": "new"}
        if status == "graduated":
            upd["$set"]["graduated_by"] = {"version": cur.version, "patch_hash": cur.patch_hash, "at": at}
        if doc is None:
            upd["$setOnInsert"] = {"scenario_hash": h, "profile": profile_of(h), "script": script, "kinds": kinds_of(script),
                                   "description": describe_script(script), "rationale": rationale, "created_at": at,
                                   "env": {k: self.kg.env.model_dump()[k] for k in ("engine_sha", "spec_id", "spec_hash_or_epoch", "ticks")}}
        self.c("scenarios").update_one({"_id": sid}, upd, upsert=True)

    def _enforce_cap(self, new_id: str) -> list[str]:
        """At most `cap` active scenarios: the lowest-regret one (older first on ties) is displaced."""
        out = []
        active = list(self.c("scenarios").find({"status": ACTIVE}, {"regret": 1, "updated_at": 1}))
        while len(active) > self.cfg.cap:
            low = min(active, key=lambda d: (d["regret"], d["_id"] == new_id, d["updated_at"]))
            self.c("scenarios").update_one({"_id": low["_id"]}, {"$set": {
                "status": "displaced", "reason": f"the curriculum holds {self.cfg.cap}; this had the lowest regret ({low['regret']:+.3f})",
                "updated_at": now()}})
            out.append(low["_id"])
            active = [d for d in active if d["_id"] != low["_id"]]
        return out

    def _emit(self, sid: str, turn: int, phase: str, props: dict, cur: BrainRef, epoch: int, proposer: str,
              signals: list[str], attempt: int = 0):
        eid = event_uuid(sid, turn, phase, cur.patch_hash, attempt)
        try:
            self.sink.event(eid, {"phase": phase, "turn": turn, "epoch": epoch, "against_version": cur.version,
                                  "proposer": proposer, "n_seeds": len(self.seeds), "engine_sha": self.kg.env.engine_sha,
                                  **props}, name=ADVERSARY_EVENT)
            for s in signals:
                self.sink.signal(eid, s)
        except Exception as e:  # never let observability break the loop
            log.warning("adversary raindrop event failed: %s", e)

    # ── turns ──

    def _next_turn(self) -> int:
        d = self.c("adversary_turns").find_one({}, {"turn": 1}, sort=[("turn", DESCENDING)])
        return int(d["turn"]) + 1 if d else 1

    def _stress_hashes(self) -> set:
        try:
            return {d["scenario_hash"] for d in self.c("heldout_stress").find({"kind": "scenario"}, {"scenario_hash": 1})}
        except OperationFailure:  # only the gate can read it; the adversary always runs on the gate client
            return set()

    def turn(self, against: Optional[int] = None, epoch: int = 0, m: Optional[int] = None) -> dict:
        """One adversary turn against brain `against` (default: the latest version)."""
        t0 = time.monotonic()
        V = against or self.kg.latest_version()
        cur = self.brain_ref(V)
        alts = self.alternatives(cur)
        n = self._next_turn()
        tid = f"turn-{n:04d}"
        self.c("adversary_turns").insert_one({"_id": tid, "turn": n, "kind": "curriculum", "epoch": epoch,
                                              "against": {"version": V, "patch_hash": cur.patch_hash},
                                              "alternatives": [{"label": a.label, "version": a.version, "patch_hash": a.patch_hash} for a in alts],
                                              "proposer": {"name": self.proposer.name}, "status": "running",
                                              "seeds": self.seeds, "started_at": now()})
        try:
            ctx = get_adversary_context(self, cur, alts, turn=n)
            props = self.proposer.propose(ctx, m or self.cfg.m)
            stress = self._stress_hashes()
            outcomes = [self.consider(s.get("script"), s.get("rationale", ""), cur, alts, turn=n, epoch=epoch,
                                      proposer=props.proposer, stress=stress)
                        for s in props.scenarios]
        except Exception as e:
            self.c("adversary_turns").update_one({"_id": tid}, {"$set": {"status": "failed", "error": str(e)[:1000],
                                                                         "finished_at": now()}})
            raise
        counts = Counter(o["status"] for o in outcomes)
        snap = self.snapshot()
        doc = {"status": "done", "proposer": {"name": props.proposer, "model": props.model, "usage": props.usage,
                                               "seconds": props.seconds},
               "context_markdown": ctx["markdown"], "raw": props.raw, "outcomes": outcomes, "counts": dict(counts),
               "acceptance_rate": round(counts.get("accepted", 0) / max(1, len(outcomes)), 3), **snap,
               "finished_at": now(), "wall_s": round(time.monotonic() - t0, 1)}
        self.c("adversary_turns").update_one({"_id": tid}, {"$set": doc})
        self.sink.flush()
        return {"turn": n, "against_version": V, "alternatives": [a.label for a in alts], "outcomes": outcomes,
                "counts": dict(counts), "proposer": doc["proposer"], "wall_s": doc["wall_s"], **snap}

    def snapshot(self) -> dict:
        """The curriculum chart's numbers right now: active scenarios, their mean regret, graduations so far."""
        active = list(self.c("scenarios").find({"status": ACTIVE}, {"regret": 1}))
        return {"active": len(active),
                "mean_active_regret": r4(sum(d["regret"] for d in active) / len(active)) if active else None,
                "graduated_total": self.c("scenarios").count_documents({"status": "graduated"})}

    def graduate(self, version: Optional[int] = None) -> dict:
        """After a promotion: re-score every active scenario against brain vV. Regret below graduate_regret
        graduates it (and records the version that solved it); otherwise its regret is updated."""
        t0 = time.monotonic()
        V = version or self.kg.latest_version()
        cur = self.brain_ref(V)
        alts = self.alternatives(cur)
        n = self._next_turn()
        rows = []
        for doc in list(self.c("scenarios").find({"status": ACTIVE}).sort([("regret", DESCENDING), ("_id", ASCENDING)])):
            prior = next((e for e in reversed(doc.get("evals", [])) if e["against"] == cur.patch_hash), None)
            if prior is not None:
                verdict = {k: prior[k] for k in ("regret", "harm", "best", "agree")} | {"status": prior["status"], "reason": prior["reason"]}
                scores = prior["scores"]
            else:
                scored = self.score_brains([cur] + alts, doc["script"], doc["scenario_hash"])
                verdict = self.judge(cur, scored, self.quiet(cur))
                scores = {k: v.to_doc() for k, v in scored.items()}
            status = "graduated" if verdict["regret"] < self.cfg.graduate_regret else ACTIVE
            reason = (f"{cur.label} handles it: regret {verdict['regret']:+.3f} < {self.cfg.graduate_regret}" if status == "graduated"
                      else f"still active against {cur.label}: regret {verdict['regret']:+.3f}")
            ev = {"against": cur.patch_hash, "against_version": V, "at": now(), "turn": n, "epoch": None, "phase": "rescore",
                  "seeds": self.seeds, "regret": verdict["regret"], "harm": verdict["harm"], "best": verdict["best"],
                  "agree": verdict["agree"], "status": status, "reason": reason, "scores": scores,
                  "patch_hashes": {r.label: r.patch_hash for r in [cur] + alts}}
            self._write_eval(doc["_id"], doc["scenario_hash"], doc["script"], doc.get("rationale"), doc, ev, status,
                             {**verdict, "reason": reason}, None, cur)
            self._emit(doc["_id"], n, "rescore", {"status": status, "scenario_hash": doc["scenario_hash"],
                                                  "regret": verdict["regret"], "kinds": doc.get("kinds")},
                       cur, 0, "rescore", ["scenario_graduated"] if status == "graduated" else [])
            rows.append({"scenario_id": doc["_id"], "description": doc.get("description"), "status": status,
                         "regret_before": doc.get("regret"), "regret": verdict["regret"], "best": verdict["best"]})
        snap = self.snapshot()
        self.c("adversary_turns").insert_one({"_id": f"turn-{n:04d}", "turn": n, "kind": "graduate", "status": "done",
                                              "against": {"version": V, "patch_hash": cur.patch_hash}, "rows": rows,
                                              "counts": dict(Counter(r["status"] for r in rows)), **snap,
                                              "started_at": now(), "finished_at": now(), "wall_s": round(time.monotonic() - t0, 1)})
        self.sink.flush()
        return {"version": V, "rescored": len(rows), "graduated": [r for r in rows if r["status"] == "graduated"],
                "rows": rows, **snap}

    # ── the stress set (document 07, section 3.7) ──

    def stress_turn(self, against: int = 1, m: Optional[int] = None) -> dict:
        """At go/no-go: one turn against vN with a fresh prompt (no memory, no curriculum). Accepted scenarios
        become the stress set in heldout_stress, gate-only: they never enter `scenarios`, `shifts` or the runner's
        cache (held_out), and the improver never sees them."""
        t0 = time.monotonic()
        cur = self.brain_ref(against)
        alts = self.alternatives(cur)
        n = 1 + self.c("heldout_stress").count_documents({"kind": "turn"})
        quiet = self.score_brains([cur], QUIET, None, held_out=True, record=False)[cur.label]
        ctx = get_adversary_context(self, cur, alts, turn=10_000 + n, fresh=True, quiet=quiet)
        props = self.proposer.propose(ctx, m or self.cfg.m)
        curriculum_hashes = {d["scenario_hash"] for d in self.c("scenarios").find({}, {"scenario_hash": 1}) if d.get("scenario_hash")}
        rows = []
        for s in props.scenarios:
            chk = self.check(s.get("script"))
            if not chk["ok"]:
                rows.append({"status": "invalid", "reason": "; ".join(p["reason"] for p in chk["problems"])})
                continue
            h = chk["hash"]
            if h in curriculum_hashes:
                rows.append({"scenario_hash": h, "status": "skipped", "reason": "already in the curriculum"})
                continue
            scored = self.score_brains([cur] + alts, chk["script"], h, held_out=True, record=False)
            v = self.judge(cur, scored, quiet)
            self.c("heldout_stress").update_one({"_id": f"st-{h}"}, {"$set": {
                "kind": "scenario", "scenario_hash": h, "script": chk["script"], "description": describe_script(chk["script"]),
                "rationale": s.get("rationale", ""), "status": v["status"], "regret": v["regret"], "harm": v["harm"],
                "reason": v["reason"], "best": v["best"], "against": {"version": against, "patch_hash": cur.patch_hash},
                "scores": {k: x.to_doc() for k, x in scored.items()}, "seeds": self.seeds, "turn": n, "created_at": now()}},
                upsert=True)
            rows.append({"scenario_hash": h, "status": v["status"], "regret": v["regret"], "reason": v["reason"],
                         "description": describe_script(chk["script"])})
        self.c("heldout_stress").insert_one({"_id": f"stress-turn-{n:03d}", "kind": "turn", "turn": n, "against": against,
                                             "proposer": {"name": props.proposer, "model": props.model}, "rows": rows,
                                             "raw": props.raw, "at": now(), "wall_s": round(time.monotonic() - t0, 1)})
        return {"turn": n, "against_version": against, "rows": rows,
                "stress_set": self.c("heldout_stress").count_documents({"kind": "scenario", "status": ACTIVE})}

    def stress_seeds(self) -> list[int]:
        """The stress set's own locked seeds (heldout_seeds "stress", created on first use). Being in
        heldout_seeds also makes record_shifts refuse them."""
        d = self.c("heldout_seeds").find_one({"_id": "stress"})
        if d is None:
            rng = random.Random(20261011 + 3)
            d = {"_id": "stress", "seeds": [rng.randrange(0, 2 ** 32) for _ in range(12)],
                 "purpose": "the adversary's stress set (document 07, 3.7): scored once, at the end", "created_at": now()}
            self.c("heldout_seeds").insert_one(d)
        return [int(s) for s in d["seeds"]]

    def stress_report(self, versions: list[int]) -> dict:
        """Score each version once on every accepted stress scenario, on the stress seeds, held out. The secondary
        number: it measures how much of v1's weakness was fixed, not robustness in general."""
        seeds = self.stress_seeds()
        refs = [self.brain_ref(v) for v in versions]
        saved = self.seeds
        self.seeds = seeds
        try:
            rows = []
            for d in self.c("heldout_stress").find({"kind": "scenario", "status": ACTIVE}).sort("_id", 1):
                scored = self.score_brains(refs, d["script"], d["scenario_hash"], held_out=True, record=False)
                rows.append({"scenario_hash": d["scenario_hash"], "description": d.get("description"),
                             "scores": {r.label: r4(scored[r.label].score) for r in refs}})
        finally:
            self.seeds = saved
        mean = {r.label: r4(sum(x["scores"][r.label] for x in rows) / len(rows)) if rows else None for r in refs}
        report = {"_id": f"report-{int(time.time())}", "kind": "report", "versions": versions, "seeds": len(seeds),
                  "rows": rows, "mean": mean, "at": now(),
                  "caveat": "generated against v1: measures how much of v1's weakness was fixed, not robustness in general"}
        self.c("heldout_stress").insert_one(report)
        return report


# ── reads anyone may use ────────────────────────────────────

def curriculum(kg: KG) -> list[dict]:
    """The active scenarios for the next improvement epoch, hardest first. Works on either client; on the gate
    client a stress-set scenario is dropped even if it somehow reached `scenarios` (defence in depth)."""
    stress: set = set()
    if kg.role == "gate":
        try:
            stress = {d["scenario_hash"] for d in kg.c("heldout_stress").find({"kind": "scenario"}, {"scenario_hash": 1})}
        except OperationFailure:
            stress = set()
    out = []
    for d in kg.c("scenarios").find({"status": ACTIVE}).sort([("regret", DESCENDING), ("_id", ASCENDING)]):
        if d["scenario_hash"] in stress:
            continue
        out.append({"scenario_id": d["_id"], "scenario_hash": d["scenario_hash"], "profile": profile_of(d["scenario_hash"]),
                    "script": d["script"], "description": d.get("description"), "regret": d.get("regret"),
                    "against_version": (d.get("against") or {}).get("version"), "rationale": d.get("rationale")})
    return out


def replay_url(doc: dict, seed: Optional[int] = None, base_url: str = "http://localhost:5174", a: str = "v1",
               b: str = "v2", runner: Optional[str] = None) -> dict:
    """TwinForge's compare.html for a scenario: both brains replay the same script and seed side by side. The
    default seed is the one where the best alternative beat the current brain by the most in the latest eval;
    playback starts 30 s before the first disruption."""
    import base64
    ev = (doc.get("evals") or [None])[-1]
    if seed is None and ev:
        cur = next((k for k, v in ev["patch_hashes"].items() if v == ev["against"]), None)
        mine, best = ev["scores"].get(cur, {}).get("per_seed", {}), ev["scores"].get(ev.get("best"), {}).get("per_seed", {})
        if mine and best:
            seed = int(max(mine, key=lambda s: (best.get(s, 0) - mine[s], -int(s))))
    seed = seed if seed is not None else (ev["seeds"][0] if ev else 101)
    b64 = base64.urlsafe_b64encode(json.dumps(doc["script"], separators=(",", ":")).encode()).decode().rstrip("=")
    start = max(0, min(e["at_tick"] for e in doc["script"]) - 300) if doc["script"] else 0
    tail = f"&runner={runner}" if runner else ""  # the page asks this runner (it needs WP-C2) for end-of-shift scores
    return {"url": f"{base_url}/compare.html?seed={seed}&a={a}&b={b}&scenario={b64}&start_tick={start}{tail}",
            "seed": seed, "description": doc.get("description"), "scenario_hash": doc["scenario_hash"]}


def trace(kg: KG) -> list[dict]:
    """The curriculum chart, one row per turn or graduation: active count, mean active regret, graduations,
    acceptance rate. A training trace, not proof: the held-out numbers are the proof."""
    rows = []
    for t in kg.c("adversary_turns").find({"status": "done"}).sort("turn", 1):
        rows.append({"turn": t["turn"], "kind": t.get("kind"), "epoch": t.get("epoch"),
                     "against_version": (t.get("against") or {}).get("version"), "counts": t.get("counts", {}),
                     "acceptance_rate": t.get("acceptance_rate"), "active": t.get("active"),
                     "mean_active_regret": t.get("mean_active_regret"), "graduated_total": t.get("graduated_total")})
    return rows


# ── what the proposer sees ──────────────────────────────────

def _failure_windows(results: list[dict], top: int = 2) -> dict[str, list[str]]:
    """Per failure type, the 2-minute windows with the most entries (from the per-entry lists). Tasks still open
    past their deadline when the shift ends are charged to its last tick: "at the end of the shift"."""
    by = defaultdict(Counter)
    for r in results:
        end = int(r.get("ticks") or 0)
        for f in r.get("failures") or []:
            by[f["type"]][-1 if end and int(f["tick"]) >= end else int(f["tick"]) // 1200] += 1
    label = lambda w: "at the end of the shift" if w < 0 else f"{clock(w * 1200)}–{clock((w + 1) * 1200)}"
    return {t: [f"{label(w)} ({n})" for w, n in c.most_common(top)] for t, c in by.items()}


def _lift_jams(results: list[dict]) -> dict[str, int]:
    c = Counter()
    for r in results:
        for f in r.get("failures") or []:
            if f["type"] == "LIFT_QUEUE_JAM":
                m = re.search(r"queued at (\S+)", f.get("detail") or "")
                c[m.group(1) if m else "?"] += 1
    return dict(c)


def _zone_line(zones: dict[str, float]) -> str:
    return ", ".join(f"{z} {s:.3f}" for z, s in sorted(zones.items()))


def get_adversary_context(adv: Adversary, cur: BrainRef, alts: list[BrainRef], *, turn: int, fresh: bool = False,
                          quiet: Optional[Scored] = None) -> dict:
    """What the proposer sees: the current brain on a quiet shift and on the standard profile (worst zone, its
    time split, failures by type, zone, lift and time window), the active curriculum, the other brains, its own
    last scenarios with their outcomes, and the rules. `fresh` (the stress-set turn) leaves out the memory."""
    kg = adv.kg
    if quiet is None:
        quiet = adv.quiet(cur) if not fresh else adv.score_brains([cur], QUIET, None, held_out=True, record=False)[cur.label]
    std = adv.score_brains([cur], None, None, record=not fresh, held_out=fresh)[cur.label]
    s = metrics.summarize(std.results)
    worst = s["worst_zone"]
    env = adv.envelope()
    v1_diff = adv.settings_diff(cur, adv.brain_ref(1)) if cur.version != 1 else []
    data: dict[str, Any] = {
        "turn": turn, "envelope": env, "seeds": len(adv.seeds),
        "current": {"label": cur.label, "version": cur.version, "patch_hash": cur.patch_hash, "vs_v1": v1_diff,
                    "quiet": {"score": r4(quiet.score), "zones": quiet.zones},
                    "standard": {"score": r4(std.score), "zones": std.zones, "worst_zone": worst,
                                 "worst_time_split": s["worst_time_split"], "failures": {k: v for k, v in s["failures"].items() if v},
                                 "failures_by_zone": {t: i["zones"] for t, i in s["failures_by_zone"].items()},
                                 "lift_jams": _lift_jams(std.results), "windows": _failure_windows(std.results)}},
        "alternatives": [{"label": a.label, "differs": adv.settings_diff(a, cur)} for a in alts],
    }
    if not fresh:
        data["curriculum"] = [{"description": d["description"], "regret": d["regret"], "against_version": d["against_version"]}
                              for d in curriculum(kg)]
        hist = list(kg.c("scenarios").find({}, {"description": 1, "status": 1, "regret": 1, "reason": 1, "rationale": 1,
                                                "kinds": 1, "against": 1}).sort("updated_at", DESCENDING).limit(adv.cfg.memory))
        data["history"] = [{"description": h.get("description"), "status": h["status"], "regret": h.get("regret"),
                            "against_version": (h.get("against") or {}).get("version"), "reason": h.get("reason"),
                            "rationale": h.get("rationale")} for h in hist]
        kinds = defaultdict(lambda: {"proposed": 0, "accepted": 0})
        for d in kg.c("scenarios").find({}, {"kinds": 1, "status": 1}):
            for k in d.get("kinds") or []:
                kinds[k]["proposed"] += 1
                kinds[k]["accepted"] += d["status"] in (ACTIVE, "graduated")
        data["kinds"] = dict(kinds)
    return {"markdown": render_adversary_context(data), "data": data}


def render_adversary_context(d: dict) -> str:
    cur, std = d["current"], d["current"]["standard"]
    out = [f"## The current brain: {cur['label']}",
           "Settings that differ from v1: " + ("; ".join(cur["vs_v1"]) if cur["vs_v1"] else "none (this is v1: lifts only, 80% speed)"),
           "",
           f"### On a quiet shift (no disruptions), {d['seeds']} seeds",
           f"Score {cur['quiet']['score']:.3f}. Zones: {_zone_line(cur['quiet']['zones'])}.",
           "A scenario must push the score below this to count.",
           "",
           "### On the standard profile (one lift fault, one intrusion, one burst per shift)",
           f"Score {std['score']:.3f}. Zones: {_zone_line(std['zones'])}. Worst zone: {std['worst_zone']}.",
           f"Time split in zone {std['worst_zone']}: " + ", ".join(f"{k} {v:.0%}" for k, v in sorted(std["worst_time_split"].items(), key=lambda kv: -kv[1]) if v > 0),
           "Failures (all seeds): " + (", ".join(f"{t} {n}" for t, n in std["failures"].items()) or "none"),
           "Lift-queue jams by lift: " + (", ".join(f"{k} {v}" for k, v in sorted(std["lift_jams"].items())) or "none"),
           "Busiest windows: " + ("; ".join(f"{t}: {', '.join(w)}" for t, w in std["windows"].items()) or "-"),
           ""]
    out.append("### The other brains (regret is measured against the best of them)")
    for a in d["alternatives"]:
        out.append(f"- {a['label']}: " + ("; ".join(a["differs"]) or "same settings"))
    out.append("")
    if "curriculum" in d:
        out.append("### Active curriculum (scenarios the improver now trains on)")
        out += [f"- {c['description']} · regret {c['regret']:+.3f} against v{c['against_version']}" for c in d["curriculum"]] or ["- none yet"]
        out.append("")
        out.append("### Your last scenarios, newest first")
        for h in d["history"] or []:
            reg = f" · regret {h['regret']:+.3f} vs v{h['against_version']}" if h.get("regret") is not None else ""
            out.append(f"- [{h['status']}] {h['description']}{reg} · {h.get('reason') or ''}"
                       + (f" · your rationale: {h['rationale']}" if h.get("rationale") else ""))
        if not d["history"]:
            out.append("- none yet")
        out.append("")
        if d.get("kinds"):
            out.append("### What has worked, by kind (scenarios containing it)")
            out += [f"- {k}: {v['accepted']} accepted of {v['proposed']} proposed" for k, v in sorted(d["kinds"].items())]
            out.append("")
    out.append("### Rules (the runner refuses anything else)")
    out += [f"- {r}" for r in d["envelope"]["rules"]]
    return "\n".join(out)
