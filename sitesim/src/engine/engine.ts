/**
 * The TwinForge simulation engine — deterministic code that consumes a CompiledSite.
 *
 * Principles
 *  - The engine contains ZERO environment-specific constants. Geometry, fleet,
 *    task grammar, KPI targets and theme all come from the EnvSpec. A new
 *    environment is a new spec file, never an engine change.
 *  - Deterministic: all randomness flows from a seeded PRNG; the clock is never
 *    read. Same seed + same inputs → same trajectory.
 *  - Pure data: state is a JSON-serializable TwinState (clonable for what-if).
 *  - Fixed tick = 100 ms of simulated time.
 *
 * Per-tick order: injections → task generation → assignment → occupancy →
 * lifts → perception → per-robot FSM/motion/battery → zones → traffic decay →
 * KPI/devices → series → prune.
 */
import type { CompiledSite } from "../compiler/compile";
import type { NavGrid } from "../compiler/navgrid";
import type { SpecLift, SpecLocation, SpecRobotClass, StairsFixture } from "../spec/types";
import type {
  TwinState, PerceivedObstacle, RobotState, TaskState, TwinEvent, AlertState, AiDecision, DecisionCandidate,
  GridCell, RobotFsmState, RobotStatus, EventType, Severity, TaskPriority, ScenarioInjection,
  RobotLocomotion,
} from "../schema/twin_state";
import { THRESHOLDS } from "../schema/twin_state";
import { astar, cellKey, cellCenter, isWalkable, nearestWalkable, toCell } from "./astar";
import { mulberry32 } from "./rng";
import { taskError } from "./rules";

// ─────────────────────────────────────────────────────────────
// Default simulation parameters. Any of these can be overridden
// per-environment through EnvSpec.sim — the engine never hardcodes
// a value a spec might legitimately want to change.
// ─────────────────────────────────────────────────────────────
export const SIM = {
  TICK_S: THRESHOLDS.TICK_MS / 1000,
  MAX_SPEED: 1.5,            // m/s
  ACCEL: 1.2,                // m/s²
  TURN_SLOW: 0.5,            // speed cap ratio while turning
  PICK_TICKS: 40,            // 4 s dwell at pickup
  DROP_TICKS: 30,
  BATTERY_MOVE: 0.010,       // %/tick at full speed
  BATTERY_LOAD: 0.004,       // extra while loaded
  BATTERY_IDLE: 0.0008,
  CHARGE_RATE: 0.06,         // %/tick → 0→95% ≈ 160 s
  WAIT_REPLAN_TICKS: 25,     // blocked 2.5 s → replan
  WAIT_BACKOFF_TICKS: 80,    // blocked 8 s → yield (deadlock breaker)
  STATION_ARRIVE_CELLS: 2,   // ≤2 cells from a busy station with no free service cell → work in place
  SERVICE_RADIUS: 1,         // service cells = walkable cells within Chebyshev 1 of the access point
  MIN_SEP: 0.9,              // hard center-distance floor between any two robots (m)
  LIFT_SEP: 0.6,             // docking-mode separation near lift gates (m)
  LIFT_SHAFT_HALF_X: 1.4,    // shaft half width — must match the lift renderer
  LIFT_DOOR_HALF_W: 1.12,    // door leaf width
  ROBOT_HALF_LEN: 0.475,
  ROBOT_HALF_W: 0.34,
  LIDAR_RANGE: 4.0,          // fallback when a robot class declares none
  LIDAR_FOV: Math.PI * 1.5,
  PERC_STOP: 1.7,
  PERC_SLOW: 2.8,
  PERC_LOOKAHEAD: 3,
  PERC_EVENT_TICKS: 200,
  LIFT_DOOR_TICKS: 12,
  LIFT_TRAVEL_TICKS: 60,
  LIFT_LEVEL_TICKS: 5,
  LIFT_COOLDOWN_TICKS: 20,
  LIFT_BOARD_SPEED: 0.6,
  LIFT_QUEUE_SPEED: 0.9,
  LIFT_RETRY_TICKS: 50,
  STAIR_CLIMB_TICKS: 80,
  WIND_LIMIT_MPS_DEFAULT: 12,
  LIFT_XFLOOR_PENALTY_M: 40,
  IDLE_TO_PARK_TICKS: 300,
  KPI_EVERY: 10,
  SERIES_EVERY: 600,
  EVENT_RING: THRESHOLDS.EVENT_RING_SIZE,
  ZONE_CAPACITY: 6,
  // ── Brain levers (the harness edits these through the EnvSpec.sim overlay) ──
  STAIR_MIN_LIFT_QUEUE: 0,   // take the stairs when the best lift's queue holds at least this many robots (0 = always stairs)
  STAIR_MAX_LOAD: 99,        // ...and only when carrying at most this many load units (99 = no limit)
  STAIR_CAPACITY: 99,        // robots allowed on one flight at once
  STAIR_LOAD_TICKS: 0,       // extra climb ticks when loaded
  BATTERY_STAIR: 0,          // %/tick while on the stairs
  CHARGE_AT_PCT: 35,         // an idle robot below this battery % goes to charge
  HUMAN_CLEARANCE_M: 2.0,    // scoring only: a robot inside this distance of a person is a safety event
  LIFT_JAM_TICKS: 300,       // a robot queued at a lift for longer than this is a LIFT_QUEUE_JAM failure
  W_DISTANCE: 0.35, W_BATTERY: 0.25, W_WORKLOAD: 0.15, W_CONGESTION: 0.15, W_HEALTH: 0.10,
};

/** One countable failure the harness scores against. */
export interface FailureEntry { type: string; zone: string | null; tick: number; robots: string[]; detail: string; task_id?: string | null }
export type TimeState = "travel" | "lift_wait" | "lift_ride" | "stairs" | "blocked" | "pick_drop";

/**
 * Harness-facing accounting: failures, where task time goes per zone, and safety counters.
 * Engine-private data the headless runner reads after a shift; never enters TwinState.
 */
export interface HarnessStats {
  failures: FailureEntry[];
  failure_counts: Record<string, number>;
  /** zone → time state → ticks (robots with a task, attributed to the task's zone) */
  time: Record<string, Record<TimeState, number>>;
  stair_trips: number;
  separation_pushes: number;
  human_proximity: number;
  near_misses: number;
  battery_strandings: number;
  /** tasks that were generated but dropped because the waiting queue was full, per zone */
  dropped: Record<string, number>;
  /** closed tasks pruned from TwinState, kept so a shift can be scored after the fact */
  closed: Array<Pick<TaskState, "id" | "type" | "status" | "source" | "destination" | "parent_task_id" | "created_tick" | "completed_tick" | "deadline_tick">>;
}
export type SimParams = typeof SIM;

/** Engine-private per-robot runtime (never enters TwinState) */
interface RobotRt {
  backingOff: boolean;
  resumePoint: [number, number] | null;
  dwell: number;
  waitTicks: number;
  target: GridCell | null;
  goalLoc: string | null;
  phase: "TO_SOURCE" | "TO_DEST" | "TO_CHARGER" | "TO_PARK" | null;
  chargerId: string | null;
  idleTicks: number;
  lastBatteryAlert: "NONE" | "WARN" | "CRIT";
  frontId: string | null;
  frontDist: number;
  lastPercEvent: number;
  pending: { point: [number, number]; phase: RobotRt["phase"]; locId: string | null; floor: number } | null;
  liftId: string | null;
  liftExitPhase: null | "TURN_OUT" | "OUT" | "TURN_EXIT" | "GO";
  plannedLiftId: string | null;
  liftStage: null | "TO_LIFT" | "QUEUED" | "BOARDING" | "RIDING" | "ALIGHTING";
  liftEnqueuedTick: number;
  liftRetryTick: number;
  liftExit: [number, number] | null;
  liftBlockedTicks: number;
  stairId: string | null;
  stairUntilTick: number;
  basePoint: [number, number];
  returningBase: boolean;
  /** Worker-decision overrides (see applyDecision) */
  holdUntilTick: number;
  floorPref: "stairs" | "lift" | null;
}

export interface EngineOptions {
  seed?: number;
  /** Deploy only the first N entries of spec.fleet.spawns (default: all). */
  agents?: number;
  /** Robot id → allowed task type ids. A robot not listed takes any task. */
  allotment?: Record<string, string[]>;
  /** Task type id → generation weight, overriding spec.tasks.types[].weight. */
  taskMix?: Record<string, number>;
}

export class SimEngine {
  readonly site: CompiledSite;
  readonly P: SimParams;
  readonly grids: Record<number, NavGrid>;
  readonly grid: NavGrid; // ground floor (heatmap/traffic reference)
  state: TwinState;
  /** Long-term traffic per floor (very slow decay): HEATMAP + A* congestion cost */
  traffic: Record<number, Float32Array>;
  /** Short-term traffic per floor (~20 s memory): TRAFFIC view */
  trafficShort: Record<number, Float32Array>;
  private rng: () => number;
  private rt: Record<string, RobotRt> = {};
  private loc: Record<string, SpecLocation>;
  private locsByKind: Record<string, SpecLocation[]> = {};
  private classes: Record<string, SpecRobotClass>;
  private occupancy = new Map<string, string>(); // `${floor}:${c},${r}` → robotId
  private liftMoveFromY: Record<string, number> = {};
  private nextTaskTick = 0;
  private taskSeq = 3812;
  private eventSeq = 0;
  private decisionSeq = 0;
  private chargerBusy: Record<string, string | null> = {};
  private blockedZones = new Set<string>();
  private congestedZones = new Map<string, { level: number; until: number }>();
  private highWind: { windMps: number; until: number } | null = null;
  private platformMotion: { severity: number; until: number } | null = null;
  private fog: { level: number; until: number } | null = null;
  private gasLeaks = new Map<string, number>();
  private droppedObjects = new Map<string, number>();
  private commsBlackouts = new Map<string, number>();
  private pendingInjections: ScenarioInjection[] = [];
  private taskTimes: number[] = [];
  private onTime = 0; private completedCount = 0;
  private lastSeriesTick = 0;
  /** Harness accounting (see HarnessStats). Public and read-only for the headless runner. */
  readonly harness: HarnessStats = { failures: [], failure_counts: {}, time: {}, stair_trips: 0, separation_pushes: 0, human_proximity: 0, near_misses: 0, battery_strandings: 0, dropped: {}, closed: [] };
  private jamReported = new Set<string>();
  private proximityUntil: Record<string, number> = {};
  private nearMissUntil: Record<string, number> = {};
  /** Optional worker hook: called at an exception point with the robot; may return an action to apply. */
  onException: ((r: RobotState, kind: "OBSTACLE_DETECTED" | "FLOOR_CHOICE", ctx: Record<string, unknown>) => void) | null = null;
  /** Launch-screen choices (see EngineOptions); all optional, absent = spec defaults. */
  private readonly agents: number | undefined;
  private readonly allotment: Record<string, string[]> | undefined;
  private readonly taskMix: Record<string, number> | undefined;

  constructor(site: CompiledSite, opts: EngineOptions = {}) {
    this.site = site;
    this.agents = opts.agents;
    this.allotment = opts.allotment;
    this.taskMix = opts.taskMix;
    this.P = { ...SIM, ...(site.spec.sim ?? {}) } as SimParams;
    this.grids = site.grids;
    this.grid = site.grids[1];
    const n = this.grid.cols * this.grid.rows;
    this.traffic = {}; this.trafficShort = {};
    for (const f of site.spec.floors) { this.traffic[f.id] = new Float32Array(n); this.trafficShort[f.id] = new Float32Array(n); }
    this.loc = site.locations;
    for (const l of site.spec.locations) (this.locsByKind[l.kind] ??= []).push(l);
    this.classes = Object.fromEntries(site.spec.fleet.classes.map((c) => [c.id, c]));
    const seed = opts.seed ?? 42;
    this.rng = mulberry32(seed);
    for (const c of site.chargers) this.chargerBusy[c.id] = null;
    this.state = this.buildInitialState(seed);
    for (const id of Object.keys(this.state.robots)) {
      const r = this.state.robots[id];
      this.rt[id] = { backingOff: false, resumePoint: null, dwell: 0, waitTicks: 0, target: null, goalLoc: null, phase: null, chargerId: null, idleTicks: 0, lastBatteryAlert: "NONE", frontId: null, frontDist: Infinity, lastPercEvent: -1e9, pending: null, liftId: null, liftExitPhase: null, plannedLiftId: null, liftStage: null, liftEnqueuedTick: 0, liftRetryTick: 0, liftExit: null, liftBlockedTicks: 0, stairId: null, stairUntilTick: 0, basePoint: [r.position[0], r.position[2]], returningBase: false, holdUntilTick: 0, floorPref: null };
    }
    this.nextTaskTick = this.state.sim.tick + 10;
  }

  // ─────────────────────────────────────────────────────────
  // Initial state — everything from the spec
  // ─────────────────────────────────────────────────────────
  private buildInitialState(seed: number): TwinState {
    const S = this.site, spec = S.spec;
    const robots: Record<string, RobotState> = {};
    const spawns = this.agents !== undefined ? spec.fleet.spawns.slice(0, Math.max(1, this.agents)) : spec.fleet.spawns;
    for (const sp of spawns) {
      const cls = this.classes[sp.class];
      robots[sp.id] = {
        id: sp.id, model: sp.class, locomotion: this.locomotion(cls), position: [Math.floor(sp.position[0]) + 0.5, sp.position[1] ?? 0, Math.floor(sp.position[2]) + 0.5], heading: sp.heading, velocity: 0,
        max_speed: cls?.max_speed ?? this.P.MAX_SPEED, floor: sp.floor ?? 1, lift_id: null, lift_stage: null,
        battery: sp.battery, status: "IDLE", fsm: "IDLE", health: 95 + Math.floor(this.rng() * 5), current_task_id: null, destination: null,
        path: [], path_index: 0, load: { current: 0, capacity: cls?.capacity ?? 4 }, zone: null, eta_s: null, fsm_since_tick: 0,
        stats: { distance_m: 0, tasks_completed: 0, energy_wh: 0, busy_ticks: 0, wait_ticks: 0 },
        perception: { state: "CLEAR", ahead_m: cls?.lidar.range_m ?? this.P.LIDAR_RANGE, nearest_m: null, obstacles: [], confidence: 1 },
        ...(this.locomotion(cls) === "aerial" ? {
          flight: {
            mode: "GROUNDED" as const,
            waypoints: [],
            waypoint_index: 0,
            altitude: sp.position[1] ?? 0,
            home: [sp.position[0], sp.position[1] ?? 0, sp.position[2]] as [number, number, number],
            signal_lost: false,
            flight_ticks: 0,
          },
        } : {}),
        ...(this.locomotion(cls) === "static" ? { monitoring: { active: true, observations: 0, confidence: 1 } } : {}),
      };
    }
    return {
      schema_version: "2.0", spec_id: spec.meta.id,
      sim: { tick: 0, tick_ms: THRESHOLDS.TICK_MS, speed: 1, mode: "LIVE", seed, baseline_snapshot_id: null },
      robots, tasks: {},
      lifts: Object.fromEntries(spec.lifts.map((l) => [l.id, {
        id: l.id, state: "IDLE" as const, floor: l.floors[0], target_floor: null, y: this.elevOf(l.floors[0]),
        doors: Object.fromEntries(l.floors.map((f) => [String(f), "CLOSED" as const])),
        occupant: null, reserved_by: null, queue: Object.fromEntries(l.floors.map((f) => [String(f), [] as string[]])),
        until_tick: 0, fault: false, fault_remaining: 0, trips: 0, busy_ticks: 0, wait_total_ticks: 0, wait_n: 0,
      }])),
      zones: Object.fromEntries(spec.zones.map((z) => [z.id, { id: z.id, status: "NORMAL" as const, robot_count: 0, congestion: 0, blocked_reason: null, blocked_since_tick: null }])),
      conveyors: Object.fromEntries(S.conveyors.map((c) => [c.id, { id: c.id, status: "RUNNING" as const, speed_mps: c.speed_mps, items_on_belt: 4, throughput_per_min: 4 }])),
      cameras: Object.fromEntries(spec.cameras.map((c) => [c.id, { id: c.id, zone: c.zone, status: "ONLINE" as const, confidence: 1 }])),
      sensors: Object.fromEntries(spec.sensors.map((s) => [s.id, { id: s.id, kind: s.kind, zone: s.zone, status: "ONLINE" as const, value: null, unit: null }])),
      people: {}, alerts: {}, recent_events: [], recent_decisions: [],
      kpi: {
        tick: 0, fleet: { total: Object.keys(robots).length, active: 0, charging: 0, idle: Object.keys(robots).length, warning: 0, error: 0, offline: 0 },
        operation: { throughput_per_min: 0, completed_today: 0, completed_target: spec.kpis.completed_target, pending: 0, ongoing: 0, avg_task_time_s: 0, on_time_rate: 1, avg_utilization: 0 },
        efficiency: { avg_travel_distance_m: 0, avg_wait_time_s: 0, congestion_index: 0, energy_kwh: 0 },
        throughput_series: [{ tick: 0, completed: 0, target: 0 }],
        lifts: { trips: 0, utilization: 0, avg_wait_s: 0, faults: 0 },
      },
      subsystems: Object.fromEntries(spec.theme.subsystems.map((s) => [s.key, "NORMAL" as const])),
    };
  }

