"""The settings registry: what the brain may change, and in which lever group.

Until the runner serves `GET /settings`, this is the table in section 6 of
reference/twinforge-humanoid-plan.md, with values from the humanoid overlay
(physical-ai src/harness/overlay.ts at 214f270). `from_settings_response()`
replaces it with the runner's own registry once WP-R/WP-B land.

Statuses follow contract.ts:
  editable  the brain may set it within [min, max]
  locked    needs a human approval to differ from v1 (the approved baseline)
  fixed     locked and never approvable; any edit is rejected
  spec      describes the building or the robot; never set by the brain
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Optional

from .contract import SettingsResponse

LEVER_GROUPS = ["floor_change", "waiting", "energy", "dispatch", "motion", "yielding"]

LEVER_GROUP_LABELS = {
    "floor_change": "How robots change floors (stairs or lift)",
    "waiting": "How long a blocked robot waits before replanning or backing off",
    "energy": "When robots charge, and how battery weighs in assignment",
    "dispatch": "Which robot gets which task, and where idle robots go",
    "motion": "Speed and safety distances (locked: needs a call)",
    "yielding": "Giving way to other robots (no setting expresses this yet)",
}


@dataclass(frozen=True)
class Setting:
    target: str
    description: str
    engine_default: float
    v1: float
    min: float
    max: float
    status: str
    group: Optional[str]
    integer: bool = True
    #: values to try first, in order (WP-T's sweep grid where it exists)
    grid: tuple = ()
    note: Optional[str] = None

    @property
    def is_lever(self) -> bool:
        """The brain can change it at all (with or without a call)."""
        return self.status in ("editable", "locked") and self.max > self.min and self.group is not None

    @property
    def gets_v1_component(self) -> bool:
        """Every setting the brain may carry gets a baseline component, so no engine default leaks in."""
        return self.status in ("editable", "locked")

    @property
    def lever_id(self) -> Optional[str]:
        return f"c:lever/{self.group}/{self.target}" if self.group else None

    def candidates(self) -> list[float]:
        """Values to suggest, grid first, then a generic spread around v1. All inside [min, max]."""
        out: list[float] = list(self.grid)
        span = self.max - self.min
        if span > 0:
            for f in (0.75, 1.25, 0.5, 1.5):
                out.append(self.v1 * f)
            out += [self.min, self.max]
        seen, clean = set(), []
        for v in out:
            v = min(self.max, max(self.min, v))
            v = round(v) if self.integer else round(v, 2)
            if v not in seen:
                seen.add(v)
                clean.append(v)
        return clean


def _s(target, description, default, v1, lo, hi, status, group, integer=True, grid=(), note=None) -> Setting:
    return Setting(target, description, default, v1, lo, hi, status, group, integer, tuple(grid), note)


# Section 6 of the TwinForge plan. Order is the display order inside each lever group.
SETTINGS: list[Setting] = [
    # floor_change
    _s("sim.STAIR_MIN_LIFT_QUEUE", "Take the stairs when at least this many robots queue for the best lift",
       0, 99, 0, 99, "editable", "floor_change", grid=(2, 3, 1, 5, 0),
       note="engine default 0 = always stairs; v1 99 = never"),
    _s("sim.STAIR_MAX_LOAD", "Take the stairs only when carrying at most this load",
       99, 99, 0, 99, "editable", "floor_change", grid=(0, 1),
       note="registry range is 0 to class capacity (HUM-1 carries 1), so 1..99 behave the same; GET /settings will settle the max"),
    _s("sim.LIFT_RETRY_TICKS", "Ticks before retrying a busy lift", 50, 50, 20, 200, "editable", "floor_change",
       grid=(30, 100, 20, 150)),
    _s("sim.LIFT_XFLOOR_PENALTY_M", "Metres added to a cross-floor task's cost in assignment",
       40, 40, 0, 100, "editable", "floor_change", grid=(20, 60, 0, 80)),
    # waiting
    _s("sim.WAIT_REPLAN_TICKS", "Ticks a blocked robot waits before replanning", 25, 25, 10, 80, "editable", "waiting",
       grid=(15, 40, 10, 60)),
    _s("sim.WAIT_BACKOFF_TICKS", "Ticks a blocked robot waits before backing off (deadlock breaker)",
       80, 80, 30, 200, "editable", "waiting", grid=(50, 120, 30, 160)),
    # energy
    _s("sim.CHARGE_AT_PCT", "Battery percent at which a robot goes to charge", 35, 35, 25, 60, "editable", "energy",
       grid=(30, 45, 25, 55)),
    _s("assign.W_BATTERY", "Assignment weight on battery level", 0.25, 0.25, 0, 1, "editable", "energy",
       integer=False, grid=(0.4, 0.15)),
    # dispatch
    _s("assign.W_DISTANCE", "Assignment weight on distance to the task", 0.35, 0.35, 0, 1, "editable", "dispatch",
       integer=False, grid=(0.5, 0.25)),
    _s("assign.W_WORKLOAD", "Assignment weight on robot workload", 0.15, 0.15, 0, 1, "editable", "dispatch",
       integer=False, grid=(0.3, 0.05)),
    _s("assign.W_CONGESTION", "Assignment weight on zone congestion", 0.15, 0.15, 0, 1, "editable", "dispatch",
       integer=False, grid=(0.3, 0.05)),
    _s("assign.W_HEALTH", "Assignment weight on robot health", 0.10, 0.10, 0, 1, "editable", "dispatch",
       integer=False, grid=(0.2, 0.0)),
    _s("sim.IDLE_TO_PARK_TICKS", "Ticks an idle robot waits before going to park", 300, 300, 100, 1200,
       "editable", "dispatch", grid=(150, 600, 100, 900)),
    _s("zone.M.capacity", "Robots zone M counts as full (feeds the congestion reading only)", 8, 8, 2, 12,
       "editable", "dispatch", grid=(6, 10, 4, 12),
       note="a weak lever: capacity changes a congestion reading, not entry (TwinForge finding 8); zones A-D use the engine default 6"),
    _s("class.HUM-1.capacity", "Load units a humanoid carries", 1, 1, 1, 1, "editable", "dispatch",
       note="Digit 4 carries one 16 kg tote, which is also the spec-sheet maximum"),
    # motion (locked)
    _s("class.HUM-1.max_speed", "Humanoid top walking speed, m/s", 1.5, 1.2, 0, 1.5, "locked", "motion",
       integer=False, grid=(1.35, 1.5, 1.0), note="v1 is 80% of Digit's published 1.5 m/s"),
    _s("sim.PERC_STOP", "Stopping distance, m", 1.7, 1.7, 1.2, 3.0, "locked", "motion", integer=False,
       grid=(1.5, 2.0), note="registry gives only 'at least 1.2 m'; max 3.0 is a placeholder until GET /settings"),
    _s("sim.PERC_SLOW", "Slow-down distance, m", 2.8, 2.8, 1.7, 5.0, "locked", "motion", integer=False,
       grid=(2.4, 3.2), note="registry gives 'at least PERC_STOP'; min uses v1 PERC_STOP, max 5.0 is a placeholder"),
    _s("sim.MIN_SEP", "Hard minimum distance between robots, m", 0.9, 0.9, 0.9, 0.9, "locked", "motion",
       integer=False, note="registry range is 'fixed'"),
    # never changed by the brain (envelope only)
    _s("sim.HUMAN_CLEARANCE_M", "Distance to a person that counts as a safety event, m (scoring only)",
       2.0, 2.0, 2.0, 2.0, "fixed", None, integer=False, note="locked and never approvable"),
    _s("sim.STAIR_CAPACITY", "Robots that may climb one stairwell at once", 99, 2, 2, 2, "spec", None,
       note="set by the warehouse-humanoid spec (overlay STAIR_COSTS), frozen in WP-T"),
    _s("sim.STAIR_LOAD_TICKS", "Extra climb ticks per load unit", 0, 40, 40, 40, "spec", None,
       note="set by the warehouse-humanoid spec (overlay STAIR_COSTS), frozen in WP-T"),
    _s("sim.BATTERY_STAIR", "Battery drained per tick while climbing", 0, 0.01, 0.01, 0.01, "spec", None,
       integer=False, note="set by the warehouse-humanoid spec (overlay STAIR_COSTS), frozen in WP-T"),
]


def group_for(target: str) -> Optional[str]:
    """Lever group for a target the static table doesn't know (used when /settings adds one)."""
    t = target
    if t.startswith("sim.STAIR_MIN") or t.startswith("sim.STAIR_MAX") or t.startswith("sim.LIFT_"):
        return "floor_change"
    if t.startswith("sim.WAIT_"):
        return "waiting"
    if t.startswith("sim.CHARGE") or t == "assign.W_BATTERY":
        return "energy"
    if t.startswith("assign.") or t.endswith(".capacity") or t.startswith("sim.IDLE"):
        return "dispatch"
    if t.endswith(".max_speed") or t.startswith("sim.PERC_") or t == "sim.MIN_SEP":
        return "motion"
    return None


