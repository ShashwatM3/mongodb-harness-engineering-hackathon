/**
 * EnvSpec — the single contract of TwinForge.
 *
 * Everything downstream is deterministic code that consumes this document:
 *   EnvSpec (JSON) ──► compiler (navgrids + indexes) ──► engine (sim) + renderer (R3F scene)
 *
 * Rules:
 *  1. The spec is pure JSON-serializable data. No code, no functions.
 *  2. Agents (or humans) only ever author specs. They never touch the simulator.
 *  3. Fixture `kind` is an open vocabulary: kinds unknown to the component
 *     library are surfaced as capability gaps and rendered as labeled
 *     placeholder proxies — the sim keeps running.
 *  4. Coordinates: right-handed, meters. x = long side, z = short side, y = up.
 *     Grid cells are [col, row] on a cell_size lattice over (x, z).
 */

export type P2 = [number, number];
export type P3 = [number, number, number];
export type Rect = [number, number, number, number]; // x0, z0, x1, z1

// ─────────────────────────────────────────────────────────────
// Site & structure
// ─────────────────────────────────────────────────────────────

export interface SpecMeta {
  id: string;
  name: string;
  /** Vertical this spec belongs to, e.g. "warehouse", "retail", "hospital" */
  vertical: string;
  description?: string;
}

export interface SpecSite {
  units: "m";
  size: { width: number; depth: number; height: number };
  grid: { cell_size: number; cols: number; rows: number };
}

export interface SpecFloor {
  id: number;
  name: string;
  elevation: number;
  /** Floors above ground must declare their slab footprint (walkable extent) */
  footprint?: P2[];
}

export interface SpecZone {
  id: string;
  name: string;
  color: string;
  floor?: number;
  polygon: P2[];
  /** Robots inside before the zone reads as congested (default from sim params) */
  capacity?: number;
  /** ATEX/IEC Ex hazardous-atmosphere classification; metadata only in Phase 1. */
  ex_zone?: 0 | 1 | 2 | "safe";
}

// ─────────────────────────────────────────────────────────────
// Fixtures — the parametric component library's input.
// One array, discriminated by `kind`. Known kinds get bespoke geometry,
// nav-grid semantics and sim behavior; unknown kinds degrade gracefully.
// ─────────────────────────────────────────────────────────────

export interface FixtureBase {
  id: string;
  kind: string;
  zone?: string;
  floor?: number;
}

/** Storage rack / gondola / cold case shelving. Blocks the grid. */
export interface RackFixture extends FixtureBase {
  kind: "rack";
  position: P3;
  size: P3; // w (x), h (y), d (z)
  rotation: number;
  levels: number;
  /** Visual variant understood by the rack renderer: "pallet" | "gondola" | "cold_case" */
  model?: string;
  blocks_grid: boolean;
}

/** Belt conveyor along a polyline. Blocks the grid; can feed a station. */
export interface ConveyorFixture extends FixtureBase {
  kind: "conveyor";
  name: string;
  path: P2[];
  width: number;
  speed_mps: number;
  blocks_grid: boolean;
  /** Location id this belt supplies; when the belt faults, that station's service time inflates */
  feeds?: string;
}

/** Work area (packing bench, sorting lane, pack-out counter…). Blocks the grid. */
export interface StationFixture extends FixtureBase {
  kind: "station";
  /** Free vocabulary, e.g. "PACKING" | "SORTING" | "PACKOUT" — matched by task grammar */
  station_kind: string;
  rect: Rect;
  access_point: P2;
}

/** Dock door with an apron area. */
export interface DockFixture extends FixtureBase {
  kind: "dock";
  dock_kind: string; // e.g. "INBOUND" | "OUTBOUND" | "RECEIVING" | "DISPATCH"
  rect: Rect;
  door: P2;
}

/** Charging cabinet + charging pad. Cabinet blocks the grid. */
export interface ChargerFixture extends FixtureBase {
  kind: "charger";
  position: P3;
  heading: number;
  power_kw: number;
  access_point: P2;
}

export interface ParkingFixture extends FixtureBase {
  kind: "parking";
  rect: Rect;
  slots: number;
}