  private locomotion(cls: SpecRobotClass | undefined): RobotLocomotion {
    return cls?.locomotion ?? "wheeled";
  }
  private robotClass(r: RobotState): SpecRobotClass | undefined { return this.classes[r.model]; }
  private isAerial(r: RobotState): boolean { return r.locomotion === "aerial"; }
  private isStatic(r: RobotState): boolean { return r.locomotion === "static"; }
  private allowsStairs(r: RobotState): boolean {
    const cls = this.robotClass(r);
    return r.locomotion === "legged" && cls?.can_climb_stairs === true;
  }
  private astarOptions(r: RobotState, floor: number, blocked?: Set<string>) {
    const cls = this.robotClass(r);
    const routeBlocked = new Set(blocked ?? []);
    for (const z of this.site.spec.zones) {
      if ((z.floor ?? 1) !== floor || z.ex_zone === undefined || z.ex_zone === "safe" || z.ex_zone === 2) continue;
      if ((this.robotClass(r)?.ex_certified_zones ?? []).includes(z.ex_zone)) continue;
      const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
      for (let c = Math.floor(Math.min(...xs)); c < Math.ceil(Math.max(...xs)); c++)
        for (let row = Math.floor(Math.min(...zs)); row < Math.ceil(Math.max(...zs)); row++) routeBlocked.add(cellKey(c, row));
    }
    for (const zoneId of this.gasLeaks.keys()) {
      const z = this.site.spec.zones.find((zone) => zone.id === zoneId);
      if (!z || (z.floor ?? 1) !== floor) continue;
      const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
      if ((this.robotClass(r)?.ex_certified_zones ?? []).includes(0)) continue;
      for (let c = Math.floor(Math.min(...xs)); c < Math.ceil(Math.max(...xs)); c++)
        for (let row = Math.floor(Math.min(...zs)); row < Math.ceil(Math.max(...zs)); row++) routeBlocked.add(cellKey(c, row));
    }
    for (const zoneId of this.droppedObjects.keys()) {
      const z = this.site.spec.zones.find((zone) => zone.id === zoneId);
      if (!z || (z.floor ?? 1) !== floor) continue;
      const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
      for (let c = Math.floor(Math.min(...xs)); c < Math.ceil(Math.max(...xs)); c++)
        for (let row = Math.floor(Math.min(...zs)); row < Math.ceil(Math.max(...zs)); row++) routeBlocked.add(cellKey(c, row));
    }
    return {
      blocked: routeBlocked,
      costMap: this.congestionCost(floor),
      allowStairs: this.allowsStairs(r),
      terrainTolerance: cls?.terrain_tolerance,
      minClearanceCells: cls?.min_clearance_cells,
    };
  }

  // ─────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────
  inject(inj: ScenarioInjection) {
    this.pendingInjections.push(inj);
    this.emit("SCENARIO_INJECTED", "USER", "INFO", `Scenario injected: ${inj.kind}${"zone_id" in inj ? " (Zone " + inj.zone_id + ")" : "robot_id" in inj ? " (" + inj.robot_id + ")" : "conveyor_id" in inj ? " (" + inj.conveyor_id + ")" : "camera_id" in inj ? " (" + inj.camera_id + ")" : ""}`);
  }

  /** Apply a worker-agent decision (see harness/worker_bridge WORKER_ACTIONS). Never throws; unknown robot/action → no-op. */
  applyDecision(robotId: string, action: string, args: Record<string, unknown> = {}) {
    const r = this.state.robots[robotId], rt = this.rt[robotId];
    if (!r || !rt || r.fsm === "OFFLINE") return;
    const rationale = typeof args.rationale === "string" && args.rationale ? ` — ${args.rationale}` : "";
    let note = "";
    switch (action) {
      case "continue": break;
      case "reroute": if (rt.target && !r.lift_id) this.setFsm(r, "OBSTACLE_DETECTED"); else note = " (no target)"; break;
      case "wait_at_holding_point": { const n = Math.max(1, Math.min(600, Number(args.ticks) || 50)); rt.waitTicks = 0; rt.holdUntilTick = this.state.sim.tick + n; note = ` ${n} ticks`; break; }
      case "go_charge": if (!r.load.current && !r.lift_id && this.freeCharger() && rt.phase !== "TO_CHARGER" && r.fsm !== "CHARGING") { this.transferTask(r); rt.pending = null; this.goCharge(r, rt); } else note = " (skipped)"; break;
      case "swap_task": if (r.current_task_id) { this.transferTask(r); rt.phase = null; rt.target = null; rt.pending = null; r.path = []; r.path_index = 0; this.setFsm(r, "IDLE"); } else note = " (no task)"; break;
      case "take_stairs": rt.floorPref = "stairs"; break;
      case "take_lift": rt.floorPref = "lift"; break;
      case "move_to": case "pick": case "place": note = " (intent noted; FSM handles it)"; break;
      default: note = " (unknown action)";
    }
    this.emit("AI_DECISION", "AI_AGENT", "INFO", `${robotId} worker: ${action}${note}${rationale}`, { robot_id: robotId, task_id: r.current_task_id ?? undefined, zone_id: r.zone ?? undefined });
    this.routeDecision(r, `${robotId} worker decision: ${action}${note}${rationale}`);
  }

