"""Pydantic mirror of the TwinForge runner contract.

Source: physical-ai `src/harness/contract.ts` at c07a2c1, plus the spec_hash fields added (uncommitted) on
top of 2253f36, branch hackathon/humanoid-twin, read at 12:40. TwinForge stays out of this repo; the KG
talks to it only through this HTTP contract.

WP-C2 (physical-ai bc8b8da, branch hackathon/wp-c2): caller-supplied scenario scripts. A request may carry
`scenario_script` instead of a profile; the response names it `scenario_profile: "script:<scenario_hash>"`.

Deliberate loosening, so a runner that adds fields or failure types never breaks the KG mid-demo:
  - response models keep unknown fields (`extra="allow"`), and spec_hash is optional for older runners;
  - failure types are plain strings, with the known ones in FAILURE_TYPES.
"""
from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


class _Open(BaseModel):
    model_config = ConfigDict(extra="allow")


#: Keeps 99 an int and 1.2 a float, so exported JSON matches what people write by hand.
Number = Union[int, float]


# ── Brain (input) ────────────────────────────────────────────

class BrainEdit(BaseModel):
    """The one typed edit the compiler understands. Any other `body` is carried through untouched."""
    model_config = ConfigDict(extra="forbid")
    op: Literal["set"]
    #: `sim.<SETTING>` | `assign.<WEIGHT>` | `class.<CLASS_ID>.<field>` | `zone.<ZONE_ID>.capacity`
    target: str
    value: Number


class Origin(_Open):
    source: str
    ref: Optional[str] = None


class BrainNode(_Open):
    node_id: str
    parent_id: Optional[str]
    #: free vocabulary: "site" | "zone" | "task" | "rule" | "guardrail" | "habit" | ...
    level: str
    zone: Optional[str] = None
    #: tried left to right, so a typed edit always parses as BrainEdit and anything else stays as given
    body: Union[BrainEdit, dict[str, Any], str, None] = Field(default=None, union_mode="left_to_right")
    origin: Optional[Origin] = None


class BrainApproval(BaseModel):
    target: str
    value: Number
    approved_by: str
    ref: Optional[str] = None


class Brain(BaseModel):
    version: int
    nodes: list[BrainNode]
    approvals: list[BrainApproval] = Field(default_factory=list)


# ── Compiled patch ───────────────────────────────────────────

class SpecPatch(_Open):
    sim: dict[str, Number] = Field(default_factory=dict)
    classes: dict[str, dict[str, Number]] = Field(default_factory=dict)
    zones: dict[str, dict[str, Number]] = Field(default_factory=dict)


class EffectiveEdit(_Open):
    target: str
    value: Number
    node_id: str


class LockedEdit(_Open):
    target: str
    value: Number
    baseline: Number
    node_id: Optional[str]
    reason: str


class RejectedEdit(_Open):
    target: str
    value: Any
    node_id: str
    reason: str


# ── POST /run_shift ──────────────────────────────────────────

DEFAULT_TICKS = 12000
DEFAULT_PROFILE = "standard"

FAILURE_TYPES = [
    "LIFT_QUEUE_JAM", "STAIR_QUEUE", "DEADLOCK_BACKOFF", "LATE_TASK",
    "DROPPED_DEMAND", "BATTERY_STRANDING", "HUMAN_REPLAN",
]
#: SeedResult.failures keeps at most this many entries per type; failure_counts has the totals.
FAILURES_CAP_PER_TYPE = 25

TIME_STATES = ["travel", "lift_wait", "lift_ride", "stairs", "blocked", "pick_drop"]


class RunShiftRequest(BaseModel):
    brain: Brain
    seeds: list[int]
    ticks: Optional[int] = None
    scenario_profile: Optional[str] = None
    #: WP-C2: replaces the profile; the same script runs on every seed
    scenario_script: Optional[list[dict[str, Any]]] = None
    allow_locked: Optional[bool] = None
    held_out: Optional[bool] = None


class TimeSplit(_Open):
    travel: float = 0
    lift_wait: float = 0
    lift_ride: float = 0
    stairs: float = 0
    blocked: float = 0
    pick_drop: float = 0


class ZoneMetrics(_Open):
    offered: int
    on_time: int
    late: int
    failed: int
    dropped: int
    censored: int
    safety_events: int
    score: float
    avg_task_s: Optional[float] = None
    time_split: TimeSplit = Field(default_factory=TimeSplit)