export interface RestrictedFixture extends FixtureBase {
  kind: "restricted";
  name: string;
  rect: Rect;
  robots_allowed: boolean;
}

export interface WalkwayFixture extends FixtureBase {
  kind: "walkway";
  polygon: P2[];
  robots_allowed: boolean;
  speed_limit_mps: number;
  surface?: "solid" | "grated";
}

/** Christmas-tree wellhead stack. Blocks a small square footprint. */
export interface WellheadFixture extends FixtureBase {
  kind: "wellhead";
  position: P3;
  blocks_grid: boolean;
}

/** Tall flare boom/tower with a flame at its tip. */
export interface FlareStackFixture extends FixtureBase {
  kind: "flare_stack";
  position: P3;
  height: number;
  blocks_grid: boolean;
}

/** Parallel process pipes carried on support frames along a polyline. */
export interface PipeRackFixture extends FixtureBase {
  kind: "pipe_rack";
  path: P2[];
  width: number;
  pipe_count: number;
  blocks_grid: boolean;
}

/** Compact manifold / valve assembly footprint. */
export interface ManifoldFixture extends FixtureBase {
  kind: "manifold";
  rect: Rect;
  blocks_grid: boolean;
}

/** Cylindrical storage tank. */
export interface StorageTankFixture extends FixtureBase {
  kind: "storage_tank";
  position: P3;
  radius: number;
  height: number;
  blocks_grid: boolean;
}

/** Vertical subsea riser connection pipe at the platform edge. */
export interface RiserFixture extends FixtureBase {
  kind: "riser";
  position: P3;
  blocks_grid: boolean;
}

/** Non-blocking landing pad / helideck. */
export interface HelideckFixture extends FixtureBase {
  kind: "helideck";
  position: P3;
  radius: number;
  floor: number;
}

/** Multi-story accommodation module. */
export interface CrewQuartersFixture extends FixtureBase {
  kind: "crew_quarters";
  rect: Rect;
  height: number;
  floor: number;
  blocks_grid: boolean;
}

/** Decorative stair flight; its footprint is optionally explicit for nav-grid use. */
export interface StairsFixture extends FixtureBase {
  kind: "stairs";
  position: P3;
  rotation: number;
  from_floor: number;
  to_floor: number;
  blocks_grid: boolean;
  rect?: Rect;
}

/** Slewing pedestal crane with a lattice boom. Pedestal blocks the grid. */
export interface CraneFixture extends FixtureBase {
  kind: "crane";
  position: P3;
  boom_length: number;
  rotation: number;
  blocks_grid: boolean;
}

/** Lattice drilling derrick over the wellbay. Blocks its square base. */
export interface DerrickFixture extends FixtureBase {
  kind: "derrick";
  position: P3;
  height: number;
  base: number;
  blocks_grid: boolean;
}

/** Marked laydown/cargo staging area with stacked containers and pipe bundles. Non-blocking apron, blocking cargo stacks. */
export interface LaydownFixture extends FixtureBase {
  kind: "laydown";
  rect: Rect;
  blocks_grid: boolean;
}

/** Davit-launched enclosed lifeboat station on the deck edge. Blocks the grid. */
export interface LifeboatFixture extends FixtureBase {
  kind: "lifeboat";
  position: P3;
  rotation: number;
  blocks_grid: boolean;
}

/** Firefighting station: monitor cannon, hose reel cabinet, extinguisher rack. Blocks a small footprint. */
export interface FireStationFixture extends FixtureBase {
  kind: "fire_station";
  position: P3;
  blocks_grid: boolean;
}

/** Subsea flowline on the seabed (renders below the waterline; no nav-grid impact). */
export interface SubseaPipelineFixture extends FixtureBase {
  kind: "subsea_pipeline";
  path: P2[];
  depth: number;
}

/** Subsea umbilical dropping from the platform to the seabed (no nav-grid impact). */
export interface UmbilicalFixture extends FixtureBase {
  kind: "umbilical";
  position: P3;
  depth: number;
}

/** Mooring anchor with chain on the seabed (no nav-grid impact). */
export interface AnchorFixture extends FixtureBase {
  kind: "anchor";
  position: P3;
  depth: number;
}

