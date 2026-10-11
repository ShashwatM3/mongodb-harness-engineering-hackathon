"""The settings registry: what the brain may change, and in which lever group.

Until the runner serves `GET /settings`, this is the table in section 6 of
reference/twinforge-humanoid-plan.md, with values from TwinForge's warehouse overlay
(physical-ai src/harness/overlay.ts at 214f270, on the local, unpushed branch
hackathon/humanoid-twin). `from_settings_response()` replaces it with the runner's own
registry once WP-R/WP-B land.

The robot is a legged quadruped with one arm (team decision, 2026-10-11): TwinForge's
`locomotion: "legged"` with `can_climb_stairs: true`, so it takes the stairs or the lift,
and its torso rises and lowers to reach each shelf level. Class id `HUM-1` is the overlay's
current id; rename the `class.HUM-1.*` keys if the TwinForge spec settles on another.

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

LEVER_GROUPS = ["floor_change", "waiting", "energy", "dispatch", "motion", "yielding", "manipulation"]

LEVER_GROUP_LABELS = {
    "floor_change": "How robots change floors (stairs or lift)",
    "waiting": "How long a blocked robot waits before replanning or backing off",
    "energy": "When robots charge, and how battery weighs in assignment",
    "dispatch": "Which robot gets which task, and where idle robots go",
    "motion": "Speed and safety distances (locked: needs a call)",
    "yielding": "Giving way to other robots (no setting expresses this yet)",
    "manipulation": "Reaching and grasping at each shelf level (placeholder: the engine has no arm yet)",
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
        """Brain v1 sets exactly the settings whose v1 differs from the engine default, so no default leaks in
        (stair threshold 0 → 99, max_speed 1.5 → 1.2) and its patch equals brains/v1.json's (WP-B)."""
        return self.status in ("editable", "locked") and self.engine_default != self.v1

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
        whole = self.integer or all(float(x).is_integer() for x in (self.v1, self.min, self.max))
        for v in out:
            v = min(self.max, max(self.min, v))
            v = round(v) if whole else round(v, 2)
            if v not in seen:
                seen.add(v)
                clean.append(v)
        return clean


def _s(target, description, default, v1, lo, hi, status, group, integer=True, grid=(), note=None) -> Setting:
    return Setting(target, description, default, v1, lo, hi, status, group, integer, tuple(grid), note)


