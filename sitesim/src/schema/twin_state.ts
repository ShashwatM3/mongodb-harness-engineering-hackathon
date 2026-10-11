/**
 * TwinState — the runtime data contract between the deterministic engine and the UI.
 *
 * Rules:
 *  1. Pure serializable data. No Three.js objects, no functions, no class instances
 *     (this is what makes what-if cloning and state hand-off trivial).
 *  2. tick = 100 ms of simulated time. wall time is display-only.
 *  3. All enums are uppercase strings for log readability.
 *  4. Anything environment-specific (task types, location kinds, subsystem keys)
 *     is an open string vocabulary defined by the active EnvSpec.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
export type GridCell = [number, number];

export type RobotId = string;
export type TaskId = string;
export type ZoneId = string;
export type ConveyorId = string;
export type CameraId = string;
export type SensorId = string;
export type EventId = string;
export type AlertId = string;
export type LocationId = string;

// ─────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────

export type RobotStatus = "ACTIVE" | "CHARGING" | "IDLE" | "WARNING" | "ERROR" | "OFFLINE";

export type RobotLocomotion = "wheeled" | "legged" | "aerial" | "static";
export type DroneFlightMode = "GROUNDED" | "OUTBOUND" | "RETURNING_HOME" | "LANDED";

export interface DroneFlightState {
  mode: DroneFlightMode;
  waypoints: Vec3[];
  waypoint_index: number;
  altitude: number;
  home: Vec3;
  signal_lost: boolean;
  flight_ticks: number;
  return_reason?: string;
}

export type RobotFsmState =
  | "IDLE" | "TASK_ASSIGNED" | "NAVIGATING" | "PICKING" | "TRANSPORTING" | "DELIVERING"
  | "COMPLETED" | "OBSTACLE_DETECTED" | "REPLANNING" | "LOW_BATTERY" | "TASK_TRANSFER"
  | "GOING_TO_CHARGE" | "CHARGING" | "OFFLINE" | "ERROR";

/** Open vocabulary — defined by the EnvSpec task grammar */
export type TaskType = string;
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
export type TaskStatus = "WAITING" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TRANSFERRED";

export type ConveyorStatus = "RUNNING" | "WARNING" | "STOPPED" | "MAINTENANCE" | "ERROR";
export type DeviceStatus = "ONLINE" | "DEGRADED" | "OFFLINE";
export type ZoneStatus = "NORMAL" | "CONGESTED" | "BLOCKED" | "RESTRICTED";
export type SubsystemStatus = "NORMAL" | "WARNING" | "ERROR";
export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type EventSource =
  | "ROBOT" | "SENSOR" | "CAMERA" | "VLM" | "CONVEYOR"
  | "SIMULATION" | "FLEET_MANAGER" | "PLANNER" | "USER" | "AI_AGENT" | "LIFT";

export type EventType =
  | "ROBOT_STATE_CHANGED" | "ROBOT_BATTERY_LOW" | "ROBOT_BATTERY_CRITICAL"
  | "ROBOT_OFFLINE" | "ROBOT_ONLINE" | "ROBOT_COLLISION_AVOIDED"
  | "TASK_CREATED" | "TASK_ASSIGNED" | "TASK_STARTED" | "TASK_COMPLETED" | "TASK_FAILED" | "TASK_TRANSFERRED"
  | "ROUTE_PLANNED" | "ROUTE_REPLANNED" | "OBSTACLE_DETECTED"
  | "ZONE_BLOCKED" | "ZONE_UNBLOCKED" | "ZONE_CONGESTION_HIGH" | "HUMAN_DETECTED" | "HUMAN_CLEARED"
  | "LIFT_REQUESTED" | "ROBOT_BOARDING_STARTED" | "LIFT_LEVELING" | "ROBOT_ALIGHTING_STARTED"
  | "LIFT_COOLDOWN_STARTED" | "LIFT_RESERVED" | "LIFT_QUEUE_ENTERED" | "LIFT_ARRIVED"
  | "LIFT_GATE_OPENED" | "ROBOT_BOARDED" | "LIFT_DEPARTED" | "ROBOT_EXITED" | "LIFT_FAULT"
  | "LIFT_RESERVATION_RELEASED"
  | "CONVEYOR_STATUS_CHANGED" | "CAMERA_STATUS_CHANGED" | "SENSOR_STATUS_CHANGED"
  | "AI_DECISION" | "VLM_OBSERVATION"
  | "SIM_STARTED" | "SIM_PAUSED" | "SIM_RESUMED" | "SIM_RESET" | "SCENARIO_INJECTED";

// ─────────────────────────────────────────────────────────────
// Robot
// ─────────────────────────────────────────────────────────────