/** Structural obstruction (pillar, plant, machine footprint). Blocks the grid. */
export interface ObstacleFixture extends FixtureBase {
  kind: "obstacle";
  obstacle_kind: string; // "PILLAR" | "CONVEYOR_EQUIP" | …
  rect: Rect;
}

/** Mezzanine support column standing on the ground floor (0.9×0.9 m base plate blocks the grid). */
export interface ColumnFixture extends FixtureBase {
  kind: "column";
  position: P2;
}

/** Any fixture kind the library does not know yet — kept open on purpose. */
export interface UnknownFixture extends FixtureBase {
  kind: string;
  position?: P3;
  rect?: Rect;
  size?: P3;
  blocks_grid?: boolean;
  [extra: string]: unknown;
}

export type Fixture =
  | RackFixture | ConveyorFixture | StationFixture | DockFixture | ChargerFixture
  | ParkingFixture | RestrictedFixture | WalkwayFixture | WellheadFixture | FlareStackFixture
  | PipeRackFixture | ManifoldFixture | StorageTankFixture | RiserFixture | HelideckFixture
  | CrewQuartersFixture | StairsFixture | ObstacleFixture | ColumnFixture
  | CraneFixture | DerrickFixture | LaydownFixture | LifeboatFixture | FireStationFixture
  | SubseaPipelineFixture | UmbilicalFixture | AnchorFixture
  | UnknownFixture;

// ─────────────────────────────────────────────────────────────
// Vertical transport
// ─────────────────────────────────────────────────────────────

export interface SpecLift {
  id: string;
  cell: [number, number];
  floors: number[];
  ride_ticks: number;
}

// ─────────────────────────────────────────────────────────────
// Task endpoints
// ─────────────────────────────────────────────────────────────

export interface SpecLocation {
  id: string;
  /** Open vocabulary matched by the task grammar, e.g. "SHELF" | "PACKING" | "AISLE" | "PACKOUT" */
  kind: string;
  zone: string;
  floor?: number;
  /** Fixture this location belongs to (rack bay, station…), if any */
  fixture_id: string | null;
  level_range: [number, number] | null;
  access_point: P2;
}

// ─────────────────────────────────────────────────────────────
// Fleet & actors
// ─────────────────────────────────────────────────────────────

export interface SpecRobotClass {
  id: string; // e.g. "AMR-L"
  max_speed: number; // m/s
  capacity: number; // load units
  lidar: { range_m: number; fov_deg: number };
  /** Omitted classes retain the original wheeled AMR behavior. */
  locomotion?: "wheeled" | "legged" | "aerial" | "static";
  /** Optional tracked/wheeled Ex-zone platform visual; motion remains ground-grid. */
  crawler?: boolean;
  can_climb_stairs?: boolean;
  terrain_tolerance?: number;
  min_clearance_cells?: number;
  ex_certified_zones?: Array<0 | 1 | 2>;
  flight?: {
    cruise_alt_m: number;
    max_flight_ticks: number;
    rth_battery_pct: number;
    max_wind_mps?: number;
  };
}

export interface SpecRobotSpawn {
  id: string;
  class: string;
  position: P3;
  heading: number;
  battery: number;
  floor?: number;
}

export interface SpecStaticActor {
  kind: "WORKER" | "FORKLIFT";
  position: P3;
  heading?: number;
}

export interface SpecFleet {
  classes: SpecRobotClass[];
  spawns: SpecRobotSpawn[];
  /** Decorative NPCs (rendered, not simulated) — keep them in restricted areas */
  static_actors?: SpecStaticActor[];
}

// ─────────────────────────────────────────────────────────────
// Task grammar — how demand is generated and validated
// ─────────────────────────────────────────────────────────────

export interface SpecTaskType {
  id: string; // e.g. "PICK" | "ORDER_PICK"
  /** Relative generation weight (normalized across types) */
  weight: number;
  /** Location kinds the generator draws sources/destinations from */
  gen_source_kinds: string[];
  gen_dest_kinds: string[];
  /** Location kinds accepted for manual task creation (validation superset) */
  allowed_source_kinds: string[];
  allowed_dest_kinds: string[];
}

