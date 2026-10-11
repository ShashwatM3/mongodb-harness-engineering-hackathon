/**
 * The runner contract between the knowledge graph (kg/contract.py mirrors this) and the twin.
 * The KG only ever talks to the simulator through these shapes.
 */

export interface BrainEdit { op: "set"; target: string; value: number }

export interface BrainNode {
  node_id: string;
  parent_id: string | null;
  level: string;                       // "site" | "zone" | "task" | "rule" | "guardrail" | ...
  zone?: string | null;
  body?: BrainEdit | Record<string, unknown> | string | null;
  origin?: { source: string; ref?: string | null } | null;
  key?: string | null;
  label?: string | null;
  since?: number | null;
}

export interface BrainApproval { target: string; value: number; approved_by: string; ref?: string | null }

export interface Brain { version: number; nodes: BrainNode[]; approvals?: BrainApproval[] }

export interface SpecPatch {
  sim?: Record<string, number>;
  classes?: Record<string, Record<string, number>>;
  zones?: Record<string, Record<string, number>>;
}

export interface EffectiveEdit { target: string; value: number; node_id: string }
export interface LockedEdit { target: string; value: number; baseline: number; node_id: string | null; reason: string }
export interface RejectedEdit { target: string; value: unknown; node_id: string; reason: string }

export const FAILURE_TYPES = [
  "LIFT_QUEUE_JAM", "STAIR_QUEUE", "DEADLOCK_BACKOFF", "LATE_TASK",
  "DROPPED_DEMAND", "BATTERY_STRANDING", "HUMAN_REPLAN",
] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];
export const FAILURES_CAP_PER_TYPE = 25;

export const TIME_STATES = ["travel", "lift_wait", "lift_ride", "stairs", "blocked", "pick_drop"] as const;
export type TimeState = (typeof TIME_STATES)[number];
export type TimeSplit = Record<TimeState, number>;

export const DEFAULT_TICKS = 12000;
export const DEFAULT_PROFILE = "standard";

export interface RunShiftRequest {
  brain: Brain;
  seeds: number[];
  ticks?: number;
  scenario_profile?: string;
  allow_locked?: boolean;
  held_out?: boolean;
  /** demo-only: route exception points to the worker bridge */
  worker_hook?: boolean;
}

export interface ZoneMetrics {
  offered: number; on_time: number; late: number; failed: number; dropped: number; censored: number;
  safety_events: number; score: number; avg_task_s: number | null; time_split: TimeSplit;
}
export interface FleetMetrics {
  completed: number; on_time_rate: number; energy_kwh: number; stair_trips: number; lift_trips: number;
  avg_lift_wait_s: number; battery_strandings: number;
}
export interface SafetyMetrics { human_proximity: number; near_misses: number; separation_pushes: number }
export interface FailureEntry { type: FailureType; zone: string | null; tick: number; robots: string[]; detail: string; task_id?: string | null }
export interface ScenarioEntry { kind: string; at_tick: number; clear_at_tick?: number; [k: string]: unknown }

export interface SeedResult {
  seed: number; ticks: number;
  zones: Record<string, ZoneMetrics>;
  fleet: FleetMetrics;
  safety: SafetyMetrics;
  failures: FailureEntry[];
  failure_counts: Record<string, number>;
  scenario: ScenarioEntry[];
}

export interface PooledZone { offered: number; on_time: number; late: number; failed: number; dropped: number; censored: number; safety_events: number; score: number }

export interface RunShiftResponse {
  engine_sha: string;
  spec_id: string;
  spec_hash: string;
  brain_version: number;
  patch_hash: string;
  ticks: number;
  scenario_profile: string;
  per_seed: SeedResult[];
  mean: { zones: Record<string, { score: number }>; fleet: { on_time_rate: number; completed: number; stair_trips: number; lift_trips: number; avg_lift_wait_s: number } };
  pooled: { zones: Record<string, PooledZone> };
  warnings: string[];
  wall_ms?: number;
}

export interface BrainRejection {
  error: string; message: string;
  locked_edits: LockedEdit[]; rejected: RejectedEdit[]; warnings: string[];
}

export interface ValidateBrainResponse {
  ok: boolean; spec_hash: string; patch: SpecPatch; patch_hash: string;
  effective: EffectiveEdit[]; warnings: string[]; locked_edits: LockedEdit[]; rejected: RejectedEdit[];
}

export interface SettingsResponse { spec_id: string; spec_hash: string; settings: unknown[] }

export interface HealthResponse { ok: boolean; engine_sha: string; spec_id: string; spec_hash: string; mode: string }