export interface PerceivedObstacle {
  kind: "ROBOT" | "HUMAN" | "FIXTURE";
  id: string | null;
  distance_m: number;
  /** Relative bearing in degrees, left positive */
  bearing_deg: number;
}
export interface Perception {
  state: "CLEAR" | "SLOWING" | "STOPPED" | "OFF";
  ahead_m: number;
  nearest_m: number | null;
  obstacles: PerceivedObstacle[];
  confidence: number;
}

export interface RobotState {
  id: RobotId;
  model: string;
  locomotion: RobotLocomotion;
  floor: number;
  lift_id: string | null;
  lift_stage: "TO_LIFT" | "QUEUED" | "BOARDING" | "RIDING" | "ALIGHTING" | null;
  position: Vec3;
  heading: number;
  velocity: number;
  max_speed: number;
  battery: number;
  status: RobotStatus;
  fsm: RobotFsmState;
  health: number;
  current_task_id: TaskId | null;
  destination: LocationId | null;
  path: GridCell[];
  path_index: number;
  load: { current: number; capacity: number };
  zone: ZoneId | null;
  eta_s: number | null;
  fsm_since_tick: number;
  stats: { distance_m: number; tasks_completed: number; energy_wh: number; busy_ticks: number; wait_ticks: number };
  perception: Perception;
  /** Present for aerial units; omitted for ground/static units. */
  flight?: DroneFlightState;
  /** Static monitoring units increment this derived observation count. */
  monitoring?: { active: boolean; observations: number; confidence: number };
}

// ─────────────────────────────────────────────────────────────
// Task
// ─────────────────────────────────────────────────────────────

export interface TaskState {
  id: TaskId;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  source: LocationId;
  destination: LocationId;
  assigned_robot: RobotId | null;
  parent_task_id: TaskId | null;
  created_tick: number;
  assigned_tick: number | null;
  started_tick: number | null;
  completed_tick: number | null;
  deadline_tick: number | null;
  eta_s: number | null;
  load_units: number;
}

// ─────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────

export interface ZoneState {
  id: ZoneId;
  status: ZoneStatus;
  robot_count: number;
  congestion: number;
  blocked_reason: string | null;
  blocked_since_tick: number | null;
}

export interface ConveyorState {
  id: ConveyorId;
  status: ConveyorStatus;
  speed_mps: number;
  items_on_belt: number;
  throughput_per_min: number;
}

export interface CameraState {
  id: CameraId;
  zone: ZoneId;
  status: DeviceStatus;
  confidence: number;
}

export interface SensorState {
  id: SensorId;
  kind: string;
  zone: ZoneId;
  status: DeviceStatus;
  value: number | null;
  unit: string | null;
}

export type LiftFsmState =
  | "IDLE" | "MOVING_UP" | "MOVING_DOWN" | "LEVELING"
  | "DOOR_OPENING" | "BOARDING" | "DOOR_CLOSING"
  | "DOOR_OPENING_AT_DESTINATION" | "ALIGHTING" | "DOOR_CLOSING_AFTER_EXIT"
  | "COOLDOWN";

export interface LiftState {
  id: string;
  state: LiftFsmState;
  floor: number | null;
  target_floor: number | null;
  y: number;
  /** Door per served floor, keyed by floor id as string */
  doors: Record<string, "OPEN" | "CLOSED">;
  occupant: RobotId | null;
  reserved_by: RobotId | null;
  /** FIFO queue per served floor, keyed by floor id as string */
  queue: Record<string, RobotId[]>;
  until_tick: number;
  fault: boolean;
  fault_remaining: number;
  trips: number;
  busy_ticks: number;
  wait_total_ticks: number;
  wait_n: number;
}

export interface PersonState {
  id: string;
  kind: "WORKER" | "FORKLIFT";
  position: Vec3;
  heading: number;
  zone: ZoneId | null;
  floor?: number;
  expires_tick: number | null;
}

// ─────────────────────────────────────────────────────────────
// Events / alerts / decisions
// ─────────────────────────────────────────────────────────────

export interface TwinEvent {
  id: EventId;
  tick: number;
  type: EventType;
  source: EventSource;
  severity: Severity;
  message: string;
  robot_id?: RobotId;
  task_id?: TaskId;
  zone_id?: ZoneId;
  conveyor_id?: ConveyorId;
  camera_id?: CameraId;
  payload?: Record<string, unknown>;
  caused_by?: EventId;
}

export interface AlertState {
  id: AlertId;
  created_tick: number;
  severity: Severity;
  title: string;
  detail: string;
  zone_id?: ZoneId;
  robot_id?: RobotId;
  conveyor_id?: ConveyorId;
  source_event_id: EventId;
  acknowledged: boolean;
  resolved_tick: number | null;
}