  clearInjection(kind: ScenarioInjection["kind"], targetId: string) {
    const S = this.state;
    switch (kind) {
      case "ROBOT_FAILURE": { const r = S.robots[targetId]; if (r && r.fsm === "OFFLINE") { this.setFsm(r, "IDLE"); this.rt[r.id].phase = null; this.rt[r.id].target = null; this.resolveAlert(`off-${r.id}`); this.emit("ROBOT_ONLINE", "USER", "INFO", `${r.id} back online`, { robot_id: r.id }); } break; }
      case "CONVEYOR_FAILURE": { const c = S.conveyors[targetId]; const lc = this.site.conveyors.find((x) => x.id === targetId); if (c && lc) { c.status = "RUNNING"; c.speed_mps = lc.speed_mps; this.resolveAlert(`cv-${c.id}`); this.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "INFO", `${c.id} restored — RUNNING`, { conveyor_id: c.id }); } break; }
      case "CAMERA_OFFLINE": { const c = S.cameras[targetId]; if (c) { c.status = "ONLINE"; if ("CCTV" in S.subsystems && Object.values(S.cameras).every((x) => x.status === "ONLINE")) S.subsystems.CCTV = "NORMAL"; this.emit("CAMERA_STATUS_CHANGED", "CAMERA", "INFO", `${c.id} online`, { camera_id: c.id }); } break; }
      case "HUMAN_INTRUSION": { for (const pid in S.people) if (S.people[pid].zone === targetId) S.people[pid].expires_tick = S.sim.tick; break; }
      case "TRAFFIC_CONGESTION": { this.congestedZones.delete(targetId); this.emit("ZONE_UNBLOCKED", "USER", "INFO", `Zone ${targetId} traffic restriction lifted`, { zone_id: targetId }); break; }
      case "LIFT_FAULT": { const L = S.lifts[targetId]; if (L && L.fault) { L.fault = false; L.until_tick = S.sim.tick + L.fault_remaining; L.fault_remaining = 0; this.resolveAlert(`lift-${targetId}`); this.emit("LIFT_FAULT", "LIFT", "INFO", `${targetId} restored — resuming`, {}); } break; }
      case "DRONE_SIGNAL_LOST": { const r = S.robots[targetId]; if (r?.flight) { r.flight.signal_lost = false; if (r.flight.mode === "GROUNDED") this.resolveAlert(`sig-${targetId}`); this.emit("ROBOT_STATE_CHANGED", "USER", "INFO", `${targetId} signal restored`, { robot_id: targetId }); } break; }
      case "HIGH_WIND": { this.highWind = null; this.resolveAlert("wind"); this.emit("ROBOT_STATE_CHANGED", "USER", "INFO", "High wind cleared — aerial operations may resume", {}); break; }
      case "PLATFORM_MOTION": { this.platformMotion = null; this.resolveAlert("motion"); this.emit("ROBOT_STATE_CHANGED", "USER", "INFO", "Platform motion cleared", {}); break; }
      case "FOG": { this.fog = null; this.resolveAlert("fog"); this.emit("ROBOT_STATE_CHANGED", "USER", "INFO", "Fog cleared — sensor confidence restored", {}); break; }
      case "GAS_LEAK": { this.gasLeaks.delete(targetId); this.resolveAlert(`gas-${targetId}`); this.emit("ZONE_UNBLOCKED", "USER", "INFO", `Gas leak cleared — Zone ${targetId} restored`, { zone_id: targetId }); break; }
      case "DROPPED_OBJECT": { this.droppedObjects.delete(targetId); this.resolveAlert(`drop-${targetId}`); this.emit("ZONE_UNBLOCKED", "USER", "INFO", `Dropped object cleared — Zone ${targetId} restored`, { zone_id: targetId }); break; }
      case "COMMS_BLACKOUT": {
        this.commsBlackouts.delete(targetId);
        const r = S.robots[targetId];
        if (r) {
          const rt = this.rt[targetId];
          rt.returningBase = false; rt.target = null; rt.phase = null; r.path = []; r.path_index = 0;
          this.resolveAlert(`comms-${targetId}`);
          this.emit("ROBOT_STATE_CHANGED", "USER", "INFO", `${targetId} communications restored`, { robot_id: targetId });
        }
        break;
      }
      default: break;
    }
  }

  createTask(t: { type: string; priority: TaskPriority; source: string; destination: string; load_units?: number; level?: number }): TaskState {
    const err = taskError(this.loc, this.site.spec.tasks.types, t.type, t.source, t.destination);
    if (err) throw new Error(err);
    const id = `A${this.taskSeq++}`;
    const task: TaskState = { id, type: t.type, priority: t.priority, status: "WAITING", source: t.source, destination: t.destination, assigned_robot: null, parent_task_id: null, created_tick: this.state.sim.tick, assigned_tick: null, started_tick: null, completed_tick: null, deadline_tick: this.state.sim.tick + this.site.spec.tasks.on_time_limit_ticks, eta_s: null, load_units: t.load_units ?? 1, ...(t.level !== undefined ? { level: t.level } : {}) };
    this.state.tasks[id] = task;
    this.emit("TASK_CREATED", "SIMULATION", "INFO", `Task #${id} created (${t.type} ${this.pretty(t.source)} → ${this.pretty(t.destination)})`, { task_id: id });
    return task;
  }

  step() {
    const S = this.state; S.sim.tick++;
    const tick = S.sim.tick;
    this.applyInjections();
    this.generateTasks();
    this.assignTasks();
    this.rebuildOccupancy();
    this.stepLifts();
    for (const id of Object.keys(S.robots)) this.updatePerception(S.robots[id], this.rt[id]);
    for (const id of Object.keys(S.robots)) this.stepRobot(S.robots[id], this.rt[id]);
    this.enforceRobotSeparation();
    this.accountHarness();
    this.updateZones();
    this.decayTraffic();
    if (tick % this.P.KPI_EVERY === 0) { this.updateKpi(); this.updateDevices(); }
    if (tick - this.lastSeriesTick >= this.P.SERIES_EVERY) this.pushSeries();
    this.pruneTasks();
  }

  private enforceRobotSeparation() {
    const robots = Object.values(this.state.robots).filter((r) => r.status !== "OFFLINE" && !r.lift_id);
    for (let i = 0; i < robots.length; i++) for (let j = i + 1; j < robots.length; j++) {
      const a = robots[i], b = robots[j];
      if (a.floor !== b.floor) continue;
      const dx = a.position[0] - b.position[0], dz = a.position[2] - b.position[2];
      const d = Math.hypot(dx, dz);
      if (d >= this.P.MIN_SEP) continue;
      const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
      const push = (this.P.MIN_SEP - d) / 2;
      a.position[0] += nx * push; a.position[2] += nz * push;
      b.position[0] -= nx * push; b.position[2] -= nz * push;
      a.velocity = 0; b.velocity = 0;
      this.harness.separation_pushes++;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Harness accounting: failures, time split, safety
  // ─────────────────────────────────────────────────────────
  /** The zone a task is scored under: the shelf end if there is one, else the destination. */
  taskZone(t: TaskState): string | null {
    const s = this.loc[t.source], d = this.loc[t.destination];
    if (s?.kind === "SHELF") return s.zone;
    if (d?.kind === "SHELF") return d.zone;
    return d?.zone ?? s?.zone ?? null;
  }

  /** Where this tick went for a robot that holds a task. */
  private timeStateOf(r: RobotState, rt: RobotRt): TimeState | null {
    if (!r.current_task_id || r.fsm === "IDLE" || r.fsm === "CHARGING" || r.fsm === "OFFLINE") return null;
    if (rt.stairId && rt.target === null && rt.pending) return "stairs";
    if (rt.liftStage === "RIDING" || rt.liftStage === "ALIGHTING") return "lift_ride";
    if (rt.liftStage === "QUEUED" || rt.liftStage === "BOARDING" || (rt.liftStage === "TO_LIFT" && rt.target === null)) return "lift_wait";
    if (r.fsm === "PICKING" || r.fsm === "DELIVERING") return "pick_drop";
    if (r.velocity < 0.05 && (rt.waitTicks > 0 || r.perception.state === "STOPPED")) return "blocked";
    return "travel";
  }

  recordFailure(type: string, zone: string | null, robots: string[], detail: string, task_id: string | null = null) {
    this.harness.failures.push({ type, zone, tick: this.state.sim.tick, robots, detail, task_id });
    this.harness.failure_counts[type] = (this.harness.failure_counts[type] ?? 0) + 1;
  }

  private accountHarness() {
    const S = this.state, tick = S.sim.tick, H = this.harness;
    const people = Object.values(S.people);
    for (const id in S.robots) {
      const r = S.robots[id], rt = this.rt[id];
      // time split, attributed to the task's zone
      const st = this.timeStateOf(r, rt);
      if (st) {
        const t = S.tasks[r.current_task_id!];
        const z = t ? this.taskZone(t) : null;
        if (z) { const row = (H.time[z] ??= { travel: 0, lift_wait: 0, lift_ride: 0, stairs: 0, blocked: 0, pick_drop: 0 }); row[st]++; }
      }
      // lift queue jam: queued longer than LIFT_JAM_TICKS, reported once per enqueue
      if ((rt.liftStage === "QUEUED" || rt.liftStage === "BOARDING") && rt.liftId) {
        const key = `${id}:${rt.liftEnqueuedTick}`;
        const waited = tick - rt.liftEnqueuedTick;
        if (waited > this.P.LIFT_JAM_TICKS && !this.jamReported.has(key)) {
          this.jamReported.add(key);
          const L = S.lifts[rt.liftId];
          const q = Object.values(L.queue).reduce((a, x) => a + x.length, 0);
          const t = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
          this.recordFailure("LIFT_QUEUE_JAM", (t ? this.taskZone(t) : null) ?? r.zone, [id], `${q} robots queued at ${rt.liftId} for up to ${(waited / 10).toFixed(0)} s`, r.current_task_id);
        }
      }
      // safety: a robot inside HUMAN_CLEARANCE_M of a person (debounced 10 s per robot)
      if (r.status !== "OFFLINE" && (this.proximityUntil[id] ?? -1) < tick) {
        for (const p of people) {
          if ((p.floor ?? 1) !== r.floor) continue;
          if (Math.hypot(r.position[0] - p.position[0], r.position[2] - p.position[2]) < this.P.HUMAN_CLEARANCE_M) {
            H.human_proximity++; this.proximityUntil[id] = tick + 100;
            break;
          }
        }
      }
      // near miss: perception STOPPED with a robot dead ahead within half of PERC_STOP (debounced 5 s)
      if (r.perception.state === "STOPPED" && rt.frontId && rt.frontDist < this.P.PERC_STOP * 0.5 && (this.nearMissUntil[id] ?? -1) < tick) {
        H.near_misses++; this.nearMissUntil[id] = tick + 50;
      }
    }
  }

  /** New reference snapshot for the UI (shallow copies so React sees changes) */
  snapshot(): TwinState {
    const S = this.state;
    const robots: Record<string, RobotState> = {};
    for (const id in S.robots) robots[id] = { ...S.robots[id], position: [...S.robots[id].position] as [number, number, number], path: S.robots[id].path };
    return { ...S, sim: { ...S.sim }, robots, tasks: { ...S.tasks }, zones: { ...S.zones }, alerts: { ...S.alerts }, kpi: { ...S.kpi }, recent_events: S.recent_events.slice(), recent_decisions: S.recent_decisions.slice() };
  }

  // ─────────────────────────────────────────────────────────
  // Tasks — generation is entirely spec grammar driven
  // ─────────────────────────────────────────────────────────
  private generateTasks() {
    const S = this.state; const T = this.site.spec.tasks;
    if (S.sim.tick < this.nextTaskTick) return;
    this.nextTaskTick = S.sim.tick + Math.round(T.interval_ticks * (0.5 + this.rng()));
    const waiting = Object.values(S.tasks).filter((t) => t.status === "WAITING").length;
    const full = waiting >= T.max_waiting;
    const rPr = this.rng();
    let pr: TaskPriority = "NORMAL", acc = 0;
    for (const [band, prio] of T.priority_bands) { acc += band; if (rPr < acc) { pr = prio; break; } }
    const rTy = this.rng();
    const weightOf = (t: { id: string; weight: number }) => this.taskMix?.[t.id] ?? t.weight;
    const total = T.types.reduce((a, t) => a + weightOf(t), 0) || 1;
    let chosen = T.types[T.types.length - 1], cum = 0;
    for (const t of T.types) { cum += weightOf(t) / total; if (rTy < cum) { chosen = t; break; } }
    if (!chosen) return;
    const pick = (kinds: string[]): SpecLocation | undefined => {
      const pool = kinds.flatMap((k) => this.locsByKind[k] ?? []);
      return pool.length ? pool[Math.floor(this.rng() * pool.length)] : undefined;
    };
    const src = pick(chosen.gen_source_kinds), dst = pick(chosen.gen_dest_kinds);
    if (!src || !dst || src.id === dst.id) return;
    // Shelf level: drawn from the shelf endpoint's level_range so the arm has something to reach for
    const shelf = src.kind === "SHELF" ? src : dst.kind === "SHELF" ? dst : null;
    const lr = shelf?.level_range;
    const level = lr ? lr[0] + Math.floor(this.rng() * (lr[1] - lr[0] + 1)) : undefined;
    if (full) {
      const z = shelf?.zone ?? dst.zone;
      this.harness.dropped[z] = (this.harness.dropped[z] ?? 0) + 1;
      this.recordFailure("DROPPED_DEMAND", z, [], `${chosen.id} ${src.id} → ${dst.id} dropped: ${waiting} tasks already waiting`);
      return;
    }
    this.createTask({ type: chosen.id, priority: pr, source: src.id, destination: dst.id, level });
  }

  /** Fleet Manager: weighted distance + battery + workload + congestion + health, with an explainable candidate list */
  private exZoneReason(r: RobotState, zoneId: string | undefined): string | null {
    if (!zoneId) return null;
    const z = this.site.spec.zones.find((x) => x.id === zoneId);
    if (!z) return null;
    if (this.droppedObjects.has(zoneId)) return `zone ${zoneId} blocked by dropped object`;
    const required = this.gasLeaks.has(zoneId) ? 0 : z.ex_zone;
    if (required === undefined || required === "safe" || required === 2) return null;
    const certs = this.robotClass(r)?.ex_certified_zones ?? [];
    if (!certs.includes(required)) {
      return this.gasLeaks.has(zoneId)
        ? `not Ex-certified for gas-leak zone ${zoneId}`
        : `not Ex-certified for ZONE ${required} (${z.name})`;
    }
    return null;
  }

  private targetEligibility(r: RobotState, task: TaskState): string | null {
    if (this.isStatic(r)) return "static sensor is ineligible for movement tasks";
    const allowed = this.allotment?.[r.id];
    if (allowed && !allowed.includes(task.type)) return `not allotted ${task.type}`;
    if (this.commsBlackouts.has(r.id)) return "comms blackout — returning to base";
    const flight = r.flight;
    if (this.isAerial(r)) {
      const cls = this.robotClass(r);
      if (this.highWind && this.highWind.windMps > (cls?.flight?.max_wind_mps ?? this.P.WIND_LIMIT_MPS_DEFAULT)) return `grounded: wind ${this.highWind.windMps} m/s exceeds limit`;
      if (flight?.signal_lost || flight?.mode === "RETURNING_HOME") return "drone unavailable: returning home";
      const dst = this.loc[task.destination];
      const distance = dst ? Math.hypot(r.position[0] - dst.access_point[0], r.position[2] - dst.access_point[1]) * 2 : Infinity;
      const maxTicks = cls?.flight?.max_flight_ticks ?? Infinity;
      const speed = Math.max(0.1, cls?.max_speed ?? this.P.MAX_SPEED);
      if (distance / speed / this.P.TICK_S > maxTicks) return "drone flight range exceeded";
      if (r.battery <= (cls?.flight?.rth_battery_pct ?? 20)) return "drone battery below return-to-home threshold";
    }
    const srcReason = this.exZoneReason(r, this.loc[task.source]?.zone);
    if (srcReason) return srcReason;
    const dstReason = this.exZoneReason(r, this.loc[task.destination]?.zone);
    if (dstReason) return dstReason;
    const dst = this.loc[task.destination];
    if (dst && !this.isAerial(r) && dst.floor !== undefined && dst.floor !== r.floor) {
      if (this.allowsStairs(r)) {
        const stair = this.findStair(r.floor, dst.floor);
        if (!stair && !this.pickLift(r)) return "terrain unreachable: no stair or lift route";
      } else if (!this.pickLift(r)) return "terrain unreachable: stairs require a legged robot";
    }
    const cls = this.robotClass(r);
    // Only classes whose footprint or terrain rules differ from a plain ground robot need the per-task reachability probe
    // (two A* searches per candidate per tick). A legged class with unit clearance and full terrain tolerance does not.
    const constrained = cls?.crawler === true || (cls?.min_clearance_cells ?? 1) > 1 || (cls?.terrain_tolerance ?? 1) < 1 || cls?.ex_certified_zones !== undefined;
    if (constrained && !this.isAerial(r) && dst && (this.loc[task.source]?.floor ?? 1) === r.floor && (dst.floor ?? 1) === r.floor) {
      const source = this.loc[task.source]!;
      const start = toCell(r.position[0], r.position[2]);
      const sourceGoal = nearestWalkable(this.grids[r.floor], source.access_point[0], source.access_point[1]);
      const sourcePath = astar(this.grids[r.floor], start, sourceGoal, this.astarOptions(r, r.floor, this.blockedCells(r.id, r.floor)));
      if (sourcePath === null) return "terrain unreachable: no path to task source";
      const destGoal = nearestWalkable(this.grids[r.floor], dst.access_point[0], dst.access_point[1]);
      if (astar(this.grids[r.floor], sourceGoal, destGoal, this.astarOptions(r, r.floor)) === null) return "terrain unreachable: no path to destination";
    }
    return null;
  }

  private transferTask(r: RobotState, priority: TaskPriority = "HIGH") {
    const task = r.current_task_id ? this.state.tasks[r.current_task_id] : undefined;
    if (!task || task.status === "TRANSFERRED" || task.status === "COMPLETED") return;
    task.status = "TRANSFERRED";
    task.completed_tick = this.state.sim.tick;
    const replacement = this.createTask({ type: task.type, priority, source: task.source, destination: task.destination, load_units: task.load_units });
    replacement.parent_task_id = task.id;
    r.current_task_id = null;
    r.destination = null;
    r.load.current = 0;
  }

  private routeDecision(r: RobotState, message: string) {
    const decision: AiDecision = {
      id: `D${++this.decisionSeq}`,
      tick: this.state.sim.tick,
      kind: "REROUTE",
      task_id: r.current_task_id,
      selected_robot: r.id,
      candidates: [],
      weights: {},
      narrative: message,
    };
    this.state.recent_decisions.unshift(decision);
    if (this.state.recent_decisions.length > 50) this.state.recent_decisions.pop();
  }

  private assignTasks() {
    const S = this.state;
    const prioRank: Record<TaskPriority, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
    const waiting = Object.values(S.tasks).filter((t) => t.status === "WAITING").sort((a, b) => prioRank[a.priority] - prioRank[b.priority] || a.created_tick - b.created_tick);
    if (!waiting.length) return;
    const idle = Object.values(S.robots).filter((r) => r.fsm === "IDLE" && r.status !== "OFFLINE" && r.status !== "ERROR" && r.battery > THRESHOLDS.BATTERY_WARNING);
    const candidatesPool = Object.values(S.robots).filter((r) => r.fsm === "IDLE" && r.status !== "OFFLINE" && r.status !== "ERROR");
    const weights = { distance: this.P.W_DISTANCE, battery: this.P.W_BATTERY, workload: this.P.W_WORKLOAD, congestion: this.P.W_CONGESTION, health: this.P.W_HEALTH };
    for (const task of waiting) {
      if (!candidatesPool.length) return;
      const src = this.loc[task.source]; if (!src) { task.status = "FAILED"; continue; }
      const srcFloor = src.floor ?? 1;
      const liftPick: Record<string, string> = {};
      const cands: DecisionCandidate[] = candidatesPool.map((r) => {
        const rejected = this.targetEligibility(r, task);
        const flat = Math.hypot(r.position[0] - src.access_point[0], r.position[2] - src.access_point[1]);
        let d = flat, liftInfo: { id: string; waitS: number } | null = null;
        if (r.floor !== srcFloor && !this.isAerial(r)) {
          const best = [...this.site.spec.lifts].map((l) => ({ l, cost: this.liftCost(r, l) })).sort((a, b) => a.cost - b.cost || a.l.id.localeCompare(b.l.id))[0];
          const waitS = best && best.cost < Infinity
            ? Math.round((best.cost - Math.hypot(r.position[0] - (best.l.cell[0] - 1.5), r.position[2] - (best.l.cell[1] + 0.5)) / (this.P.MAX_SPEED * 0.8)) * 10) / 10
            : 60;
          liftInfo = { id: best && best.cost < Infinity ? best.l.id : "—", waitS };
          if (liftInfo.id !== "—") liftPick[r.id] = liftInfo.id;
          d = flat + this.P.LIFT_XFLOOR_PENALTY_M + waitS * this.P.MAX_SPEED * 0.8;
        }
        const zone = r.zone ? S.zones[r.zone] : null;
        const cong = zone ? zone.congestion : 0;
        const workload: DecisionCandidate["workload"] = r.stats.tasks_completed > 8 ? "HIGH" : r.stats.tasks_completed > 4 ? "MEDIUM" : "LOW";
        const score = weights.distance * (1 - Math.min(1, d / 120)) + weights.battery * (r.battery / 100) + weights.workload * (workload === "LOW" ? 1 : workload === "MEDIUM" ? 0.6 : 0.2) + weights.congestion * (1 - cong) + weights.health * (r.health / 100);
        const reasons: string[] = liftInfo
          ? [`${flat.toFixed(0)}m ground`, `+${this.P.LIFT_XFLOOR_PENALTY_M}m cross-floor via ${liftInfo.id}`, `est. lift wait ${liftInfo.waitS}s`, `${r.battery.toFixed(0)}% battery`]
          : [`${d.toFixed(0)}m from task`, `${r.battery.toFixed(0)}% battery`, `${workload.toLowerCase()} workload`];
        if (cong < 0.3) reasons.push("no route congestion");
        if (rejected) reasons.push(rejected);
        return { robot_id: r.id, score: Math.round(score * 1000) / 1000, distance_m: Math.round(d), battery: Math.round(r.battery), workload, congestion: Math.round(cong * 100) / 100, health: r.health, reasons, rejected_reason: rejected };
      }).sort((a, b) => b.score - a.score);
      const eligible = cands.filter((c) => !c.rejected_reason && c.battery > THRESHOLDS.BATTERY_WARNING);
      if (!eligible.length) {
        const decision: AiDecision = { id: `D${++this.decisionSeq}`, tick: S.sim.tick, kind: "TASK_ASSIGNMENT", task_id: task.id, selected_robot: null, candidates: cands.slice(0, 5), weights, narrative: "No eligible robot for terrain, zone, or vehicle constraints" };
        S.recent_decisions.unshift(decision); if (S.recent_decisions.length > 50) S.recent_decisions.pop();
        continue;
      }
      const best = eligible[0];
      for (const c of cands) if (!c.rejected_reason && c.robot_id !== best.robot_id) c.rejected_reason = c.battery < 40 ? "battery too low" : c.distance_m > best.distance_m * 1.5 ? "farther from task" : c.workload === "HIGH" ? "high workload" : "lower score";
      const robot = S.robots[best.robot_id];
      idle.splice(idle.indexOf(robot), 1);
      candidatesPool.splice(candidatesPool.indexOf(robot), 1);
      task.status = "ASSIGNED"; task.assigned_robot = robot.id; task.assigned_tick = S.sim.tick;
      robot.current_task_id = task.id;
      this.rt[robot.id].plannedLiftId = liftPick[robot.id] ?? null;
      this.setFsm(robot, "TASK_ASSIGNED");
      const decision: AiDecision = { id: `D${++this.decisionSeq}`, tick: S.sim.tick, kind: "TASK_ASSIGNMENT", task_id: task.id, selected_robot: robot.id, candidates: cands.slice(0, 5), weights, narrative: null };
      S.recent_decisions.unshift(decision); if (S.recent_decisions.length > 50) S.recent_decisions.pop();
      this.emit("TASK_ASSIGNED", "FLEET_MANAGER", "INFO", `Task #${task.id} assigned to ${robot.id} (${best.distance_m}m, ${best.battery}%)`, { task_id: task.id, robot_id: robot.id });
    }
  }

  private pruneTasks() {
    const S = this.state; const tick = S.sim.tick;
    for (const id in S.tasks) {
      const t = S.tasks[id];
      if ((t.status === "COMPLETED" || t.status === "FAILED" || t.status === "TRANSFERRED" || t.status === "CANCELLED") && t.completed_tick !== null && tick - t.completed_tick > 3000) {
        this.harness.closed.push({ id: t.id, type: t.type, status: t.status, source: t.source, destination: t.destination, parent_task_id: t.parent_task_id, created_tick: t.created_tick, completed_tick: t.completed_tick, deadline_tick: t.deadline_tick });
        delete S.tasks[id];
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Robot FSM helpers
  // ─────────────────────────────────────────────────────────
  private setFsm(r: RobotState, fsm: RobotFsmState) {
    if (r.fsm === fsm) return;
    r.fsm = fsm; r.fsm_since_tick = this.state.sim.tick;
    r.status = this.statusOf(r);
  }
  private statusOf(r: RobotState): RobotStatus {
    if (r.fsm === "OFFLINE") return "OFFLINE";
    if (r.fsm === "ERROR") return "ERROR";
    if (r.fsm === "CHARGING") return "CHARGING";
    if (r.battery < THRESHOLDS.BATTERY_CRITICAL) return "ERROR";
    if (r.battery < THRESHOLDS.BATTERY_WARNING) return "WARNING";
    if (r.fsm === "IDLE") return "IDLE";
    return "ACTIVE";
  }

  // ─────────────────────────────────────────────────────────
  // Lifts — the engine is the single authority: doors, platform
  // height, reservations, queues, boarding/alighting. The renderer
  // only interpolates.
  // ─────────────────────────────────────────────────────────
  private liftSpec(id: string): SpecLift { return this.site.spec.lifts.find((l) => l.id === id)!; }
  private elevOf(floor: number): number { return this.site.floorElev[floor] ?? 0; }
  /** Queue slots west of the shaft: slot0 = cell−4 (rotation swept-circle clearance vs any queued body) */
  private liftSlot(l: SpecLift, i: number): [number, number] { return [l.cell[0] - 4 - i + 0.5, l.cell[1] + 0.5]; }
  private liftCabin(l: SpecLift): [number, number] { return [l.cell[0] + 0.5, l.cell[1] + 0.5]; }
  /** Exit node (separate from the queue line); sticky once chosen, re-picked only after being blocked */
  private pickLiftExit(l: SpecLift, floor: number, toward: [number, number] | null = null, skip = 0): [number, number] {
    const grid = this.grids[floor];
    const cabin = this.liftCabin(l);
    const cand: Array<[number, number]> = [[-2, -2], [-2, 2], [-3, -1], [-3, 1], [-3, -2], [-3, 2], [-2, 0]];
    const segClear = (ax: number, az: number, bx: number, bz: number) => {
      for (const o of Object.values(this.state.robots)) {
        if (o.floor !== floor || o.lift_id) continue;
        if (o.velocity > 0.1) continue;
        const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
        const t = Math.max(0, Math.min(1, ((o.position[0] - ax) * dx + (o.position[2] - az) * dz) / (len2 || 1)));
        const d = Math.hypot(o.position[0] - (ax + dx * t), o.position[2] - (az + dz * t));
        if (d < this.P.LIFT_SEP) return false;
      }
      return true;
    };
    const g = this.liftGatePoint(l);
    const clear = (to: [number, number]) => segClear(cabin[0], cabin[1], g[0], g[1]) && segClear(g[0], g[1], to[0], to[1]);
    const STAND_CLEAR = Math.hypot(this.P.ROBOT_HALF_LEN, this.P.ROBOT_HALF_W) + this.P.ROBOT_HALF_LEN;
    const standClear = (p: [number, number]) => {
      for (const o of Object.values(this.state.robots)) {
        if (o.floor !== floor || o.lift_id || o.velocity > 0.1) continue;
        if (Math.hypot(p[0] - o.position[0], p[1] - o.position[2]) < STAND_CLEAR) return false;
      }
      return true;
    };
    const ok: Array<{ p: [number, number]; key: number }> = [];
    for (const [dc, dr] of cand) {
      const c = l.cell[0] + dc, r = l.cell[1] + dr;
      if (!isWalkable(grid, c, r)) continue;
      const p: [number, number] = [c + 0.5, r + 0.5];
      if (!clear(p) || !standClear(p)) continue;
      const hug = dc === -2 && dr !== 0 ? 0.75 : 0;
      ok.push({ p, key: (toward ? Math.hypot(p[0] - toward[0], p[1] - toward[1]) : 0) + hug });
    }
    ok.sort((a, b) => a.key - b.key);
    if (ok.length) return ok[skip % ok.length].p;
    return [l.cell[0] - 2 + 0.5, l.cell[1] - 2 + 0.5];
  }

  /** Gate pass-through point = safe rotation point (diagonal swept radius clears the door frame) */
  private liftGatePoint(l: SpecLift): [number, number] {
    const cx = l.cell[0] + 0.5, cz = l.cell[1] + 0.5;
    return [cx - (this.P.LIFT_SHAFT_HALF_X + Math.hypot(this.P.ROBOT_HALF_LEN, this.P.ROBOT_HALF_W) + 0.10), cz];
  }

  /** OBB overlap of two rotated robot bodies — separating axis theorem */
  static obbOverlap(ax: number, az: number, ah: number, bx: number, bz: number, bh: number, margin = 0): boolean {
    const hl = SIM.ROBOT_HALF_LEN, hw = SIM.ROBOT_HALF_W;
    const dx = bx - ax, dz = bz - az;
    for (const t of [ah, ah + Math.PI / 2, bh, bh + Math.PI / 2]) {
      const ux = Math.cos(t), uz = Math.sin(t);
      const ra = hl * Math.abs(ux * Math.cos(ah) + uz * Math.sin(ah)) + hw * Math.abs(-ux * Math.sin(ah) + uz * Math.cos(ah));
      const rb = hl * Math.abs(ux * Math.cos(bh) + uz * Math.sin(bh)) + hw * Math.abs(-ux * Math.sin(bh) + uz * Math.cos(bh));
      if (Math.abs(dx * ux + dz * uz) > ra + rb + margin) return false;
    }
    return true;
  }

  /** Straight-line micro move (boarding / queue advance; bypasses the grid). Returns arrived. */
  private microMove(r: RobotState, to: [number, number], speed: number, floorOverride: number | null = null): boolean {
    const fl = floorOverride ?? r.floor;
    const dx = to[0] - r.position[0], dz = to[1] - r.position[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) { r.velocity = 0; return true; }
    const step = Math.min(dist, speed * this.P.TICK_S);
    const nx = r.position[0] + (dx / dist) * step, nz = r.position[2] + (dz / dist) * step;
    const moveH = Math.atan2(dz, dx);
    for (const id in this.state.robots) {
      if (id === r.id) continue; const o = this.state.robots[id];
      if (o.floor !== fl || o.lift_id) continue;
      const dn = Math.hypot(nx - o.position[0], nz - o.position[2]);
      const dcur = Math.hypot(r.position[0] - o.position[0], r.position[2] - o.position[2]);
      if (dn < this.P.LIFT_SEP && dn < dcur) { r.velocity = 0; return false; }
      if (dn < dcur && dn < 1.5 && SimEngine.obbOverlap(nx, nz, moveH, o.position[0], o.position[2], o.heading, 0.05)) { r.velocity = 0; return false; }
    }
    r.position[0] = nx; r.position[2] = nz;
    r.heading = Math.atan2(dz, dx); r.velocity = speed;
    return false;
  }

  private setLiftStage(r: RobotState, rt: RobotRt, stage: RobotRt["liftStage"]) { rt.liftStage = stage; r.lift_stage = stage; }

  releaseRobotFromLift(robotId: string) {
    const S = this.state;
    for (const lid in S.lifts) {
      const L = S.lifts[lid];
      for (const f of Object.keys(L.queue)) { const i = L.queue[f].indexOf(robotId); if (i >= 0) L.queue[f].splice(i, 1); }
      if (L.reserved_by === robotId) { L.reserved_by = null; this.emit("LIFT_RESERVATION_RELEASED", "LIFT", "LOW", `${lid} reservation released (${robotId})`, { robot_id: robotId }); }
      if (L.occupant === robotId) { L.occupant = null; if (L.state === "BOARDING" || L.state === "ALIGHTING") { L.state = "DOOR_CLOSING_AFTER_EXIT"; L.until_tick = this.state.sim.tick + this.P.LIFT_DOOR_TICKS; } }
    }
    const r = S.robots[robotId]; const rt = this.rt[robotId];
    if (r && rt) { r.lift_id = null; this.setLiftStage(r, rt, null); rt.liftExit = null; rt.liftBlockedTicks = 0; rt.liftExitPhase = null; }
  }

  private setDoor(L: TwinState["lifts"][string], floor: number, open: boolean) { L.doors[String(floor)] = open ? "OPEN" : "CLOSED"; }
  private closeDoors(L: TwinState["lifts"][string]) { for (const k of Object.keys(L.doors)) L.doors[k] = "CLOSED"; }

  private stepLifts() {
    const S = this.state; const tick = S.sim.tick;
    for (const lid of Object.keys(S.lifts).sort()) {
      const L = S.lifts[lid];
      const lay = this.liftSpec(lid);
      if (L.fault) continue; // FAULT freezes everything (platform height included)
      if (L.state !== "IDLE" && L.state !== "COOLDOWN") L.busy_ticks++;
      if (L.state === "MOVING_UP" || L.state === "MOVING_DOWN") {
        const t = Math.min(1, Math.max(0, 1 - (L.until_tick - tick) / this.P.LIFT_TRAVEL_TICKS));
        const e = t * t * (3 - 2 * t);
        const y0 = this.liftMoveFromY[lid] ?? 0, y1 = this.elevOf(L.target_floor ?? lay.floors[0]);
        L.y = y0 + (y1 - y0) * e;
      } else if (L.floor !== null) L.y = this.elevOf(L.floor);
      if (tick < L.until_tick) continue;
      switch (L.state) {
        case "IDLE": {
          if (!L.reserved_by) {
            const heads: Array<[string, number]> = [];
            for (const f of Object.keys(L.queue)) if (L.queue[f].length) { const rid = L.queue[f][0]; heads.push([rid, this.rt[rid]?.liftEnqueuedTick ?? 0]); }
            heads.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
            if (heads.length) { L.reserved_by = heads[0][0]; this.emit("LIFT_RESERVED", "LIFT", "INFO", `${lid} reserved by ${L.reserved_by}`, { robot_id: L.reserved_by }); }
          }
          if (L.reserved_by) {
            const rr = S.robots[L.reserved_by];
            if (!rr || rr.status === "OFFLINE") { this.releaseRobotFromLift(L.reserved_by!); break; }
            if (L.floor === rr.floor) { L.state = "DOOR_OPENING"; L.until_tick = tick + this.P.LIFT_DOOR_TICKS; }
            else { L.target_floor = rr.floor; L.state = rr.floor > (L.floor ?? rr.floor) ? "MOVING_UP" : "MOVING_DOWN"; this.liftMoveFromY[lid] = L.y; L.floor = null; L.until_tick = tick + this.P.LIFT_TRAVEL_TICKS; }
          }
          break;
        }
        case "MOVING_UP": case "MOVING_DOWN": { L.state = "LEVELING"; L.until_tick = tick + this.P.LIFT_LEVEL_TICKS; this.emit("LIFT_LEVELING", "LIFT", "LOW", `${lid} leveling at Floor ${L.target_floor}`, {}); break; }
        case "LEVELING": {
          L.floor = L.target_floor!; L.target_floor = null; L.y = this.elevOf(L.floor);
          L.state = L.occupant ? "DOOR_OPENING_AT_DESTINATION" : "DOOR_OPENING";
          L.until_tick = tick + this.P.LIFT_DOOR_TICKS;
          this.emit("LIFT_ARRIVED", "LIFT", "INFO", `${lid} arrived at Floor ${L.floor}`, {});
          break;
        }
        case "DOOR_OPENING": {
          this.setDoor(L, L.floor!, true);
          L.state = "BOARDING"; // reserved robot walks in (robot-side drives the transition)
          this.emit("LIFT_GATE_OPENED", "LIFT", "LOW", `${lid} Floor ${L.floor} gate opened`, {});
          break;
        }
        case "BOARDING": {
          const rr = L.reserved_by ? S.robots[L.reserved_by] : null;
          if (!rr || rr.status === "OFFLINE") {
            if (L.reserved_by) this.releaseRobotFromLift(L.reserved_by);
            this.closeDoors(L); L.state = "COOLDOWN"; L.until_tick = tick + this.P.LIFT_COOLDOWN_TICKS;
            this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {});
          }
          break;
        }
        case "DOOR_CLOSING": {
          this.closeDoors(L);
          if (L.occupant) {
            const rr = S.robots[L.occupant];
            const other = lay.floors.find((f) => f !== rr.floor) ?? lay.floors[0];
            const dest = this.rt[L.occupant]?.pending?.floor ?? other;
            L.target_floor = dest; L.state = dest > rr.floor ? "MOVING_UP" : "MOVING_DOWN"; this.liftMoveFromY[lid] = L.y; L.floor = null; L.until_tick = tick + this.P.LIFT_TRAVEL_TICKS;
            L.trips++;
            this.emit("LIFT_DEPARTED", "LIFT", "INFO", `${lid} departed → Floor ${dest} (${L.occupant})`, { robot_id: L.occupant });
          } else { L.state = "COOLDOWN"; L.until_tick = tick + this.P.LIFT_COOLDOWN_TICKS; this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {}); }
          break;
        }
        case "DOOR_OPENING_AT_DESTINATION": {
          this.setDoor(L, L.floor!, true);
          L.state = "ALIGHTING";
          this.emit("LIFT_GATE_OPENED", "LIFT", "LOW", `${lid} Floor ${L.floor} gate opened`, {});
          break;
        }
        case "ALIGHTING": break; // robot side clears occupant → DOOR_CLOSING_AFTER_EXIT
        case "DOOR_CLOSING_AFTER_EXIT": { this.closeDoors(L); L.state = "COOLDOWN"; L.until_tick = tick + this.P.LIFT_COOLDOWN_TICKS; this.emit("LIFT_COOLDOWN_STARTED", "LIFT", "LOW", `${lid} cooldown`, {}); break; }
        case "COOLDOWN": { L.state = "IDLE"; break; }
        default: break;
      }
    }
  }

  /** Robot side of the lift flow. Returns true when this tick was consumed by it. */
  private handleLift(r: RobotState, rt: RobotRt): boolean {
    const S = this.state; const tick = S.sim.tick;
    const stage = rt.liftStage;
    if (stage === null || stage === "TO_LIFT") {
      if (rt.target !== null) return false; // still walking A* to the queue slot
      const L = S.lifts[rt.liftId!];
      if (L.fault) return this.reRouteLift(r, rt);
      const f = String(r.floor);
      if (!L.queue[f].includes(r.id)) { L.queue[f].push(r.id); rt.liftEnqueuedTick = tick; this.emit("LIFT_QUEUE_ENTERED", "LIFT", "LOW", `${r.id} queued at ${rt.liftId} (F${r.floor}, #${L.queue[f].length})`, { robot_id: r.id }); }
      this.setLiftStage(r, rt, "QUEUED");
      return true;
    }
    const L = S.lifts[rt.liftId!];
    const lay = this.liftSpec(rt.liftId!);
    if (L.fault && stage !== "RIDING" && stage !== "ALIGHTING") return this.reRouteLift(r, rt);
    switch (stage) {
      case "QUEUED": {
        const f = String(r.floor);
        const pos = L.queue[f].indexOf(r.id);
        if (pos < 0) { this.setLiftStage(r, rt, "TO_LIFT"); return true; }
        // Queue advance via a clear lane: never cut diagonally into the boarding corridor.
        const slot = this.liftSlot(lay, Math.min(pos, 2));
        const dxs = r.position[0] - slot[0], dzs = r.position[2] - slot[1];
        const side = dzs >= 0 ? 1 : -1;
        let goal: [number, number];
        if (Math.abs(dxs) < 0.25) goal = slot;
        else if (Math.abs(dzs) < 0.25 && dxs < 0.35) goal = slot;
        else if (Math.abs(dzs) > 1.55) goal = [slot[0], slot[1] + side * 1.8];
        else goal = [r.position[0], slot[1] + side * 1.8];
        this.microMove(r, goal, this.P.LIFT_QUEUE_SPEED);
        if (pos === 0 && L.reserved_by === r.id && L.state === "BOARDING" && L.floor === r.floor) {
          this.setLiftStage(r, rt, "BOARDING");
          this.emit("ROBOT_BOARDING_STARTED", "LIFT", "INFO", `${r.id} boarding ${rt.liftId} → Floor ${rt.pending!.floor}`, { robot_id: r.id });
        }
        return true;
      }
      case "BOARDING": {
        if (this.microMove(r, this.liftCabin(lay), this.P.LIFT_BOARD_SPEED)) {
          const f = String(r.floor);
          const i = L.queue[f].indexOf(r.id); if (i >= 0) L.queue[f].splice(i, 1);
          L.occupant = r.id; L.reserved_by = null; r.lift_id = rt.liftId;
          L.wait_total_ticks += tick - rt.liftEnqueuedTick; L.wait_n++;
          L.state = "DOOR_CLOSING"; L.until_tick = tick + this.P.LIFT_DOOR_TICKS;
          this.setLiftStage(r, rt, "RIDING");
          this.emit("ROBOT_BOARDED", "LIFT", "INFO", `${r.id} boarded ${rt.liftId}`, { robot_id: r.id });
        }
        return true;
      }
      case "RIDING": {
        r.velocity = 0;
        const c = this.liftCabin(lay); r.position[0] = c[0]; r.position[2] = c[1];
        if (L.state === "ALIGHTING" && L.floor === rt.pending!.floor) {
          this.setLiftStage(r, rt, "ALIGHTING");
          this.emit("ROBOT_ALIGHTING_STARTED", "LIFT", "INFO", `${r.id} alighting ${rt.liftId} at Floor ${L.floor}`, { robot_id: r.id });
        }
        return true;
      }
      case "ALIGHTING": {
        const tf = rt.pending!.floor; // exits computed on the destination floor; r.floor flips only on full exit
        if (!rt.liftExit) { rt.liftExit = this.pickLiftExit(lay, tf, rt.pending!.point); rt.liftBlockedTicks = 0; rt.liftExitPhase = null; }
        const gate = this.liftGatePoint(lay);
        // Three-phase exit: rotate to gate → straight out → rotate to exit → go. Never rotate while translating near the frame.
        if (!rt.liftExitPhase) rt.liftExitPhase = "TURN_OUT";
        const rotateTo = (tx: number, tz: number): boolean => {
          const want = Math.atan2(tz - r.position[2], tx - r.position[0]);
          let dh = want - r.heading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
          r.velocity = 0;
          r.heading += Math.sign(dh) * Math.min(Math.abs(dh), 4.0 * this.P.TICK_S);
          return Math.abs(dh) < 0.06;
        };
        let arrived = false;
        if (rt.liftExitPhase === "TURN_OUT") { if (rotateTo(gate[0], gate[1])) rt.liftExitPhase = "OUT"; }
        else if (rt.liftExitPhase === "OUT") { if (this.microMove(r, gate, this.P.LIFT_BOARD_SPEED, tf)) rt.liftExitPhase = "TURN_EXIT"; }
        else if (rt.liftExitPhase === "TURN_EXIT") { if (rotateTo(rt.liftExit[0], rt.liftExit[1])) rt.liftExitPhase = "GO"; }
        else arrived = this.microMove(r, rt.liftExit, this.P.LIFT_BOARD_SPEED, tf);
        if (!arrived && r.velocity === 0 && (rt.liftExitPhase === "OUT" || rt.liftExitPhase === "GO")) {
          if (++rt.liftBlockedTicks % 40 === 0) {
            rt.liftExit = this.pickLiftExit(lay, tf, rt.pending!.point, rt.liftBlockedTicks / 40);
            if (rt.liftExitPhase === "GO") rt.liftExitPhase = "TURN_EXIT";
          }
        } else if (r.velocity > 0) rt.liftBlockedTicks = 0;
        if (arrived) {
          r.floor = tf; // only now does the robot enter the destination floor's grid
          L.occupant = null; r.lift_id = null;
          L.state = "DOOR_CLOSING_AFTER_EXIT"; L.until_tick = tick + this.P.LIFT_DOOR_TICKS;
          this.emit("ROBOT_EXITED", "LIFT", "INFO", `${r.id} exited ${rt.liftId} on Floor ${r.floor}`, { robot_id: r.id });
          const p = rt.pending!; rt.pending = null; this.setLiftStage(r, rt, null); rt.liftId = null; rt.liftExit = null; rt.liftBlockedTicks = 0; rt.liftExitPhase = null;
          this.planTo(r, rt, p.point, p.phase, p.locId, p.floor);
        }
        return true;
      }
      default: return false;
    }
  }

  /** Lift fault: leave its queue, pick another lift; if all faulted, retry in place */
  private reRouteLift(r: RobotState, rt: RobotRt): boolean {
    const tick = this.state.sim.tick;
    if (tick < rt.liftRetryTick) { r.velocity = 0; return true; }
    rt.liftRetryTick = tick + this.P.LIFT_RETRY_TICKS;
    const p = rt.pending!;
    this.releaseRobotFromLift(r.id);
    rt.pending = p;
    const alive = this.site.spec.lifts.filter((l) => !this.state.lifts[l.id].fault);
    if (!alive.length) { r.velocity = 0; return true; }
    this.planTo(r, rt, p.point, p.phase, p.locId, p.floor);
    this.emit("ROUTE_REPLANNED", "LIFT", "MEDIUM", `${r.id} rerouted to ${rt.liftId} (lift fault)`, { robot_id: r.id });
    return true;
  }

  private stepRobot(r: RobotState, rt: RobotRt) {
    const S = this.state; const tick = S.sim.tick;
    if (r.fsm === "OFFLINE") { r.velocity = 0; return; }
    if (tick < rt.holdUntilTick) { r.velocity = 0; r.stats.wait_ticks++; return; }
    if (this.isStatic(r)) {
      r.velocity = 0; r.status = "ACTIVE"; r.fsm = "IDLE";
      if (r.monitoring) {
        r.monitoring.active = true;
        r.monitoring.confidence = (this.fog ? Math.max(0, 1 - this.fog.level) : 1) * (this.platformMotion ? Math.max(0, 1 - this.platformMotion.severity) : 1);
        if (tick % this.P.KPI_EVERY === 0) r.monitoring.observations++;
      }
      return;
    }
    if (this.commsBlackouts.has(r.id) && !this.isAerial(r)) {
      if (!rt.returningBase) {
        rt.returningBase = true;
        rt.phase = "TO_PARK";
        this.planTo(r, rt, rt.basePoint, "TO_PARK");
      }
      if (rt.target !== null) this.moveAlongPath(r, rt);
      r.status = "ACTIVE";
      r.zone = this.zoneAt(r.position[0], r.position[2], r.floor);
      return;
    }
    this.batteryTick(r, rt);
    const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
    if (rt.pending && (rt.stairId ? this.handleStair(r, rt) : this.handleLift(r, rt))) {
      r.status = this.statusOf(r);
      if (r.fsm !== "IDLE" && r.fsm !== "CHARGING") r.stats.busy_ticks++;
      r.zone = this.zoneAt(r.position[0], r.position[2], r.floor);
      return;
    }

    switch (r.fsm) {
      case "IDLE": {
        r.velocity = 0; rt.idleTicks++;
        if (this.isAerial(r) && r.flight?.mode === "RETURNING_HOME") { this.stepDrone(r, rt); break; }
        if (r.battery < this.P.CHARGE_AT_PCT && this.freeCharger()) { this.goCharge(r, rt); break; }
        if (rt.idleTicks > this.P.IDLE_TO_PARK_TICKS && !rt.phase && r.floor === 1) { const p = this.parkSpot(r); if (p) { this.planTo(r, rt, p, "TO_PARK"); } }
        if (rt.phase === "TO_PARK") { this.moveAlongPath(r, rt); if (rt.target === null && !rt.pending) rt.phase = null; }
        break;
      }
      case "TASK_ASSIGNED": {
        rt.idleTicks = 0;
        if (!task) { this.setFsm(r, "IDLE"); break; }
        const src = this.loc[task.source];
        this.planTo(r, rt, src.access_point, "TO_SOURCE", task.source);
        task.status = "IN_PROGRESS"; task.started_tick = tick;
        this.setFsm(r, "NAVIGATING");
        break;
      }
      case "NAVIGATING": {
        if (!task) { this.setFsm(r, "IDLE"); break; }
        if (this.isAerial(r)) this.stepDrone(r, rt); else this.moveAlongPath(r, rt);
        if (rt.target === null && !rt.pending) { rt.dwell = this.P.PICK_TICKS; this.setFsm(r, "PICKING"); }
        break;
      }
      case "PICKING": {
        r.velocity = 0;
        if (--rt.dwell <= 0 && task) {
          const dest = this.loc[task.destination];
          if (!dest) {
            task.status = "FAILED"; task.completed_tick = tick;
            this.emit("TASK_FAILED", "SIMULATION", "HIGH", `Task #${task.id} failed: unknown destination ${task.destination}`, { robot_id: r.id, task_id: task.id });
            r.current_task_id = null; r.destination = null; rt.phase = null; rt.goalLoc = null; this.setFsm(r, "IDLE"); break;
          }
          r.load.current = Math.min(r.load.capacity, task.load_units);
          this.emit("TASK_STARTED", "ROBOT", "INFO", `${r.id} picked item at ${this.pretty(task.source)}`, { robot_id: r.id, task_id: task.id });
          this.planTo(r, rt, dest.access_point, "TO_DEST", task.destination);
          this.setFsm(r, "TRANSPORTING");
        }
        break;
      }
      case "TRANSPORTING": {
        if (!task) { this.setFsm(r, "IDLE"); break; }
        if (r.battery < THRESHOLDS.BATTERY_WARNING && rt.lastBatteryAlert !== "CRIT") {
          const remain = this.remainingPathLength(r);
          const need = remain * (this.P.BATTERY_MOVE + this.P.BATTERY_LOAD) / (this.P.MAX_SPEED * this.P.TICK_S) + 3;
          if (need > r.battery - THRESHOLDS.BATTERY_CRITICAL) { this.setFsm(r, "LOW_BATTERY"); break; }
        }
        if (this.isAerial(r)) this.stepDrone(r, rt); else this.moveAlongPath(r, rt);
        if (rt.target === null && !rt.pending) { rt.dwell = this.P.DROP_TICKS * this.stationSlowdown(task.destination); this.setFsm(r, "DELIVERING"); }
        break;
      }
      case "DELIVERING": {
        r.velocity = 0;
        if (--rt.dwell <= 0) { this.completeTask(r, rt); }
        break;
      }
      case "COMPLETED": {
        this.setFsm(r, "IDLE"); rt.idleTicks = 0;
        break;
      }
      case "LOW_BATTERY": {
        r.velocity = 0;
        this.setFsm(r, "TASK_TRANSFER");
        break;
      }
      case "TASK_TRANSFER": {
        if (task) {
          task.status = "TRANSFERRED"; task.completed_tick = tick;
          const nt = this.createTask({ type: task.type, priority: task.priority === "NORMAL" ? "HIGH" : task.priority, source: task.source, destination: task.destination, load_units: task.load_units });
          nt.parent_task_id = task.id;
          this.emit("TASK_TRANSFERRED", "FLEET_MANAGER", "MEDIUM", `${r.id} low battery — task #${task.id} re-queued as #${nt.id}`, { robot_id: r.id, task_id: nt.id });
          r.load.current = 0; r.current_task_id = null;
        }
        this.goCharge(r, rt);
        break;
      }
      case "GOING_TO_CHARGE": {
        this.moveAlongPath(r, rt);
        if (rt.target === null && !rt.pending) {
          this.setFsm(r, "CHARGING");
          // Dock precisely on the charger pad, nose toward the cabinet.
          const chg = rt.chargerId ? this.site.chargers.find((c) => c.id === rt.chargerId) : undefined;
          if (chg) { r.position[0] = chg.access_point[0]; r.position[2] = chg.access_point[1]; r.heading = Math.atan2(chg.position[2] - chg.access_point[1], chg.position[0] - chg.access_point[0]); r.velocity = 0; }
          this.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", `${r.id} charging started (${r.battery.toFixed(0)}%)`, { robot_id: r.id });
        }
        break;
      }
      case "CHARGING": {
        r.velocity = 0;
        r.battery = Math.min(100, r.battery + this.P.CHARGE_RATE);
        if (r.battery >= THRESHOLDS.BATTERY_CHARGE_TO) {
          if (rt.chargerId) this.chargerBusy[rt.chargerId] = null; rt.chargerId = null;
          rt.lastBatteryAlert = "NONE"; this.resolveAlert(`bat-${r.id}`);
          this.setFsm(r, "IDLE"); rt.idleTicks = 0;
          this.emit("ROBOT_STATE_CHANGED", "ROBOT", "INFO", `${r.id} charging complete`, { robot_id: r.id });
        }
        break;
      }
      case "OBSTACLE_DETECTED": {
        if (this.onException) this.onException(r, "OBSTACLE_DETECTED", { blocked_by: rt.frontId, wait_ticks: rt.waitTicks, phase: rt.phase, zone: r.zone, task: task ? { id: task.id, type: task.type, level: task.level } : null });
        this.setFsm(r, "REPLANNING"); break;
      }
      case "REPLANNING": {
        if (rt.target) {
          const p = astar(this.grids[r.floor], toCell(r.position[0], r.position[2]), rt.target, this.astarOptions(r, r.floor, this.blockedCells(r.id, r.floor)));
          if (p) { r.path = p; r.path_index = 0; rt.waitTicks = 0; this.emit("ROUTE_REPLANNED", "PLANNER", "LOW", `${r.id} rerouted (${p.length} cells)`, { robot_id: r.id, task_id: r.current_task_id ?? undefined }); }
        }
        this.setFsm(r, rt.phase === "TO_DEST" ? "TRANSPORTING" : rt.phase === "TO_CHARGER" ? "GOING_TO_CHARGE" : rt.phase === "TO_PARK" ? "IDLE" : "NAVIGATING");
        break;
      }
      case "ERROR": { r.velocity = 0; break; }
    }
    r.status = this.statusOf(r);
    if (r.fsm !== "IDLE" && r.fsm !== "CHARGING") r.stats.busy_ticks++;
    r.zone = this.zoneAt(r.position[0], r.position[2], r.floor);
  }

  private completeTask(r: RobotState, rt: RobotRt) {
    const S = this.state; const task = r.current_task_id ? S.tasks[r.current_task_id] : undefined;
    if (task) {
      task.status = "COMPLETED"; task.completed_tick = S.sim.tick;
      const dur = S.sim.tick - (task.created_tick);
      this.taskTimes.push(dur); if (this.taskTimes.length > 200) this.taskTimes.shift();
      this.completedCount++;
      if (task.deadline_tick === null || S.sim.tick <= task.deadline_tick) this.onTime++;
      else this.recordFailure("LATE_TASK", this.taskZone(task), [r.id], `task ${task.id} (${task.type}) finished ${((S.sim.tick - task.deadline_tick) / 10).toFixed(0)} s after its deadline`, task.id);
      r.stats.tasks_completed++;
      this.emit("TASK_COMPLETED", "ROBOT", "INFO", `${r.id} completed task #${task.id} at ${this.pretty(task.destination)}`, { robot_id: r.id, task_id: task.id });
    }
    r.load.current = 0; r.current_task_id = null; r.destination = null; rt.phase = null; rt.goalLoc = null;
    this.setFsm(r, "COMPLETED");
  }

  // ─────────────────────────────────────────────────────────
  // Paths & motion
  // ─────────────────────────────────────────────────────────
  /** Free service cell around an access point (one robot per cell); null when all taken */
  private freeServiceCell(r: RobotState, point: [number, number]): GridCell | null {
    const grid = this.grids[r.floor];
    const ap = nearestWalkable(grid, point[0], point[1]);
    const claimed = new Set<string>();
    for (const id in this.state.robots) { if (id === r.id) continue; const o = this.state.robots[id]; if (o.floor !== r.floor) continue; const t = this.rt[id].target; if (t) claimed.add(cellKey(t[0], t[1])); const c = toCell(o.position[0], o.position[2]); claimed.add(cellKey(c[0], c[1])); }
    const my = toCell(r.position[0], r.position[2]);
    let best: GridCell | null = null, bestD = Infinity;
    for (let dr = -this.P.SERVICE_RADIUS; dr <= this.P.SERVICE_RADIUS; dr++) for (let dc = -this.P.SERVICE_RADIUS; dc <= this.P.SERVICE_RADIUS; dc++) {
      const c: GridCell = [ap[0] + dc, ap[1] + dr];
      if (!isWalkable(grid, c[0], c[1]) || claimed.has(cellKey(c[0], c[1]))) continue;
      const d = Math.hypot(c[0] - my[0], c[1] - my[1]) + Math.hypot(dc, dr) * 0.01;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** Lift cost: approach time + queue estimate + positioning estimate; FAULT = never */
  liftCost(r: RobotState, l: SpecLift): number {
    const L = this.state.lifts[l.id];
    if (L.fault) return Infinity;
    const approach = Math.hypot(r.position[0] - (l.cell[0] - 1.5), r.position[2] - (l.cell[1] + 0.5)) / (this.P.MAX_SPEED * 0.8);
    const inAnyQueue = L.reserved_by ? Object.values(L.queue).some((q) => q.includes(L.reserved_by!)) : false;
    const reservedExtra = L.reserved_by && !inAnyQueue ? 1 : 0;
    const queueLen = Object.values(L.queue).reduce((a, q) => a + q.length, 0) + reservedExtra;
    const perService = (this.P.LIFT_DOOR_TICKS * 4 + this.P.LIFT_TRAVEL_TICKS + this.P.LIFT_LEVEL_TICKS + this.P.LIFT_COOLDOWN_TICKS + 40) * this.P.TICK_S;
    const busy = L.state === "IDLE" ? 0 : perService * 0.5;
    const wrongFloor = L.floor !== null && L.floor !== r.floor ? this.P.LIFT_TRAVEL_TICKS * this.P.TICK_S : 0;
    return approach + queueLen * perService + busy + wrongFloor;
  }

  private pickLift(r: RobotState): SpecLift | null {
    const c = [...this.site.spec.lifts].map((l) => ({ l, cost: this.liftCost(r, l) })).sort((a, b) => a.cost - b.cost || a.l.id.localeCompare(b.l.id));
    return c.length && c[0].cost < Infinity ? c[0].l : null;
  }

  private findStair(fromFloor: number, toFloor: number): StairsFixture | null {
    return (this.site.spec.fixtures.filter((f) => f.kind === "stairs") as StairsFixture[])
      .filter((s) => (s.from_floor === fromFloor && s.to_floor === toFloor) || (s.from_floor === toFloor && s.to_floor === fromFloor))
      .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
  }

  private stairPoint(stair: StairsFixture): [number, number] {
    if (stair.rect) return [(stair.rect[0] + stair.rect[2]) / 2, (stair.rect[1] + stair.rect[3]) / 2];
    return [stair.position[0], stair.position[2]];
  }

  private planTo(r: RobotState, rt: RobotRt, point: [number, number], phase: RobotRt["phase"], locId: string | null = null, targetFloor: number | null = null) {
    const tf = targetFloor ?? (locId ? this.loc[locId]?.floor ?? 1 : r.floor);
    if (this.isAerial(r)) {
      this.planDrone(r, rt, point, phase, locId, tf);
      return;
    }
    if (tf !== r.floor) {
      const stair = this.allowsStairs(r) ? this.findStair(r.floor, tf) : null;
      // The stairs-versus-lift lever: a legged robot takes the stairs when the best lift's queue is at least
      // STAIR_MIN_LIFT_QUEUE long (or no lift works) and it carries at most STAIR_MAX_LOAD. Otherwise it lifts.
      let useStairs = false;
      if (stair) {
        const best = this.pickLift(r);
        const queueLen = best ? Object.values(this.state.lifts[best.id].queue).reduce((a, q) => a + q.length, 0) + (this.state.lifts[best.id].reserved_by ? 1 : 0) : Infinity;
        useStairs = (best === null || queueLen >= this.P.STAIR_MIN_LIFT_QUEUE) && r.load.current <= this.P.STAIR_MAX_LOAD;
        if (rt.floorPref) { useStairs = rt.floorPref === "stairs"; rt.floorPref = null; }
        if (this.onException) this.onException(r, "FLOOR_CHOICE", { stairs: useStairs, lift: best?.id ?? null, lift_queue: queueLen === Infinity ? null : queueLen, loaded: r.load.current > 0, from: r.floor, to: tf });
      }
      if (stair && useStairs) {
        const stairTarget = this.stairPoint(stair);
        const start = toCell(r.position[0], r.position[2]);
        const goal = nearestWalkable(this.grids[r.floor], stairTarget[0], stairTarget[1]);
        const path = astar(this.grids[r.floor], start, goal, this.astarOptions(r, r.floor, this.blockedCells(r.id, r.floor))) ?? [];
        rt.pending = { point, phase, locId, floor: tf };
        rt.stairId = stair.id;
        rt.stairUntilTick = 0;
        r.path = path; r.path_index = 0; rt.target = goal; rt.phase = phase; rt.goalLoc = locId; rt.waitTicks = 0;
        r.destination = locId;
        if (path.length === 0 && (start[0] !== goal[0] || start[1] !== goal[1])) rt.target = null;
        this.updateEta(r);
        return;
      }
      // Cross-floor: origin → queue slot (A*) → lift state machine → replan on the destination floor.
      const preferred = rt.plannedLiftId ? this.site.spec.lifts.find((l) => l.id === rt.plannedLiftId && !this.state.lifts[l.id].fault) ?? null : null;
      rt.plannedLiftId = null;
      const lift = preferred ?? this.pickLift(r);
      rt.pending = { point, phase, locId, floor: tf };
      if (!lift) { rt.liftId = this.site.spec.lifts[0]?.id ?? null; this.setLiftStage(r, rt, "TO_LIFT"); rt.target = null; r.path = []; r.path_index = 0; rt.liftRetryTick = this.state.sim.tick + this.P.LIFT_RETRY_TICKS; return; }
      rt.liftId = lift.id;
      this.setLiftStage(r, rt, "TO_LIFT");
      this.emit("LIFT_REQUESTED", "LIFT", "LOW", `${r.id} requested ${lift.id} (F${r.floor} → F${tf})`, { robot_id: r.id });
      const L = this.state.lifts[lift.id];
      const slotIdx = Math.min(L.queue[String(r.floor)].length, 2);
      const sp = this.liftSlot(lift, slotIdx);
      const start = toCell(r.position[0], r.position[2]);
      const goal: GridCell = [Math.floor(sp[0]), Math.floor(sp[1])];
      const grid = this.grids[r.floor];
      const path = astar(grid, start, goal, this.astarOptions(r, r.floor, this.blockedCells(r.id, r.floor))) ?? [];
      r.path = path; r.path_index = 0; rt.target = goal; rt.phase = phase; rt.goalLoc = locId; rt.waitTicks = 0; rt.backingOff = false; rt.resumePoint = null;
      r.destination = locId;
      if (path.length === 0 && (start[0] !== goal[0] || start[1] !== goal[1])) rt.target = null;
      this.updateEta(r);
      return;
    }
    const start = toCell(r.position[0], r.position[2]);
    const grid = this.grids[r.floor];
    // Charging never uses service cells — dock straight at the assigned charger's entry cell.
    const goal = (locId && phase !== "TO_CHARGER" ? this.freeServiceCell(r, point) : null) ?? nearestWalkable(grid, point[0], point[1]);
    const path = astar(grid, start, goal, this.astarOptions(r, r.floor, this.blockedCells(r.id, r.floor))) ?? [];
    r.path = path; r.path_index = 0; rt.target = goal; rt.phase = phase; rt.goalLoc = locId; rt.waitTicks = 0; rt.backingOff = false; rt.resumePoint = null;
    r.destination = locId;
    if (path.length === 0 && (start[0] !== goal[0] || start[1] !== goal[1])) { rt.target = null; }
    this.updateEta(r);
  }

  private planDrone(r: RobotState, rt: RobotRt, point: [number, number], phase: RobotRt["phase"], locId: string | null, targetFloor: number) {
    const cls = this.robotClass(r);
    const flight = r.flight;
    if (!flight || flight.signal_lost || flight.mode === "RETURNING_HOME") return;
    const cruise = this.elevOf(targetFloor) + (cls?.flight?.cruise_alt_m ?? 5);
    const target: [number, number, number] = [point[0], this.elevOf(targetFloor) + 1, point[1]];
    flight.mode = "OUTBOUND";
    flight.waypoints = [
      [r.position[0], cruise, r.position[2]],
      [point[0], cruise, point[1]],
      target,
    ];
    flight.waypoint_index = 0;
    flight.altitude = r.position[1];
    r.destination = locId;
    rt.phase = phase;
    rt.goalLoc = locId;
    rt.target = null;
    r.path = [];
    r.path_index = 0;
    this.updateEta(r);
  }

  private beginDroneRth(r: RobotState, reason?: string) {
    const f = r.flight;
    if (!f || f.mode === "RETURNING_HOME") return;
    if (reason) f.return_reason = reason;
    f.mode = "RETURNING_HOME";
    f.waypoints = [
      [r.position[0], f.home[1] + 5, r.position[2]],
      [f.home[0], f.home[1] + 5, f.home[2]],
      f.home,
    ];
    f.waypoint_index = 0;
    r.path = [];
    r.path_index = 0;
    r.velocity = 0;
    this.emit("ROUTE_REPLANNED", "PLANNER", "HIGH", `${r.id} returning home${f.return_reason ? ` — ${f.return_reason}` : f.signal_lost ? " — signal lost" : " — battery reserve"}`, { robot_id: r.id });
  }

  private stepDrone(r: RobotState, rt: RobotRt): boolean {
    const f = r.flight;
    const cls = this.robotClass(r);
    if (!f || !cls?.flight) return true;
    if (f.signal_lost || r.battery <= cls.flight.rth_battery_pct || f.flight_ticks >= cls.flight.max_flight_ticks) this.beginDroneRth(r);
    if (f.waypoint_index >= f.waypoints.length) {
      f.mode = f.mode === "RETURNING_HOME" ? "GROUNDED" : "LANDED";
      f.altitude = r.position[1];
      r.velocity = 0;
      if (f.mode === "GROUNDED") {
        const task = r.current_task_id ? this.state.tasks[r.current_task_id] : undefined;
        if (task) {
          this.transferTask(r);
        }
        this.setFsm(r, "IDLE");
      }
      return true;
    }
    const wp = f.waypoints[f.waypoint_index];
    const dx = wp[0] - r.position[0], dy = wp[1] - r.position[1], dz = wp[2] - r.position[2];
    const dist = Math.hypot(dx, dy, dz);
    const step = Math.min(dist, cls.max_speed * this.P.TICK_S);
    if (dist < 0.05) { f.waypoint_index++; return true; }
    const ratio = step / dist;
    const nx = r.position[0] + dx * ratio, nz = r.position[2] + dz * ratio;
    for (const id in this.state.robots) {
      if (id === r.id) continue;
      const o = this.state.robots[id];
      if (o.locomotion === "aerial" || o.floor !== r.floor) continue;
      if (Math.hypot(nx - o.position[0], nz - o.position[2]) < this.P.MIN_SEP) return true;
    }
    r.position[0] = nx; r.position[1] += dy * ratio; r.position[2] = nz;
    r.heading = Math.atan2(dz, dx); r.velocity = cls.max_speed;
    f.altitude = r.position[1];
    f.flight_ticks++;
    const drain = this.P.BATTERY_MOVE * (r.velocity / Math.max(0.1, r.max_speed)) + (r.load.current > 0 ? this.P.BATTERY_LOAD : 0);
    r.battery = Math.max(0, r.battery - drain);
    r.stats.distance_m += step;
    r.stats.energy_wh += drain * 0.5;
    return true;
  }

  /** Robots currently on a flight (climbing), excluding `self` */
  private stairOccupancy(stairId: string, self: string): number {
    let n = 0;
    for (const id in this.rt) { const o = this.rt[id]; if (id !== self && o.stairId === stairId && o.target === null && o.stairUntilTick > 0) n++; }
    return n;
  }

  private handleStair(r: RobotState, rt: RobotRt): boolean {
    if (!rt.stairId || !rt.pending) return false;
    if (rt.target !== null) return false;
    if (rt.stairUntilTick === 0) {
      r.velocity = 0;
      // Stairwell full: wait at the foot (STAIR_QUEUE, reported once per 10 s of waiting)
      if (this.stairOccupancy(rt.stairId, r.id) >= this.P.STAIR_CAPACITY) {
        if (rt.waitTicks % 100 === 0) this.recordFailure("STAIR_QUEUE", r.zone, [r.id], `${r.id} waiting: ${rt.stairId} already carries ${this.P.STAIR_CAPACITY} robots`, r.current_task_id);
        rt.waitTicks++;
        return true;
      }
      rt.waitTicks = 0;
      rt.stairUntilTick = this.state.sim.tick + this.P.STAIR_CLIMB_TICKS + (r.load.current > 0 ? this.P.STAIR_LOAD_TICKS : 0);
      this.harness.stair_trips++;
      this.emit("ROUTE_PLANNED", "PLANNER", "INFO", `${r.id} climbing stairs ${rt.stairId} → Floor ${rt.pending.floor}`, { robot_id: r.id });
      return true;
    }
    r.velocity = 0;
    if (this.P.BATTERY_STAIR > 0) { r.battery = Math.max(0, r.battery - this.P.BATTERY_STAIR); r.stats.energy_wh += this.P.BATTERY_STAIR * 0.5; }
    if (this.state.sim.tick < rt.stairUntilTick) return true;
    const p = rt.pending;
    r.floor = p.floor;
    r.position[1] = this.elevOf(p.floor);
    rt.pending = null;
    rt.stairId = null;
    rt.stairUntilTick = 0;
    this.planTo(r, rt, p.point, p.phase, p.locId, p.floor);
    return true;
  }

  private moveAlongPath(r: RobotState, rt: RobotRt) {
    if (rt.target === null) return;
    if (r.path_index >= r.path.length) { rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; return; }
    const next = r.path[r.path_index];
    const [tx, tz] = cellCenter(next);
    const dx = tx - r.position[0], dz = tz - r.position[2];
    const dist = Math.hypot(dx, dz);
    let occ = this.occupancy.get(this.fkey(r.floor, next[0], next[1]));
    const myCell = toCell(r.position[0], r.position[2]);
    const entering = !(myCell[0] === next[0] && myCell[1] === next[1]);
    // Diagonal moves: both orthogonal neighbors must be robot-free (corner clipping)
    if (entering && !occ && next[0] !== myCell[0] && next[1] !== myCell[1]) {
      const a = this.occupancy.get(this.fkey(r.floor, next[0], myCell[1])), b = this.occupancy.get(this.fkey(r.floor, myCell[0], next[1]));
      if (a && a !== r.id) occ = a; else if (b && b !== r.id) occ = b;
    }
    // Perception layer: dynamic obstacle dead ahead also counts as blocked — stop one cell early
    let blockedBy: string | null = entering && occ && occ !== r.id ? occ : null;
    const percStop = rt.frontId !== null && rt.frontDist < this.P.PERC_STOP;
    if (!blockedBy && percStop) blockedBy = rt.frontId;
    if (blockedBy) {
      occ = blockedBy;
      // Blocked at the lift lobby entrance by the queue: treat as arrived, join the queue
      if (rt.liftStage === "TO_LIFT" && r.path.length - r.path_index <= 2) {
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; rt.waitTicks = 0; return;
      }
      if (percStop && r.perception.state !== "STOPPED") {
        r.perception.state = "STOPPED";
        if (this.state.sim.tick - rt.lastPercEvent > this.P.PERC_EVENT_TICKS && rt.frontId && this.state.robots[rt.frontId]) {
          rt.lastPercEvent = this.state.sim.tick;
          this.emit("OBSTACLE_DETECTED", "ROBOT", "LOW", `${r.id} LiDAR: ${rt.frontId} ahead ${rt.frontDist.toFixed(1)} m — holding`, { robot_id: r.id });
        }
      }
      const remaining0 = r.path.length - r.path_index;
      // Station queueing: within N cells of the goal → work in place instead of deadlocking
      if (!rt.backingOff && remaining0 <= this.P.STATION_ARRIVE_CELLS && (rt.phase === "TO_SOURCE" || rt.phase === "TO_DEST")) {
        const loc = rt.goalLoc ? this.loc[rt.goalLoc] : null;
        const alt = loc ? this.freeServiceCell(r, loc.access_point) : null;
        if (alt && (alt[0] !== rt.target![0] || alt[1] !== rt.target![1])) {
          const p = astar(this.grids[r.floor], myCell, alt, this.astarOptions(r, r.floor, this.blockedCells(r.id, r.floor)));
          if (p && p.length) { r.path = p; r.path_index = 0; rt.target = alt; rt.waitTicks = 0; return; }
        }
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; r.eta_s = 0; rt.waitTicks = 0; return;
      }
      r.velocity = Math.max(0, r.velocity - this.P.ACCEL * this.P.TICK_S * 2);
      rt.waitTicks++; r.stats.wait_ticks++;
      const other = this.state.robots[occ];
      const mutual = !!other && ((other.path_index < other.path.length && other.path[other.path_index][0] === myCell[0] && other.path[other.path_index][1] === myCell[1]) || this.rt[other.id].frontId === r.id);
      if (mutual && rt.waitTicks > 10 && this.yieldsTo(r, other)) { this.backOff(r, rt); return; }
      if (rt.waitTicks === this.P.WAIT_REPLAN_TICKS) { this.emit("OBSTACLE_DETECTED", "ROBOT", "LOW", `${r.id} blocked by ${occ} — replanning`, { robot_id: r.id }); this.setFsm(r, "OBSTACLE_DETECTED"); }
      else if (rt.waitTicks >= this.P.WAIT_BACKOFF_TICKS) { this.backOff(r, rt); }
      return;
    }
    // Note: waitTicks resets only after an actual move — otherwise pure-separation
    // stalemates never reach the back-off threshold and deadlock in narrow aisles.
    if (entering) {
      this.occupancy.set(this.fkey(r.floor, next[0], next[1]), r.id);
      if (next[0] !== myCell[0] && next[1] !== myCell[1]) { const k1 = this.fkey(r.floor, next[0], myCell[1]), k2 = this.fkey(r.floor, myCell[0], next[1]); if (!this.occupancy.has(k1)) this.occupancy.set(k1, r.id); if (!this.occupancy.has(k2)) this.occupancy.set(k2, r.id); }
    }
    const desiredHeading = Math.atan2(dz, dx);
    let dh = desiredHeading - r.heading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    const turning = Math.abs(dh) > 0.3;
    const remaining = r.path.length - r.path_index;
    const slowing = rt.frontId !== null && rt.frontDist < this.P.PERC_SLOW;
    if (slowing) r.perception.state = "SLOWING";
    const terrainTolerance = this.robotClass(r)?.terrain_tolerance;
    const walkwayFactor = terrainTolerance === undefined ? 0.6 : Math.max(0.6, Math.min(1, 1 - 0.6 * Math.max(0, 1 - terrainTolerance)));
    const lowestFloor = Math.min(...Object.keys(this.grids).map(Number));
    const motionFactor = this.platformMotion && r.locomotion === "legged" && r.floor === lowestFloor
      ? Math.max(0.1, 1 - this.platformMotion.severity)
      : 1;
    const vmax = r.max_speed * motionFactor * (turning ? this.P.TURN_SLOW : 1) * (remaining <= 1 ? 0.5 : 1) * (this.grids[r.floor].cells[next[1] * this.grid.cols + next[0]] === 2 ? walkwayFactor : 1) * (this.congestedZones.size ? this.zoneSpeedFactor(next, r.floor) : 1) * (slowing ? 0.45 : 1);
    r.velocity = Math.min(vmax, r.velocity + this.P.ACCEL * this.P.TICK_S);
    r.heading += Math.sign(dh) * Math.min(Math.abs(dh), 4.0 * this.P.TICK_S);
    const stepLen = Math.min(dist, r.velocity * this.P.TICK_S);
    if (dist > 1e-6) {
      const nx = r.position[0] + (dx / dist) * stepLen, nz = r.position[2] + (dz / dist) * stepLen;
      // Physical anti-collision: refuse any step that closes below MIN_SEP or overlaps OBBs
      for (const id in this.state.robots) {
        if (id === r.id) continue; const o = this.state.robots[id];
        if (o.floor !== r.floor) continue;
        const dn = Math.hypot(nx - o.position[0], nz - o.position[2]);
        const dcur = Math.hypot(r.position[0] - o.position[0], r.position[2] - o.position[2]);
        const hit = dn < dcur && (dn < this.P.MIN_SEP || (dn < 1.5 && SimEngine.obbOverlap(nx, nz, r.heading, o.position[0], o.position[2], o.heading, 0.05)));
        if (hit) { r.velocity = 0; rt.waitTicks++; r.stats.wait_ticks++; if (rt.waitTicks >= this.P.WAIT_BACKOFF_TICKS) this.backOff(r, rt); return; }
      }
      r.position[0] = nx; r.position[2] = nz;
      rt.waitTicks = 0;
    }
    r.stats.distance_m += stepLen;
    { const ci = myCell[1] * this.grid.cols + myCell[0]; const T = this.traffic[r.floor], TS = this.trafficShort[r.floor]; if (T && ci >= 0 && ci < T.length) { T[ci] += 1; TS[ci] += 1; } }
    if (dist - stepLen < 0.08) {
      r.path_index++;
      this.occupancy.set(this.fkey(r.floor, next[0], next[1]), r.id);
      if (r.path_index >= r.path.length) {
        rt.target = null; r.velocity = 0; r.path = []; r.path_index = 0; r.eta_s = 0;
        if (rt.backingOff && rt.resumePoint) {
          const rp = rt.resumePoint; rt.backingOff = false; rt.resumePoint = null;
          if (rt.liftStage === "TO_LIFT" && rt.liftId && !this.state.lifts[rt.liftId]?.fault) rt.plannedLiftId = rt.liftId;
          this.planTo(r, rt, rp, rt.phase, rt.goalLoc);
        }
      }
    }
    if (this.state.sim.tick % 10 === 0) this.updateEta(r);
  }

  /** Who yields: empty yields to loaded; ties break on id */
  private yieldsTo(me: RobotState, other: RobotState): boolean {
    if ((me.load.current > 0) !== (other.load.current > 0)) return me.load.current === 0;
    return me.id > other.id;
  }
  /** Back off to a nearby cell nobody wants, then resume the original goal */
  private backOff(r: RobotState, rt: RobotRt) {
    if (rt.backingOff || !rt.target) { rt.waitTicks = 0; return; }
    const my = toCell(r.position[0], r.position[2]);
    const claimed = new Set<string>();
    for (const id in this.state.robots) { const o = this.state.robots[id]; if (o.id === r.id || o.floor !== r.floor) continue; const c = toCell(o.position[0], o.position[2]); claimed.add(cellKey(c[0], c[1])); for (let i = o.path_index; i < Math.min(o.path.length, o.path_index + 4); i++) claimed.add(cellKey(o.path[i][0], o.path[i][1])); }
    let best: GridCell | null = null, bestD = Infinity;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      if (!dr && !dc) continue;
      const c: GridCell = [my[0] + dc, my[1] + dr];
      if (!isWalkable(this.grids[r.floor], c[0], c[1]) || claimed.has(cellKey(c[0], c[1]))) continue;
      const d = Math.abs(dr) + Math.abs(dc); if (d < bestD) { bestD = d; best = c; }
    }
    rt.waitTicks = 0;
    if (!best) return;
    const p = astar(this.grids[r.floor], my, best, { blocked: claimed });
    if (!p || !p.length) return;
    const [gx, gz] = cellCenter(rt.target);
    rt.resumePoint = [gx, gz]; rt.backingOff = true; rt.target = best;
    r.path = p; r.path_index = 0;
    this.emit("ROBOT_COLLISION_AVOIDED", "PLANNER", "LOW", `${r.id} yields (back-off ${p.length} cells)`, { robot_id: r.id });
    this.recordFailure("DEADLOCK_BACKOFF", r.zone, [r.id, ...(rt.frontId ? [rt.frontId] : [])], `${r.id} backed off ${p.length} cells to break a deadlock`, r.current_task_id);
  }

  private remainingPathLength(r: RobotState): number {
    let len = 0; let [px, pz] = [r.position[0], r.position[2]];
    for (let i = r.path_index; i < r.path.length; i++) { const [cx, cz] = cellCenter(r.path[i]); len += Math.hypot(cx - px, cz - pz); px = cx; pz = cz; }
    return len;
  }
  private updateEta(r: RobotState) { r.eta_s = r.path.length ? Math.round(this.remainingPathLength(r) / (r.max_speed * 0.8)) : null; }

  // ─────────────────────────────────────────────────────────
  // Virtual LiDAR perception (range/FoV from the robot class)
  // ─────────────────────────────────────────────────────────
  private lineOfSight(grid: NavGrid, x0: number, z0: number, x1: number, z1: number): boolean {
    const d = Math.hypot(x1 - x0, z1 - z0); const n = Math.max(1, Math.ceil(d / 0.5));
    for (let i = 1; i < n; i++) { const t = i / n; const c = toCell(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t); if (!isWalkable(grid, c[0], c[1])) return false; }
    return true;
  }
  private updatePerception(r: RobotState, rt: RobotRt) {
    const P = r.perception;
    const cls = this.classes[r.model];
    const RANGE = cls?.lidar.range_m ?? this.P.LIDAR_RANGE;
    const FOV = cls ? (cls.lidar.fov_deg * Math.PI) / 180 : this.P.LIDAR_FOV;
    P.confidence = this.fog ? Math.max(0, 1 - this.fog.level) : 1;
    if (r.fsm === "OFFLINE") { P.state = "OFF"; P.obstacles = []; P.nearest_m = null; P.ahead_m = 0; rt.frontId = null; rt.frontDist = Infinity; return; }
    const [x, , z] = r.position; const h = r.heading; const cosH = Math.cos(h), sinH = Math.sin(h);
    const grid = this.grids[r.floor];
    const obs: PerceivedObstacle[] = [];
    const consider = (kind: "ROBOT" | "HUMAN", id: string, ox: number, oz: number) => {
      const dx = ox - x, dz = oz - z; const dist = Math.hypot(dx, dz);
      if (dist > RANGE || dist < 1e-6) return;
      let b = Math.atan2(dz, dx) - h; while (b > Math.PI) b -= 2 * Math.PI; while (b < -Math.PI) b += 2 * Math.PI;
      if (Math.abs(b) > FOV / 2) return;
      if (!this.lineOfSight(grid, x, z, ox, oz)) return;
      obs.push({ kind, id, distance_m: Math.round(dist * 10) / 10, bearing_deg: Math.round((-b * 180) / Math.PI) });
    };
    for (const id in this.state.robots) { if (id === r.id) continue; const o = this.state.robots[id]; if (o.floor !== r.floor) continue; consider("ROBOT", id, o.position[0], o.position[2]); }
    for (const id in this.state.people) { const p = this.state.people[id]; if ((p.floor ?? 1) !== r.floor) continue; consider("HUMAN", id, p.position[0], p.position[2]); }
    let ahead = RANGE;
    for (let d = 0.5; d <= RANGE; d += 0.25) { const c = toCell(x + cosH * d, z + sinH * d); if (!isWalkable(grid, c[0], c[1])) { ahead = d; break; } }
    if (ahead < RANGE) obs.push({ kind: "FIXTURE", id: null, distance_m: Math.round(ahead * 10) / 10, bearing_deg: 0 });
    obs.sort((a, b) => a.distance_m - b.distance_m || (a.id ?? "").localeCompare(b.id ?? ""));
    let frontId: string | null = null, frontDist = Infinity;
    if (r.path_index < r.path.length) {
      const onPath = new Set<string>(); let prev = toCell(x, z);
      for (let i = r.path_index; i < Math.min(r.path.length, r.path_index + this.P.PERC_LOOKAHEAD); i++) {
        const c = r.path[i]; onPath.add(cellKey(c[0], c[1]));
        if (c[0] !== prev[0] && c[1] !== prev[1]) { onPath.add(cellKey(c[0], prev[1])); onPath.add(cellKey(prev[0], c[1])); }
        prev = c;
      }
      for (const o of obs) {
        if (o.kind === "FIXTURE" || o.id === null) continue;
        const pos = o.kind === "ROBOT" ? this.state.robots[o.id].position : this.state.people[o.id].position;
        const c = toCell(pos[0], pos[2]);
        if (onPath.has(cellKey(c[0], c[1])) && o.distance_m < frontDist) { frontDist = o.distance_m; frontId = o.id; }
      }
    }
    rt.frontId = frontId; rt.frontDist = frontDist;
    P.obstacles = obs.slice(0, 5);
    P.nearest_m = obs.length ? obs[0].distance_m : null;
    P.ahead_m = Math.round(Math.min(ahead, frontId ? frontDist : ahead) * 10) / 10;
    P.state = "CLEAR"; // moveAlongPath may set SLOWING / STOPPED
  }

  private fkey(floor: number, c: number, r: number) { return `${floor}:${cellKey(c, r)}`; }

  private rebuildOccupancy() {
    this.occupancy.clear();
    for (const id in this.state.robots) {
      const r = this.state.robots[id];
      const c = toCell(r.position[0], r.position[2]); this.occupancy.set(this.fkey(r.floor, c[0], c[1]), id);
      if (r.path_index < r.path.length) {
        const n = r.path[r.path_index]; if (!this.occupancy.has(this.fkey(r.floor, n[0], n[1]))) this.occupancy.set(this.fkey(r.floor, n[0], n[1]), id);
        if (n[0] !== c[0] && n[1] !== c[1]) { for (const k of [this.fkey(r.floor, n[0], c[1]), this.fkey(r.floor, c[0], n[1])]) if (!this.occupancy.has(k)) this.occupancy.set(k, id); }
      }
    }
  }
  private blockedCells(selfId: string, floor: number): Set<string> {
    const s = new Set<string>();
    const pre = `${floor}:`;
    for (const [k, id] of this.occupancy) if (id !== selfId && k.startsWith(pre)) s.add(k.slice(pre.length));
    for (const zid of this.blockedZones) { const z = this.site.spec.zones.find((zz) => zz.id === zid); if (!z || (z.floor ?? 1) !== floor) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) for (let r = Math.floor(Math.min(...zs)); r < Math.max(...zs); r++) s.add(cellKey(c, r)); }
    return s;
  }
  private congestionCost(floor = 1): Float32Array | undefined {
    const T = this.traffic[floor]; if (!T) return undefined;
    const out = new Float32Array(T.length);
    let max = 0; for (let i = 0; i < T.length; i++) if (T[i] > max) max = T[i];
    const zonesOnFloor = [...this.congestedZones.keys()].filter((zid) => (this.site.spec.zones.find((z) => z.id === zid)?.floor ?? 1) === floor);
    if (max < 1 && zonesOnFloor.length === 0) return undefined;
    if (max >= 1) for (let i = 0; i < out.length; i++) out[i] = (T[i] / max) * 0.8;
    for (const zid of zonesOnFloor) { const cz = this.congestedZones.get(zid)!; const z = this.site.spec.zones.find((zz) => zz.id === zid)!; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) for (let r = Math.floor(Math.min(...zs)); r < Math.max(...zs); r++) out[r * this.grid.cols + c] += 3 * cz.level; }
    return out;
  }
  private zoneSpeedFactor(cell: GridCell, floor: number): number {
    for (const [zid, cz] of this.congestedZones) { const z = this.site.spec.zones.find((zz) => zz.id === zid); if (!z || (z.floor ?? 1) !== floor) continue; const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]); if (cell[0] >= Math.min(...xs) && cell[0] < Math.max(...xs) && cell[1] >= Math.min(...zs) && cell[1] < Math.max(...zs)) return 1 - 0.7 * cz.level; }
    return 1;
  }
  private decayTraffic() {
    if (this.state.sim.tick % 5 !== 0) return;
    for (const f in this.traffic) { const T = this.traffic[f], TS = this.trafficShort[f]; for (let i = 0; i < T.length; i++) { T[i] *= 0.9985; TS[i] *= 0.975; } }
  }

  // ─────────────────────────────────────────────────────────
  // Battery & charging
  // ─────────────────────────────────────────────────────────
  private batteryTick(r: RobotState, rt: RobotRt) {
    if (r.fsm === "CHARGING") return;
    if (this.isAerial(r)) return;
    const moving = r.velocity > 0.05;
    const drain = moving ? this.P.BATTERY_MOVE * (r.velocity / r.max_speed) + (r.load.current > 0 ? this.P.BATTERY_LOAD : 0) : this.P.BATTERY_IDLE;
    r.battery = Math.max(0, r.battery - drain);
    r.stats.energy_wh += drain * 0.5;
    if (r.battery < THRESHOLDS.BATTERY_CRITICAL && rt.lastBatteryAlert !== "CRIT") {
      rt.lastBatteryAlert = "CRIT";
      if (r.load.current > 0) { this.harness.battery_strandings++; this.recordFailure("BATTERY_STRANDING", r.zone, [r.id], `${r.id} hit critical battery (${r.battery.toFixed(0)}%) while carrying a load`, r.current_task_id); }
      this.emit("ROBOT_BATTERY_CRITICAL", "ROBOT", "CRITICAL", `${r.id} Battery Critical (${r.battery.toFixed(0)}%)`, { robot_id: r.id, zone_id: r.zone ?? undefined });
      this.raiseAlert(`bat-${r.id}`, "CRITICAL", `${r.id}  Battery Critical`, `${r.battery.toFixed(0)}% remaining`, { robot_id: r.id, zone_id: r.zone ?? undefined });
    } else if (r.battery < THRESHOLDS.BATTERY_WARNING && rt.lastBatteryAlert === "NONE") {
      rt.lastBatteryAlert = "WARN";
      this.emit("ROBOT_BATTERY_LOW", "ROBOT", "HIGH", `${r.id} Battery Low (${r.battery.toFixed(0)}%)`, { robot_id: r.id, zone_id: r.zone ?? undefined });
      this.raiseAlert(`bat-${r.id}`, "HIGH", `${r.id}  Battery Low`, `${r.battery.toFixed(0)}% remaining`, { robot_id: r.id, zone_id: r.zone ?? undefined });
    }
    if (r.battery <= 0 && r.fsm !== "ERROR") { this.setFsm(r, "ERROR"); this.emit("ROBOT_OFFLINE", "ROBOT", "CRITICAL", `${r.id} battery depleted — stopped`, { robot_id: r.id }); }
  }
  /** When the belt feeding a station faults, unloading there needs manual handling: dwell ×4 */
  private stationSlowdown(locId: string): number {
    const cv = this.site.conveyors.find((c) => c.feeds === locId);
    if (!cv) return 1;
    const st = this.state.conveyors[cv.id]?.status;
    return st === "ERROR" || st === "STOPPED" ? 4 : st === "WARNING" || st === "MAINTENANCE" ? 2 : 1;
  }
  /** Every 10 ticks: sensor readings + conveyor throughput (decorative but derived from real state) */
  private updateDevices() {
    const S = this.state; const robots = Object.values(S.robots);
    for (const camera of Object.values(S.cameras)) camera.confidence = (this.fog ? Math.max(0, 1 - this.fog.level) : 1) * (this.platformMotion ? Math.max(0, 1 - this.platformMotion.severity) : 1);
    for (const id in S.sensors) {
      const s = S.sensors[id]; const ls = this.site.spec.sensors.find((x) => x.id === id); if (!ls || s.status === "OFFLINE") continue;
      const near = robots.filter((r) => Math.hypot(r.position[0] - ls.position[0], r.position[2] - ls.position[2]) < 10).length;
      if (s.kind === "PRESENCE") { s.value = near > 0 ? 1 : 0; s.unit = "bool"; }
      else if (s.kind === "LIDAR") { s.value = near; s.unit = "objects"; }
      else if (s.kind === "TEMP") { s.value = Math.round((21 + Math.sin(S.sim.tick / 3000) * 1.5) * 10) / 10; s.unit = "°C"; }
      else if (s.kind === "WEIGHT") { const cv = ls.of ? S.conveyors[ls.of] : undefined; s.value = cv ? cv.items_on_belt * 12 : 0; s.unit = "kg"; }
    }
    for (const id in S.conveyors) {
      const c = S.conveyors[id]; const lc = this.site.conveyors.find((x) => x.id === id);
      if (c.status === "RUNNING") { const deliveries = robots.filter((r) => r.fsm === "DELIVERING" && lc && r.destination === lc.feeds).length; c.items_on_belt = Math.max(0, Math.min(12, c.items_on_belt + deliveries - (S.sim.tick % 30 === 0 ? 1 : 0))); c.throughput_per_min = Math.round((2 + c.items_on_belt * 0.3) * 10) / 10; }
      else { c.throughput_per_min = 0; }
    }
  }
  private freeCharger(): string | null { for (const id in this.chargerBusy) if (!this.chargerBusy[id]) return id; return null; }
  private goCharge(r: RobotState, rt: RobotRt) {
    const id = this.freeCharger();
    if (!id) { this.setFsm(r, "IDLE"); return; }
    const c = this.site.chargers.find((cc) => cc.id === id)!;
    this.chargerBusy[id] = r.id; rt.chargerId = id;
    this.planTo(r, rt, c.access_point, "TO_CHARGER", id);
    this.setFsm(r, "GOING_TO_CHARGE");
  }
  private parkSpot(r: RobotState): [number, number] | null {
    const p = this.site.parking[0]; if (!p) return null;
    const i = parseInt(r.id.replace(/\D/g, ""), 10) - 1;
    const x = Math.floor(p.rect[0] + 1 + (i % 10) * 2) + 0.5, z = Math.floor(p.rect[1] + 1 + Math.floor(i / 10) * 2.2) + 0.5;
    if (Math.hypot(r.position[0] - x, r.position[2] - z) < 1.5) return null;
    return [x, z];
  }

  // ─────────────────────────────────────────────────────────
  // Zones / KPI / events
  // ─────────────────────────────────────────────────────────
  private zoneAt(x: number, z: number, floor = 1): string | null {
    for (const zn of this.site.spec.zones) { if ((zn.floor ?? 1) !== floor) continue; const xs = zn.polygon.map((p) => p[0]), zs = zn.polygon.map((p) => p[1]); if (x >= Math.min(...xs) && x <= Math.max(...xs) && z >= Math.min(...zs) && z <= Math.max(...zs)) return zn.id; }
    return null;
  }
  private updateZones() {
    const S = this.state;
    const counts: Record<string, number> = {};
    for (const id in S.robots) { const z = S.robots[id].zone; if (z) counts[z] = (counts[z] ?? 0) + 1; }
    for (const zid in S.zones) {
      const z = S.zones[zid]; z.robot_count = counts[zid] ?? 0;
      const zs = this.site.spec.zones.find((zz) => zz.id === zid);
      const cap = zs?.capacity ?? this.P.ZONE_CAPACITY;
      z.congestion = Math.min(1, z.robot_count / cap);
      if (this.blockedZones.has(zid)) { z.status = "BLOCKED"; continue; }
      if (this.droppedObjects.has(zid)) { z.status = "BLOCKED"; z.blocked_reason = "Dropped object"; continue; }
      if (this.gasLeaks.has(zid)) { z.status = "RESTRICTED"; z.blocked_reason = "Gas leak"; continue; }
      z.blocked_reason = null; z.blocked_since_tick = null;
      const inj = this.congestedZones.get(zid); if (inj) z.congestion = Math.max(z.congestion, inj.level);
      const was = z.status;
      z.status = z.congestion >= THRESHOLDS.CONGESTION_WARNING ? "CONGESTED" : "NORMAL";
      if (z.status === "CONGESTED" && was !== "CONGESTED") this.emit("ZONE_CONGESTION_HIGH", "SIMULATION", "MEDIUM", `Zone ${zid} congestion high (${z.robot_count} robots)`, { zone_id: zid });
    }
  }
  private updateKpi() {
    const S = this.state; const K = S.kpi; const robots = Object.values(S.robots); const tasks = Object.values(S.tasks);
    K.tick = S.sim.tick;
    K.fleet = { total: robots.length, active: 0, charging: 0, idle: 0, warning: 0, error: 0, offline: 0 };
    for (const r of robots) K.fleet[r.status.toLowerCase() as keyof typeof K.fleet]++;
    const win = 3000; // 5 min
    const recent = tasks.filter((t) => t.status === "COMPLETED" && t.completed_tick !== null && S.sim.tick - t.completed_tick < win).length;
    K.operation = {
      throughput_per_min: Math.round((recent / Math.min(5, Math.max(1, S.sim.tick / 600))) * 10) / 10,
      completed_today: this.completedCount, completed_target: this.site.spec.kpis.completed_target,
      pending: tasks.filter((t) => t.status === "WAITING").length,
      ongoing: tasks.filter((t) => t.status === "ASSIGNED" || t.status === "IN_PROGRESS").length,
      avg_task_time_s: this.taskTimes.length ? Math.round((this.taskTimes.reduce((a, b) => a + b, 0) / this.taskTimes.length) * this.P.TICK_S) : 0,
      on_time_rate: this.completedCount ? this.onTime / this.completedCount : 1,
      avg_utilization: S.sim.tick ? robots.reduce((a, r) => a + r.stats.busy_ticks, 0) / (robots.length * S.sim.tick) : 0,
    };
    const cong = Object.values(S.zones).reduce((a, z) => a + z.congestion, 0) / Math.max(1, Object.keys(S.zones).length);
    K.efficiency = {
      avg_travel_distance_m: Math.round(robots.reduce((a, r) => a + r.stats.distance_m, 0) / Math.max(1, this.completedCount)),
      avg_wait_time_s: Math.round((robots.reduce((a, r) => a + r.stats.wait_ticks, 0) / robots.length) * this.P.TICK_S),
      congestion_index: Math.round(cong * 100) / 100,
      energy_kwh: Math.round(robots.reduce((a, r) => a + r.stats.energy_wh, 0)) / 1000,
    };
    const lifts = Object.values(S.lifts);
    K.lifts = {
      trips: lifts.reduce((a, l) => a + l.trips, 0),
      utilization: S.sim.tick && lifts.length ? Math.round((lifts.reduce((a, l) => a + l.busy_ticks, 0) / (lifts.length * S.sim.tick)) * 1000) / 1000 : 0,
      avg_wait_s: (() => { const n = lifts.reduce((a, l) => a + l.wait_n, 0); return n ? Math.round((lifts.reduce((a, l) => a + l.wait_total_ticks, 0) / n) * this.P.TICK_S * 10) / 10 : 0; })(),
      faults: lifts.filter((l) => l.fault).length,
    };
    if ("CHARGING" in S.subsystems) S.subsystems.CHARGING = Object.keys(this.chargerBusy).length && Object.values(this.chargerBusy).every(Boolean) ? "WARNING" : "NORMAL";
    if ("CONVEYORS" in S.subsystems) S.subsystems.CONVEYORS = Object.values(S.conveyors).some((c) => c.status === "ERROR") ? "ERROR" : Object.values(S.conveyors).some((c) => c.status !== "RUNNING") ? "WARNING" : "NORMAL";
    if ("SITE" in S.subsystems) S.subsystems.SITE = this.blockedZones.size ? "WARNING" : "NORMAL";
  }
  private pushSeries() {
    const S = this.state; this.lastSeriesTick = S.sim.tick;
    const minutes = S.sim.tick / 600;
    S.kpi.throughput_series.push({ tick: S.sim.tick, completed: this.completedCount, target: Math.round(minutes * this.site.spec.kpis.target_per_min) });
    if (S.kpi.throughput_series.length > THRESHOLDS.THROUGHPUT_SERIES_SIZE) S.kpi.throughput_series.shift();
  }

  private emit(type: EventType, source: TwinEvent["source"], severity: Severity, message: string, rel: Partial<Pick<TwinEvent, "robot_id" | "task_id" | "zone_id" | "conveyor_id" | "camera_id">> = {}) {
    const ev: TwinEvent = { id: `E${++this.eventSeq}`, tick: this.state.sim.tick, type, source, severity, message, ...rel };
    this.state.recent_events.unshift(ev);
    if (this.state.recent_events.length > this.P.EVENT_RING) this.state.recent_events.pop();
    return ev;
  }
  private raiseAlert(id: string, severity: Severity, title: string, detail: string, rel: Partial<Pick<AlertState, "robot_id" | "zone_id" | "conveyor_id">> = {}) {
    const ev = this.state.recent_events[0];
    this.state.alerts[id] = { id, created_tick: this.state.sim.tick, severity, title, detail, source_event_id: ev?.id ?? "", acknowledged: false, resolved_tick: null, ...rel };
  }
  private resolveAlert(id: string) { delete this.state.alerts[id]; }
  ackAlert(id: string) { const a = this.state.alerts[id]; if (a) a.acknowledged = true; }

  private zoneBounds(zoneId: string): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    const z = this.site.spec.zones.find((zone) => zone.id === zoneId);
    if (!z) return null;
    const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  }

  private cellInZone(zoneId: string, cell: GridCell): boolean {
    const bounds = this.zoneBounds(zoneId);
    return !!bounds && cell[0] >= Math.floor(bounds.minX) && cell[0] < Math.ceil(bounds.maxX) &&
      cell[1] >= Math.floor(bounds.minZ) && cell[1] < Math.ceil(bounds.maxZ);
  }

  private replanZoneRoutes(zoneId: string, reason: string) {
    for (const r of Object.values(this.state.robots)) {
      if (this.isStatic(r) || !r.path.length) continue;
      if (!r.path.slice(r.path_index).some((cell) => this.cellInZone(zoneId, cell))) continue;
      this.setFsm(r, "OBSTACLE_DETECTED");
      this.routeDecision(r, `${r.id} rerouting around ${reason} in Zone ${zoneId}`);
      this.emit("ROUTE_REPLANNED", "PLANNER", "MEDIUM", `${r.id} rerouting around ${reason} in Zone ${zoneId}`, { robot_id: r.id, zone_id: zoneId });
    }
  }

  private evacuateGasZone(zoneId: string) {
    const bounds = this.zoneBounds(zoneId);
    if (!bounds) return;
    for (const r of Object.values(this.state.robots)) {
      if (this.isStatic(r) || this.isAerial(r) || r.floor !== (this.site.spec.zones.find((z) => z.id === zoneId)?.floor ?? 1)) continue;
      if (this.exZoneReason(r, zoneId) === null) continue;
      const grid = this.grids[r.floor];
      const start = toCell(r.position[0], r.position[2]);
      if (!this.cellInZone(zoneId, start)) continue;
      const candidates: GridCell[] = [];
      for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
        if (this.cellInZone(zoneId, [col, row]) || !isWalkable(grid, col, row)) continue;
        candidates.push([col, row]);
      }
      candidates.sort((a, b) => Math.hypot(a[0] - start[0], a[1] - start[1]) - Math.hypot(b[0] - start[0], b[1] - start[1]));
      const goal = candidates.find((cell) => astar(grid, start, cell, this.astarOptions(r, r.floor)) !== null);
      if (!goal) continue;
      this.transferTask(r);
      const rt = this.rt[r.id];
      rt.pending = null; rt.target = null; rt.phase = null; r.path = []; r.path_index = 0;
      this.releaseRobotFromLift(r.id);
      this.planTo(r, rt, [goal[0] + 0.5, goal[1] + 0.5], "TO_PARK");
      this.setFsm(r, "IDLE");
      this.routeDecision(r, `${r.id} evacuating gas-leak Zone ${zoneId}`);
      this.emit("ROUTE_REPLANNED", "PLANNER", "CRITICAL", `${r.id} evacuated from gas-leak Zone ${zoneId}`, { robot_id: r.id, zone_id: zoneId });
    }
  }

  private createGasInspection(zoneId: string) {
    const rule = this.site.spec.tasks.types.find((t) => t.id === "INSPECT");
    if (!rule) return;
    const source = Object.values(this.loc).find((l) => l.zone === zoneId && rule.allowed_source_kinds.includes(l.kind));
    const destination = Object.values(this.loc).find((l) => l.id !== source?.id && rule.allowed_dest_kinds.includes(l.kind));
    if (!source || !destination) return;
    const task = this.createTask({ type: "INSPECT", priority: "CRITICAL", source: source.id, destination: destination.id });
    this.emit("TASK_CREATED", "SIMULATION", "CRITICAL", `Gas-leak inspection task created for Zone ${zoneId}`, { task_id: task.id, zone_id: zoneId });
  }

  private restoreConfidence() {
    for (const r of Object.values(this.state.robots)) {
      if (r.monitoring) r.monitoring.confidence = (this.fog ? Math.max(0, 1 - this.fog.level) : 1) * (this.platformMotion ? Math.max(0, 1 - this.platformMotion.severity) : 1);
      r.perception.confidence = this.fog ? Math.max(0, 1 - this.fog.level) : 1;
    }
    for (const camera of Object.values(this.state.cameras)) camera.confidence = (this.fog ? Math.max(0, 1 - this.fog.level) : 1) * (this.platformMotion ? Math.max(0, 1 - this.platformMotion.severity) : 1);
  }

  // ─────────────────────────────────────────────────────────
  // Scenario injection
  // ─────────────────────────────────────────────────────────
  private applyInjections() {
    const S = this.state;
    const now = S.sim.tick;
    const keep: ScenarioInjection[] = [];
    for (const inj of this.pendingInjections) {
      if (inj.at_tick !== undefined && inj.at_tick > now) { keep.push(inj); continue; }
      switch (inj.kind) {
        case "LIFT_FAULT": {
          const L = S.lifts[inj.lift_id]; if (!L || L.fault) break;
          L.fault = true;
          L.fault_remaining = Math.max(0, L.until_tick - now); // freeze the timer: resume from remaining progress, no teleporting
          this.emit("LIFT_FAULT", "LIFT", L.occupant ? "CRITICAL" : "HIGH", `${inj.lift_id} FAULT${L.occupant ? ` — ${L.occupant} inside, platform stalled` : ""}`, { robot_id: L.occupant ?? undefined });
          this.raiseAlert(`lift-${inj.lift_id}`, L.occupant ? "CRITICAL" : "HIGH", `${inj.lift_id}  Fault`, L.occupant ? `Platform stalled with ${L.occupant} aboard` : "Out of service", {});
          break;
        }
        case "ROBOT_FAILURE": { const r = S.robots[inj.robot_id]; if (r) { this.setFsm(r, "OFFLINE"); r.velocity = 0; const t = r.current_task_id ? S.tasks[r.current_task_id] : null; if (t) { t.status = "TRANSFERRED"; t.completed_tick = now; const nt = this.createTask({ type: t.type, priority: "HIGH", source: t.source, destination: t.destination }); nt.parent_task_id = t.id; } r.current_task_id = null; r.path = []; this.releaseRobotFromLift(r.id); this.rt[r.id].pending = null; this.emit("ROBOT_OFFLINE", "USER", "CRITICAL", `${r.id} failure injected — OFFLINE`, { robot_id: r.id }); this.raiseAlert(`off-${r.id}`, "CRITICAL", `${r.id}  Offline`, "Robot failure", { robot_id: r.id }); } break; }
        case "ROBOT_BATTERY_SET": { const r = S.robots[inj.robot_id]; if (r) { r.battery = inj.battery; this.rt[r.id].lastBatteryAlert = "NONE"; } break; }
        case "DRONE_SIGNAL_LOST": {
          const r = S.robots[inj.robot_id];
          if (!r?.flight || !this.isAerial(r)) break;
          r.flight.signal_lost = true;
          this.beginDroneRth(r);
          this.emit("ROBOT_STATE_CHANGED", "USER", "HIGH", `${r.id} signal lost — returning home`, { robot_id: r.id });
          this.raiseAlert(`sig-${r.id}`, "HIGH", `${r.id}  Signal Lost`, "Drone returning to home position", { robot_id: r.id });
          break;
        }
        case "HIGH_WIND": {
          const windMps = Math.max(0, inj.wind_mps);
          this.highWind = { windMps, until: now + Math.max(0, inj.duration_ticks) };
          this.emit("ROBOT_STATE_CHANGED", "SIMULATION", "HIGH", `High wind injected — ${windMps} m/s`, {});
          this.raiseAlert("wind", "HIGH", "High Wind", `${windMps} m/s — aerial operations restricted`);
          for (const r of Object.values(S.robots)) {
            const cls = this.robotClass(r);
            if (!this.isAerial(r) || windMps <= (cls?.flight?.max_wind_mps ?? this.P.WIND_LIMIT_MPS_DEFAULT)) continue;
            this.transferTask(r);
            if (r.flight) this.beginDroneRth(r, "high wind");
            this.emit("ROBOT_STATE_CHANGED", "SIMULATION", "HIGH", `${r.id} grounded — wind ${windMps} m/s exceeds limit`, { robot_id: r.id });
          }
          break;
        }
        case "PLATFORM_MOTION": {
          const severity = Math.max(0, Math.min(1, inj.severity));
          this.platformMotion = { severity, until: now + Math.max(0, inj.duration_ticks) };
          this.emit("ROBOT_STATE_CHANGED", "SIMULATION", "MEDIUM", `Platform motion injected — severity ${Math.round(severity * 100)}%`, {});
          this.raiseAlert("motion", "MEDIUM", "Platform Motion", `Robot speed and monitoring confidence reduced by ${Math.round(severity * 100)}%`);
          break;
        }
        case "FOG": {
          const level = Math.max(0, Math.min(1, inj.level));
          this.fog = { level, until: now + Math.max(0, inj.duration_ticks) };
          this.emit("CAMERA_STATUS_CHANGED", "SIMULATION", level >= 0.7 ? "MEDIUM" : "LOW", `Fog injected — visibility ${Math.round((1 - level) * 100)}%`, {});
          this.raiseAlert("fog", level >= 0.7 ? "MEDIUM" : "LOW", "Fog", `Camera and sensor confidence reduced to ${Math.round((1 - level) * 100)}%`);
          break;
        }
        case "GAS_LEAK": {
          if (!S.zones[inj.zone_id]) break;
          this.gasLeaks.set(inj.zone_id, now + Math.max(0, inj.duration_ticks));
          this.emit("ZONE_BLOCKED", "SIMULATION", "CRITICAL", `Gas leak detected — Zone ${inj.zone_id} treated as Ex Zone 0`, { zone_id: inj.zone_id });
          this.raiseAlert(`gas-${inj.zone_id}`, "CRITICAL", `Zone ${inj.zone_id}  Gas Leak`, "Only robots certified for Ex Zone 0 may enter", { zone_id: inj.zone_id });
          this.createGasInspection(inj.zone_id);
          this.evacuateGasZone(inj.zone_id);
          this.replanZoneRoutes(inj.zone_id, "gas leak");
          break;
        }
        case "DROPPED_OBJECT": {
          if (!S.zones[inj.zone_id]) break;
          this.droppedObjects.set(inj.zone_id, now + Math.max(0, inj.duration_ticks));
          this.emit("ZONE_BLOCKED", "SIMULATION", "HIGH", `Dropped object — Zone ${inj.zone_id} blocked`, { zone_id: inj.zone_id });
          this.raiseAlert(`drop-${inj.zone_id}`, "HIGH", `Zone ${inj.zone_id}  Dropped Object`, "All robot routes avoid the zone", { zone_id: inj.zone_id });
          this.replanZoneRoutes(inj.zone_id, "dropped object");
          break;
        }
        case "COMMS_BLACKOUT": {
          const r = S.robots[inj.robot_id];
          if (!r || this.isStatic(r)) break;
          this.commsBlackouts.set(r.id, now + Math.max(0, inj.duration_ticks));
          this.transferTask(r);
          this.releaseRobotFromLift(r.id);
          r.path = []; r.path_index = 0; r.destination = null;
          this.rt[r.id].pending = null; this.rt[r.id].target = null; this.rt[r.id].phase = null;
          if (this.isAerial(r)) {
            if (r.flight) { r.flight.signal_lost = true; this.beginDroneRth(r, "comms blackout"); }
          } else {
            this.rt[r.id].returningBase = false;
            this.setFsm(r, "IDLE");
          }
          this.emit("ROBOT_STATE_CHANGED", "USER", "HIGH", `${r.id} comms blackout — returning to base`, { robot_id: r.id });
          this.raiseAlert(`comms-${r.id}`, "HIGH", `${r.id}  Comms Blackout`, "Robot returning to base", { robot_id: r.id });
          break;
        }
        case "CONVEYOR_FAILURE": { const c = S.conveyors[inj.conveyor_id]; if (c) { c.status = "ERROR"; c.speed_mps = 0; this.emit("CONVEYOR_STATUS_CHANGED", "CONVEYOR", "HIGH", `${inj.conveyor_id} failure — STOPPED`, { conveyor_id: c.id }); this.raiseAlert(`cv-${c.id}`, "HIGH", `Conveyor ${c.id}  Error`, "Throughput impact: HIGH", { conveyor_id: c.id }); } break; }
        case "CAMERA_OFFLINE": { const c = S.cameras[inj.camera_id]; if (c) { c.status = "OFFLINE"; if ("CCTV" in S.subsystems) S.subsystems.CCTV = "WARNING"; this.emit("CAMERA_STATUS_CHANGED", "CAMERA", "MEDIUM", `${c.id} offline`, { camera_id: c.id }); } break; }
        case "HUMAN_INTRUSION": {
          const z = this.site.spec.zones.find((zz) => zz.id === inj.zone_id); if (!z) break;
          const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
          const pid = `H-${inj.zone_id}-${now}`;
          S.people[pid] = { id: pid, kind: "WORKER", position: [(Math.min(...xs) + Math.max(...xs)) / 2, 0, Math.min(...zs) + 6.3], heading: 0, zone: inj.zone_id, floor: z.floor ?? 1, expires_tick: now + inj.duration_ticks };
          this.blockedZones.add(inj.zone_id); S.zones[inj.zone_id].blocked_reason = "Human detected"; S.zones[inj.zone_id].blocked_since_tick = now;
          this.emit("HUMAN_DETECTED", "VLM", "HIGH", `Human detected — Zone ${inj.zone_id}`, { zone_id: inj.zone_id });
          this.emit("ZONE_BLOCKED", "SIMULATION", "HIGH", `Zone ${inj.zone_id} marked BLOCKED`, { zone_id: inj.zone_id });
          this.raiseAlert(`zone-${inj.zone_id}`, "HIGH", `Zone ${inj.zone_id}  Human Detected`, "Route blocked", { zone_id: inj.zone_id });
          for (const id in S.robots) { const r = S.robots[id]; if (r.path.length && r.path.slice(r.path_index).some(([c, rr]) => c >= Math.min(...xs) && c < Math.max(...xs) && rr >= Math.min(...zs) && rr < Math.max(...zs))) { this.setFsm(r, "OBSTACLE_DETECTED"); this.recordFailure("HUMAN_REPLAN", inj.zone_id, [r.id], `${r.id} rerouting around a person in zone ${inj.zone_id}`, r.current_task_id); } }
          break;
        }
        case "TRAFFIC_CONGESTION": {
          this.congestedZones.set(inj.zone_id, { level: inj.level, until: now + inj.duration_ticks });
          this.emit("ZONE_CONGESTION_HIGH", "USER", "MEDIUM", `Traffic congestion injected — Zone ${inj.zone_id} (level ${Math.round(inj.level * 100)}%)`, { zone_id: inj.zone_id });
          this.raiseAlert(`traffic-${inj.zone_id}`, "MEDIUM", `Zone ${inj.zone_id}  Traffic Delay`, `Speed limited to ${Math.round((1 - 0.7 * inj.level) * 100)}%`, { zone_id: inj.zone_id });
          for (const id in S.robots) { const r = S.robots[id]; if (r.path.length > r.path_index + 3 && r.fsm !== "IDLE") this.setFsm(r, "OBSTACLE_DETECTED"); }
          break;
        }
        case "TASK_BURST": { for (let i = 0; i < inj.count; i++) { this.nextTaskTick = now; this.generateTasks(); } break; }
      }
    }
    this.pendingInjections = keep;
    if (this.highWind && now >= this.highWind.until) {
      this.highWind = null;
      this.resolveAlert("wind");
      this.emit("ROBOT_STATE_CHANGED", "SIMULATION", "INFO", "High wind cleared — aerial operations may resume", {});
    }
    if (this.platformMotion && now >= this.platformMotion.until) {
      this.platformMotion = null;
      this.resolveAlert("motion");
      this.emit("ROBOT_STATE_CHANGED", "SIMULATION", "INFO", "Platform motion cleared", {});
    }
    if (this.fog && now >= this.fog.until) {
      this.fog = null;
      this.resolveAlert("fog");
      this.restoreConfidence();
      this.emit("CAMERA_STATUS_CHANGED", "SIMULATION", "INFO", "Fog cleared — sensor confidence restored", {});
    }
    for (const [zoneId, until] of this.gasLeaks) if (now >= until) {
      this.gasLeaks.delete(zoneId);
      this.resolveAlert(`gas-${zoneId}`);
      this.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", `Gas leak cleared — Zone ${zoneId} restored`, { zone_id: zoneId });
    }
    for (const [zoneId, until] of this.droppedObjects) if (now >= until) {
      this.droppedObjects.delete(zoneId);
      this.resolveAlert(`drop-${zoneId}`);
      this.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", `Dropped object cleared — Zone ${zoneId} restored`, { zone_id: zoneId });
    }
    for (const [robotId, until] of this.commsBlackouts) if (now >= until) {
      this.commsBlackouts.delete(robotId);
      const r = S.robots[robotId];
      if (r) {
        const rt = this.rt[robotId];
        rt.returningBase = false; rt.target = null; rt.phase = null; r.path = []; r.path_index = 0;
        if (r.flight) { r.flight.signal_lost = false; if (r.flight.return_reason === "comms blackout") r.flight.return_reason = undefined; }
        this.resolveAlert(`comms-${robotId}`);
        this.emit("ROBOT_STATE_CHANGED", "SIMULATION", "INFO", `${robotId} communications restored`, { robot_id: robotId });
      }
    }
    this.restoreConfidence();
    for (const [zid, cz] of this.congestedZones) if (now >= cz.until) { this.congestedZones.delete(zid); this.resolveAlert(`traffic-${zid}`); this.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", `Zone ${zid} traffic back to normal`, { zone_id: zid }); }
    for (const pid in S.people) { const p = S.people[pid]; if (p.expires_tick !== null && now >= p.expires_tick) { delete S.people[pid]; if (p.zone && !Object.values(S.people).some((q) => q.zone === p.zone)) { this.blockedZones.delete(p.zone); S.zones[p.zone].blocked_reason = null; S.zones[p.zone].blocked_since_tick = null; this.resolveAlert(`zone-${p.zone}`); this.emit("HUMAN_CLEARED", "VLM", "INFO", `Zone ${p.zone} clear`, { zone_id: p.zone }); this.emit("ZONE_UNBLOCKED", "SIMULATION", "INFO", `Zone ${p.zone} unblocked`, { zone_id: p.zone }); } } }
  }

  /** Human-readable location label driven by the spec's theme */
  private pretty(locId: string): string {
    const l = this.loc[locId]; if (!l) return locId;
    const label = this.site.spec.theme.location_labels[l.kind];
    if (label) {
      const suffix = locId.includes("-") ? locId.slice(locId.indexOf("-") + 1) : "";
      return suffix ? `${label} ${suffix}` : label;
    }
    return locId.replace("-", " ");
  }
}