export interface SpecTasks {
  types: SpecTaskType[];
  /** Mean ticks between generated tasks (jittered ±50% deterministically) */
  interval_ticks: number;
  max_waiting: number;
  /** [threshold, priority] cumulative bands over one uniform draw; fallthrough = NORMAL */
  priority_bands: Array<[number, "HIGH" | "CRITICAL" | "LOW"]>;
  on_time_limit_ticks: number;
}

// ─────────────────────────────────────────────────────────────
// Simulation parameter overrides (defaults live in the engine —
// every value here is optional so specs stay terse)
// ─────────────────────────────────────────────────────────────

export interface SpecSimParams {
  [key: string]: number | undefined;
  MAX_SPEED?: number; ACCEL?: number; PICK_TICKS?: number; DROP_TICKS?: number;
  BATTERY_MOVE?: number; BATTERY_LOAD?: number; BATTERY_IDLE?: number; CHARGE_RATE?: number;
  LIDAR_RANGE?: number; ZONE_CAPACITY?: number; IDLE_TO_PARK_TICKS?: number;
  LIFT_TRAVEL_TICKS?: number; LIFT_DOOR_TICKS?: number;
  STAIR_CLIMB_TICKS?: number;
}

// ─────────────────────────────────────────────────────────────
// KPIs, scenarios & theme
// ─────────────────────────────────────────────────────────────

export interface SpecKpis {
  completed_target: number;
  /** Target completion rate for the throughput chart's dashed line */
  target_per_min: number;
}

export interface SpecScenarios {
  /** Preselected targets in the injection drawer (falls back to first of each list) */
  defaults?: { robot?: string; conveyor?: string; camera?: string; lift?: string; zone?: string };
  /** The one-click compound demo */
  compound?: Array<Record<string, unknown> & { kind: string }>;
}

export interface SpecCamera {
  id: string;
  zone: string;
  floor?: number;
  position: P3;
  look_at: P3;
  fov_deg: number;
  range_m: number;
}

export interface SpecSensor {
  id: string;
  kind: "LIDAR" | "IR" | "WEIGHT" | "TEMP" | "PRESENCE";
  zone: string;
  position: P3;
  /** Fixture this sensor instruments (e.g. the conveyor a WEIGHT cell weighs) */
  of?: string;
}

export interface SpecTheme {
  /** Colors */
  bg: string; floor: string; wall: string; accent: string;
  /** Yellow floor marking segments [x0, z0, x1, z1] */
  floor_markings: Rect[];
  /** Decorative colored point lights [x, y, z, color] */
  accent_lights: Array<[number, number, number, string]>;
  /** Subsystem health rows shown in the System Status panel */
  subsystems: Array<{ key: string; label: string }>;
  /** Uniform visual scale multiplier for robot meshes (visual only; nav footprint unchanged) */
  robot_scale?: number;
  /** Enables the marine environment: animated sea surface, seabed, sky horizon */
  marine?: boolean;
  /** Water surface elevation for marine environments (defaults to -4) */
  water_level?: number;
  sim_start_hour: number;
  sim_date: string;
  /** Pretty-print rules for location ids in logs/panels: kind → label */
  location_labels: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────
// Provenance — every parameter traceable to a source
// ─────────────────────────────────────────────────────────────

export interface SpecProvenance {
  [path: string]: { src: "blueprint" | "interview" | "research" | "reference" | "default"; ref?: string; conf?: number };
}

// ─────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────

export interface EnvSpec {
  schema_version: "2.0";
  meta: SpecMeta;
  site: SpecSite;
  floors: SpecFloor[];
  zones: SpecZone[];
  fixtures: Fixture[];
  lifts: SpecLift[];
  locations: SpecLocation[];
  fleet: SpecFleet;
  tasks: SpecTasks;
  sim?: SpecSimParams;
  kpis: SpecKpis;
  scenarios?: SpecScenarios;
  cameras: SpecCamera[];
  sensors: SpecSensor[];
  theme: SpecTheme;
  provenance?: SpecProvenance;
}
