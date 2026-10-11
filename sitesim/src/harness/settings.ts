/**
 * The settings registry served at GET /settings: every knob the brain may set, with its status,
 * bounds, engine default and v1 (first-day) value. This is the single source of truth; kg/registry.py
 * mirrors it until sync_settings() pulls this table over HTTP.
 *
 *   editable  the brain may set it within [min, max]
 *   locked    differs from v1 only with a human approval (the phone call)
 *   fixed     locked and never approvable; any edit is rejected
 *   spec      describes the building or the robot; never set by the brain
 *
 * Targets: sim.<SETTING> | assign.<W_*> (compiles to sim.W_*) | class.<CLASS_ID>.<field> | zone.<ZONE_ID>.capacity
 */
import { SIM } from "../engine/engine";

export type SettingStatus = "editable" | "locked" | "fixed" | "spec";

export interface SettingDef {
  target: string;
  description: string;
  engine_default: number;
  v1: number;
  min: number;
  max: number;
  status: SettingStatus;
  integer: boolean;
  note?: string;
}

export const ROBOT_CLASS_ID = "HUM-1";
export const SPEC_ID = "warehouse-humanoid";

const s = (target: string, description: string, engine_default: number, v1: number, min: number, max: number,
  status: SettingStatus, integer = true, note?: string): SettingDef => ({ target, description, engine_default, v1, min, max, status, integer, note });

export const SETTINGS: SettingDef[] = [
  // floor_change
  s("sim.STAIR_MIN_LIFT_QUEUE", "Take the stairs when the best lift's queue holds at least this many robots", SIM.STAIR_MIN_LIFT_QUEUE, 99, 0, 99, "editable", true,
    "engine default 0 = always stairs; v1 99 = only when no lift works"),
  s("sim.STAIR_MAX_LOAD", "...and only when carrying at most this many load units (0 = only empty-handed)", SIM.STAIR_MAX_LOAD, 99, 0, 99, "editable", true,
    "values at or above the class capacity (HUM-1 carries 1) mean no load limit"),
  s("sim.LIFT_RETRY_TICKS", "Ticks between retries when the chosen lift has faulted", SIM.LIFT_RETRY_TICKS, 50, 20, 200, "editable"),
  s("sim.LIFT_XFLOOR_PENALTY_M", "Metres added to a cross-floor candidate's distance in task assignment", SIM.LIFT_XFLOOR_PENALTY_M, 40, 0, 100, "editable", false),
  // waiting
  s("sim.WAIT_REPLAN_TICKS", "Ticks blocked before a robot replans its route", SIM.WAIT_REPLAN_TICKS, 25, 10, 80, "editable"),
  s("sim.WAIT_BACKOFF_TICKS", "Ticks blocked before a robot backs off to break a deadlock", SIM.WAIT_BACKOFF_TICKS, 80, 30, 200, "editable"),
  // energy
  s("sim.CHARGE_AT_PCT", "An idle robot below this battery % goes to charge", SIM.CHARGE_AT_PCT, 35, 25, 60, "editable", false),
  s("assign.W_BATTERY", "Task-assignment weight on battery level", SIM.W_BATTERY, 0.25, 0, 1, "editable", false),
  // dispatch
  s("assign.W_DISTANCE", "Task-assignment weight on distance to the task", SIM.W_DISTANCE, 0.35, 0, 1, "editable", false),
  s("assign.W_WORKLOAD", "Task-assignment weight on spreading work across robots", SIM.W_WORKLOAD, 0.15, 0, 1, "editable", false),
  s("assign.W_CONGESTION", "Task-assignment weight on avoiding congested zones", SIM.W_CONGESTION, 0.15, 0, 1, "editable", false),
  s("assign.W_HEALTH", "Task-assignment weight on robot health", SIM.W_HEALTH, 0.1, 0, 1, "editable", false),
  s("sim.IDLE_TO_PARK_TICKS", "Idle ticks before a ground-floor robot walks to parking", SIM.IDLE_TO_PARK_TICKS, 300, 100, 1200, "editable"),
  ...(["A", "B", "C", "D", "M"] as const).map((z) => s(`zone.${z}.capacity`, `Robots in zone ${z} before it reads as congested (only affects assignment scoring)`,
    z === "M" ? 8 : 6, z === "M" ? 8 : 6, 2, 12, "editable", true, "a weak lever: it does not limit how many robots enter the zone")),
  s(`class.${ROBOT_CLASS_ID}.capacity`, "Load units a HUM-1 robot carries", 1, 1, 1, 1, "editable", true, "one 16 kg tote, held by the arm"),
  // motion (locked)
  s(`class.${ROBOT_CLASS_ID}.max_speed`, "Top walking speed of HUM-1 robots (m/s)", 1.5, 1.2, 0.3, 1.5, "locked", false,
    "brain v1 runs at 80% of the class's 1.5 m/s; raising it needs a call"),
  s("sim.PERC_STOP", "LiDAR stopping distance (m)", SIM.PERC_STOP, 1.7, 1.2, 5, "locked", false),
  s("sim.PERC_SLOW", "LiDAR slow-down distance (m); at least PERC_STOP", SIM.PERC_SLOW, 2.8, 1.2, 8, "locked", false),
  // never changed by the brain
  s("sim.MIN_SEP", "Hard minimum distance between robot centres (m)", SIM.MIN_SEP, 0.9, 0.9, 0.9, "fixed", false, "a brain may restate 0.9; any other value is rejected"),
  s("sim.HUMAN_CLEARANCE_M", "Scoring: a robot inside this distance of a person is a safety event (m)", SIM.HUMAN_CLEARANCE_M, 2.0, 2.0, 2.0, "fixed", false, "never approvable"),
  // spec: frozen stair costs (the building and the robot, not the brain)
  s("sim.STAIR_CLIMB_TICKS", "Stair cost: ticks to climb one flight", 80, 240, 240, 240, "spec", false, "frozen: describes the building and the robot"),
  s("sim.STAIR_CAPACITY", "Stair cost: robots allowed on the flight at once", 99, 2, 2, 2, "spec", false, "frozen"),
  s("sim.STAIR_LOAD_TICKS", "Stair cost: extra ticks when climbing loaded", 0, 40, 40, 40, "spec", false, "frozen"),
  s("sim.BATTERY_STAIR", "Stair cost: battery % per tick on the stairs", 0, 0.01, 0.01, 0.01, "spec", false, "frozen"),
  // manipulation placeholders (pinned; the arm renders but has no engine setting yet)
  ...([1, 2, 3, 4] as const).map((n) => s(`sim.GRASP_SPEED_PCT_L${n}`, `Arm speed when picking from or placing on shelf level ${n} (% of top speed)`,
    100, 100, 100, 100, "editable", false, "placeholder: no engine setting yet")),
];

export const SETTINGS_BY_TARGET: Record<string, SettingDef> = Object.fromEntries(SETTINGS.map((d) => [d.target, d]));

/** The spec-level values the registry says v1 (and every brain) runs with, applied to the EnvSpec before any brain. */
export const SPEC_SIM_OVERLAY: Record<string, number> = Object.fromEntries(
  SETTINGS.filter((d) => d.status === "spec").map((d) => [d.target.replace(/^sim\./, ""), d.v1]),
);