export interface DecisionCandidate {
  robot_id: RobotId;
  score: number;
  distance_m: number;
  battery: number;
  workload: "LOW" | "MEDIUM" | "HIGH";
  congestion: number;
  health: number;
  reasons: string[];
  rejected_reason: string | null;
}

export interface AiDecision {
  id: string;
  tick: number;
  kind: "TASK_ASSIGNMENT" | "TASK_TRANSFER" | "REROUTE" | "CHARGE_SCHEDULING";
  task_id: TaskId | null;
  selected_robot: RobotId | null;
  candidates: DecisionCandidate[];
  weights: Record<string, number>;
  narrative: string | null;
}

// ─────────────────────────────────────────────────────────────
// KPI
// ─────────────────────────────────────────────────────────────

export interface KpiSnapshot {
  tick: number;
  fleet: { total: number; active: number; charging: number; idle: number; warning: number; error: number; offline: number };
  operation: {
    throughput_per_min: number;
    completed_today: number;
    completed_target: number;
    pending: number;
    ongoing: number;
    avg_task_time_s: number;
    on_time_rate: number;
    avg_utilization: number;
  };
  efficiency: { avg_travel_distance_m: number; avg_wait_time_s: number; congestion_index: number; energy_kwh: number };
  throughput_series: Array<{ tick: number; completed: number; target: number }>;
  lifts: { trips: number; utilization: number; avg_wait_s: number; faults: number };
}

// ─────────────────────────────────────────────────────────────
// Sim control & scenarios
// ─────────────────────────────────────────────────────────────

export type SimMode = "LIVE" | "PAUSED" | "WHATIF";

export interface SimulationState {
  tick: number;
  tick_ms: number;
  speed: 0 | 1 | 2 | 5 | 10;
  mode: SimMode;
  seed: number;
  baseline_snapshot_id: string | null;
}

export type ScenarioInjection =
  | { kind: "ROBOT_FAILURE"; robot_id: RobotId; at_tick?: number }
  | { kind: "ROBOT_BATTERY_SET"; robot_id: RobotId; battery: number; at_tick?: number }
  | { kind: "CONVEYOR_FAILURE"; conveyor_id: ConveyorId; at_tick?: number }
  | { kind: "CAMERA_OFFLINE"; camera_id: CameraId; at_tick?: number }
  | { kind: "HUMAN_INTRUSION"; zone_id: ZoneId; duration_ticks: number; at_tick?: number }
  | { kind: "TRAFFIC_CONGESTION"; zone_id: ZoneId; level: number; duration_ticks: number; at_tick?: number }
  | { kind: "TASK_BURST"; count: number; priority: TaskPriority; at_tick?: number }
  | { kind: "LIFT_FAULT"; lift_id: string; at_tick?: number }
  | { kind: "DRONE_SIGNAL_LOST"; robot_id: RobotId; at_tick?: number }
  | { kind: "HIGH_WIND"; wind_mps: number; duration_ticks: number; at_tick?: number }
  | { kind: "PLATFORM_MOTION"; severity: number; duration_ticks: number; at_tick?: number }
  | { kind: "FOG"; level: number; duration_ticks: number; at_tick?: number }
  | { kind: "GAS_LEAK"; zone_id: ZoneId; duration_ticks: number; at_tick?: number }
  | { kind: "DROPPED_OBJECT"; zone_id: ZoneId; duration_ticks: number; at_tick?: number }
  | { kind: "COMMS_BLACKOUT"; robot_id: RobotId; duration_ticks: number; at_tick?: number };

// ─────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────

export interface TwinState {
  schema_version: "2.0";
  spec_id: string;
  sim: SimulationState;
  robots: Record<RobotId, RobotState>;
  tasks: Record<TaskId, TaskState>;
  lifts: Record<string, LiftState>;
  zones: Record<ZoneId, ZoneState>;
  conveyors: Record<ConveyorId, ConveyorState>;
  cameras: Record<CameraId, CameraState>;
  sensors: Record<SensorId, SensorState>;
  people: Record<string, PersonState>;
  alerts: Record<AlertId, AlertState>;
  recent_events: TwinEvent[];
  recent_decisions: AiDecision[];
  kpi: KpiSnapshot;
  /** Open subsystem vocabulary — the spec's theme decides which rows exist */
  subsystems: Record<string, SubsystemStatus>;
}

// ─────────────────────────────────────────────────────────────
// Shared thresholds
// ─────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  BATTERY_WARNING: 20,
  BATTERY_CRITICAL: 10,
  BATTERY_CHARGE_TO: 95,
  CONGESTION_WARNING: 0.6,
  CONGESTION_BLOCK: 0.85,
  TICK_MS: 100,
  EVENT_RING_SIZE: 500,
  THROUGHPUT_SERIES_SIZE: 120,
} as const;