def from_settings_response(resp: SettingsResponse) -> list[Setting]:
    """The runner's registry, keeping our lever groups and grids where the target is known."""
    known = {s.target: s for s in SETTINGS}
    out = []
    for d in resp.settings:
        k = known.get(d.target)
        integer = k.integer if k else all(float(x).is_integer() for x in (d.v1, d.min, d.max))
        group = k.group if k else group_for(d.target)
        out.append(Setting(d.target, d.description, d.engine_default, d.v1, d.min, d.max, d.status,
                           group if d.status in ("editable", "locked") else None,
                           integer, k.grid if k else (), d.note))
    return out


def by_target(settings: Optional[list[Setting]] = None) -> dict[str, Setting]:
    return {s.target: s for s in (settings or SETTINGS)}


def label_for(target: str, value: float) -> str:
    """Readable label for a component that sets `target` to `value`."""
    if target == "sim.STAIR_MIN_LIFT_QUEUE":
        if value >= 99:
            return f"Take the stairs only when {value:g}+ wait for the lift (never)"
        if value <= 0:
            return "Always take the stairs"
        return f"Take the stairs when {value:g}+ robots wait for the lift"
    if target == "sim.STAIR_MAX_LOAD":
        return "Take the stairs only when empty" if value < 1 else f"Take the stairs carrying up to {value:g} load"
    s = by_target().get(target)
    desc = s.description if s else target
    return f"{desc}: {value:g}"


def with_overrides(settings: list[Setting], **changes) -> list[Setting]:
    """Copy with some fields changed per target: with_overrides(S, **{"sim.X": {"v1": 3}})."""
    return [replace(s, **changes[s.target]) if s.target in changes else s for s in settings]