# Mirrors physical-ai src/harness/settings.ts (WP-B; read at 12:40, uncommitted), which serves GET /settings.
# `integer` matches its flags (the compiler rejects a fraction there). Order is the display order per group.
SETTINGS: list[Setting] = [
    # floor_change
    _s("sim.STAIR_MIN_LIFT_QUEUE", "Take the stairs when the best lift's queue holds at least this many robots",
       0, 99, 0, 99, "editable", "floor_change", grid=(2, 3, 1, 5, 0),
       note="engine default 0 = always stairs; v1 99 = only when no lift works"),
    _s("sim.STAIR_MAX_LOAD", "...and only when carrying at most this many load units (0 = only empty-handed)",
       99, 99, 0, 99, "editable", "floor_change", grid=(0, 1),
       note="values at or above the class capacity (HUM-1 carries 1) mean no load limit"),
    _s("sim.LIFT_RETRY_TICKS", "Ticks between retries when the chosen lift has faulted", 50, 50, 20, 200,
       "editable", "floor_change", grid=(30, 100, 20, 150)),
    _s("sim.LIFT_XFLOOR_PENALTY_M", "Metres added to a cross-floor candidate's distance in task assignment",
       40, 40, 0, 100, "editable", "floor_change", integer=False, grid=(20, 60, 0, 80)),
    # waiting
    _s("sim.WAIT_REPLAN_TICKS", "Ticks blocked before a robot replans its route", 25, 25, 10, 80, "editable",
       "waiting", grid=(15, 40, 10, 60)),
    _s("sim.WAIT_BACKOFF_TICKS", "Ticks blocked before a robot backs off to break a deadlock", 80, 80, 30, 200,
       "editable", "waiting", grid=(50, 120, 30, 160)),
    # energy
    _s("sim.CHARGE_AT_PCT", "An idle robot below this battery % goes to charge", 35, 35, 25, 60, "editable", "energy",
       integer=False, grid=(30, 45, 25, 55)),
    _s("assign.W_BATTERY", "Task-assignment weight on battery level", 0.25, 0.25, 0, 1, "editable", "energy",
       integer=False, grid=(0.4, 0.15)),
    # dispatch
    _s("assign.W_DISTANCE", "Task-assignment weight on distance to the task", 0.35, 0.35, 0, 1, "editable",
       "dispatch", integer=False, grid=(0.5, 0.25)),
    _s("assign.W_WORKLOAD", "Task-assignment weight on spreading work across robots", 0.15, 0.15, 0, 1,
       "editable", "dispatch", integer=False, grid=(0.3, 0.05)),
    _s("assign.W_CONGESTION", "Task-assignment weight on avoiding congested zones", 0.15, 0.15, 0, 1, "editable",
       "dispatch", integer=False, grid=(0.3, 0.05)),
    _s("assign.W_HEALTH", "Task-assignment weight on robot health", 0.10, 0.10, 0, 1, "editable", "dispatch",
       integer=False, grid=(0.2, 0.0)),
    _s("sim.IDLE_TO_PARK_TICKS", "Idle ticks before a ground-floor robot walks to parking", 300, 300, 100, 1200,
       "editable", "dispatch", grid=(150, 600, 100, 900)),
    *[_s(f"zone.{z}.capacity", f"Robots in zone {z} before it reads as congested (only affects assignment scoring)",
         cap, cap, 2, 12, "editable", "dispatch", grid=(cap - 2, cap + 2, 4, 12),
         note="a weak lever: it does not limit how many robots enter the zone (TwinForge finding 8)")
      for z, cap in (("A", 6), ("B", 6), ("C", 6), ("D", 6), ("M", 8))],
    _s("class.HUM-1.capacity", "Load units a HUM-1 robot carries", 1, 1, 1, 1, "editable", "dispatch",
       note="one 16 kg tote, held by the arm"),
    # motion (locked)
    _s("class.HUM-1.max_speed", "Top walking speed of HUM-1 robots (m/s)", 1.5, 1.2, 0.3, 1.5, "locked", "motion",
       integer=False, grid=(1.35, 1.5, 1.0), note="brain v1 runs at 80% of the class's 1.5 m/s; raising it needs a call"),
    _s("sim.PERC_STOP", "LiDAR stopping distance (m)", 1.7, 1.7, 1.2, 5, "locked", "motion", integer=False,
       grid=(1.5, 2.0)),
    _s("sim.PERC_SLOW", "LiDAR slow-down distance (m); at least PERC_STOP", 2.8, 2.8, 1.2, 8, "locked", "motion",
       integer=False, grid=(2.4, 3.2)),
    # never changed by the brain (envelope only)
    _s("sim.MIN_SEP", "Hard minimum distance between robot centres (m)", 0.9, 0.9, 0.9, 0.9, "fixed", None,
       integer=False, note="a brain may restate 0.9; any other value is rejected"),
    _s("sim.HUMAN_CLEARANCE_M", "Scoring: a robot inside this distance of a person is a safety event (m)",
       2.0, 2.0, 2.0, 2.0, "fixed", None, integer=False, note="never approvable"),
    *[_s(f"sim.{k}", "Stair cost: describes the building and the robot, so the spec sets it, never the brain",
         d, v, v, v, "spec", None, integer=False, note="frozen in WP-T (overlay STAIR_COSTS)")
      for k, d, v in (("STAIR_CLIMB_TICKS", 80, 240), ("STAIR_CAPACITY", 99, 2), ("STAIR_LOAD_TICKS", 0, 40),
                      ("BATTERY_STAIR", 0, 0.01))],
    # manipulation: placeholders until TwinForge's quadruped gets its arm and torso lift. min == max keeps them
    # out of the improver's reach (not levers) and the runner never sees them; widen the range once it serves them.
    *[_s(f"sim.GRASP_SPEED_PCT_L{n}", f"Arm speed when picking from or placing on shelf level {n} "
         "(% of top speed; slower is steadier)", 100, 100, 100, 100, "editable", "manipulation", integer=False,
         note="placeholder: no engine setting yet; names follow the runner once it adds the arm")
      for n in (1, 2, 3, 4)],
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
    if t.startswith("sim.GRASP_") or t.startswith("sim.REACH_") or t.startswith("sim.TORSO_"):
        return "manipulation"
    return None


def from_settings_response(resp: SettingsResponse) -> list[Setting]:
    """The runner's registry, keeping our lever groups and grids where the target is known."""
    known = {s.target: s for s in SETTINGS}
    out = []
    for d in resp.settings:
        k = known.get(d.target)
        integer = bool((d.model_extra or {}).get("integer", False))
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


def rule_text(target: str, value: float) -> tuple[str, str]:
    """Team doc 03's free-text `when` / `then` for a component that compiles to one setting.
    The text is for people and agents; `compiles_to` is what the engine runs. Ticks are 100 ms."""
    v = value
    s = lambda ticks: f"{ticks / 10:g} s"
    if target == "sim.STAIR_MIN_LIFT_QUEUE":
        if v >= 99:
            return "a robot must change floors", "queue for the freight lift (never the stairs)"
        if v <= 0:
            return "a robot must change floors", "take the west stairs (never the lift)"
        return (f"a robot must change floors and the best lift's queue has {v:g} or more robots",
                "take the west stairs instead of waiting for the lift")
    if target == "sim.STAIR_MAX_LOAD":
        return "a robot must change floors", ("use the stairs only when empty" if v < 1
                                              else f"use the stairs carrying up to {v:g} load units")
    fixed = {
        "sim.WAIT_REPLAN_TICKS": (f"a robot has been blocked for {s(v)}", "replan its route"),
        "sim.WAIT_BACKOFF_TICKS": (f"a robot has been blocked for {s(v)}", "back off and let the other robot pass"),
        "sim.LIFT_RETRY_TICKS": ("the chosen lift is busy", f"try again after {s(v)}"),
        "sim.LIFT_XFLOOR_PENALTY_M": ("assigning a task on another floor", f"count the trip as {v:g} m longer"),
        "sim.CHARGE_AT_PCT": (f"battery is at {v:g}% or less", "go to a charger"),
        "sim.IDLE_TO_PARK_TICKS": (f"a robot has been idle for {s(v)}", "go to a parking spot"),
        "class.HUM-1.max_speed": ("always", f"walk no faster than {v:g} m/s"),
        "class.HUM-1.capacity": ("picking", f"carry at most {v:g} load units"),
        "sim.PERC_STOP": (f"an obstacle is within {v:g} m", "stop"),
        "sim.PERC_SLOW": (f"an obstacle is within {v:g} m", "slow down"),
        "sim.MIN_SEP": (f"another robot is within {v:g} m", "hold position"),
    }
    if target in fixed:
        return fixed[target]
    if target.startswith("assign.W_"):
        return "choosing a robot for a task", f"weigh {target.removeprefix('assign.W_').lower()} at {v:g}"
    if target.startswith("zone.") and target.endswith(".capacity"):
        return f"zone {target.split('.')[1]} holds {v:g} robots", "treat it as congested when assigning"
    if target.startswith("sim.GRASP_SPEED_PCT_L"):
        return (f"picking from or placing on shelf level {target.removeprefix('sim.GRASP_SPEED_PCT_L')}",
                f"move the arm at {v:g}% of its top speed")
    return "always", f"set {target} to {v:g}"


def with_overrides(settings: list[Setting], **changes) -> list[Setting]:
    """Copy with some fields changed per target: with_overrides(S, **{"sim.X": {"v1": 3}})."""
    return [replace(s, **changes[s.target]) if s.target in changes else s for s in settings]
