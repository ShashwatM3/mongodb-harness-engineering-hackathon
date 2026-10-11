"""Pydantic mirror of the TwinForge runner contract.

Source: physical-ai `src/harness/contract.ts`, last changed in commit c07a2c1
(branch hackathon/humanoid-twin, checked at 214f270). TwinForge stays out of this
repo; the KG talks to it only through this HTTP contract.

Deliberate loosening, so a runner that adds fields or failure types never breaks
the KG mid-demo:
  - response models keep unknown fields (`extra="allow"`), e.g. a future `spec_hash`;
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
    brain_version: int
    patch_hash: str
    ticks: int
    scenario_profile: str
    per_seed: list[SeedResult]
    mean: _Mean
    pooled: _Pooled
    warnings: list[str] = Field(default_factory=list)


# ── 422 body, /validate_brain, /settings, /health ────────────

class BrainRejection(_Open):
    error: str
    message: str
    locked_edits: list[LockedEdit] = Field(default_factory=list)
    rejected: list[RejectedEdit] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ValidateBrainResponse(_Open):
    ok: bool
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
    settings: list[SettingDef]


class HealthResponse(_Open):
    ok: bool
    engine_sha: str
    spec_id: str
    mode: str