class FleetMetrics(_Open):
    completed: float
    on_time_rate: float
    energy_kwh: float
    stair_trips: float
    lift_trips: float
    avg_lift_wait_s: float
    battery_strandings: float


class SafetyMetrics(_Open):
    human_proximity: int = 0
    near_misses: int = 0
    separation_pushes: int = 0


class FailureEntry(_Open):
    type: str
    zone: Optional[str]
    tick: int
    robots: list[str] = Field(default_factory=list)
    detail: str = ""
    task_id: Optional[str] = None


class ScenarioEntry(_Open):
    kind: str
    at_tick: int
    clear_at_tick: Optional[int] = None


class SeedResult(_Open):
    seed: int
    ticks: int
    zones: dict[str, ZoneMetrics]
    fleet: FleetMetrics
    safety: SafetyMetrics
    failures: list[FailureEntry] = Field(default_factory=list)
    failure_counts: dict[str, int] = Field(default_factory=dict)
    scenario: list[ScenarioEntry] = Field(default_factory=list)


class PooledZone(_Open):
    offered: int
    on_time: int
    late: int
    failed: int
    dropped: int
    censored: int
    safety_events: int
    score: float


class _MeanZone(_Open):
    score: float


class _MeanFleet(_Open):
    on_time_rate: float
    completed: float
    stair_trips: float
    lift_trips: float
    avg_lift_wait_s: float


class _Mean(_Open):
    zones: dict[str, _MeanZone]
    fleet: _MeanFleet


class _Pooled(_Open):
    zones: dict[str, PooledZone]


class RunShiftResponse(_Open):
    engine_sha: str
    spec_id: str
    #: hash of the environment before the brain; changes when the spec (e.g. a stair cost) is retuned
    spec_hash: Optional[str] = None
    brain_version: int
    patch_hash: str
    ticks: int
    #: the profile name, or "script:<scenario_hash>" for a caller-supplied script (WP-C2)
    scenario_profile: str
    #: WP-C2: hash of the normalized script, or the profile name (absent from older runners)
    scenario_hash: Optional[str] = None
    per_seed: list[SeedResult]
    mean: _Mean
    pooled: _Pooled
    warnings: list[str] = Field(default_factory=list)


# ── 422 body, /validate_brain, /settings, /health ────────────

class ScenarioProblem(_Open):
    """One problem with a script; index is the entry's position in the caller's list (-1: the whole script)."""
    index: int
    reason: str


class BrainRejection(_Open):
    error: str
    message: str
    locked_edits: list[LockedEdit] = Field(default_factory=list)
    rejected: list[RejectedEdit] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    #: WP-C2: present when error is "rejected_scenario"
    scenario_rejected: list[ScenarioProblem] = Field(default_factory=list)


class ValidateScenarioResponse(_Open):
    """POST /validate_scenario (WP-C2)."""
    ok: bool
    rejected: list[ScenarioProblem] = Field(default_factory=list)
    scenario_hash: Optional[str] = None
    scenario_profile: Optional[str] = None
    #: the script as /run_shift will run it: canonical fields, defaults filled in, sorted by tick
    scenario_script: list[dict[str, Any]] = Field(default_factory=list)


class ScenarioEnvelope(_Open):
    """GET /scenario_envelope (WP-C2): the limits a caller-supplied script must stay inside."""
    ticks: int
    ticks_per_second: int
    min_at_tick: int
    max_at_tick: int
    kinds: dict[str, dict[str, Any]]
    rules: list[str] = Field(default_factory=list)


class ValidateBrainResponse(_Open):
    ok: bool
    spec_hash: Optional[str] = None
    patch: SpecPatch
    patch_hash: str
    effective: list[EffectiveEdit] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    locked_edits: list[LockedEdit] = Field(default_factory=list)
    rejected: list[RejectedEdit] = Field(default_factory=list)


SettingStatus = Literal["editable", "locked", "fixed", "spec"]


class SettingDef(_Open):
    target: str
    description: str
    engine_default: Number
    v1: Number
    min: Number
    max: Number
    status: SettingStatus
    note: Optional[str] = None


class SettingsResponse(_Open):
    spec_id: str
    spec_hash: Optional[str] = None
    settings: list[SettingDef]


class HealthResponse(_Open):
    ok: bool
    engine_sha: str
    spec_id: str
    spec_hash: Optional[str] = None
    mode: str
