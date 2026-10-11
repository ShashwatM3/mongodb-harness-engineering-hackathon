/**
 * runShift: the headless twin. One SimEngine per seed, N ticks, no rendering; returns the contract's
 * RunShiftResponse. Deterministic: the same brain and seed give a byte-identical body.
 *
 * Scenario profiles are seeded scripts of injections (lift fault, human intrusion, task burst) so every
 * seed is a different shift with the same kind of trouble; "standard" is the training/validation profile.
 */
import { compileSite } from "../compiler/compile";
import { SimEngine } from "../engine/engine";
import { mulberry32 } from "../engine/rng";
import type { EnvSpec } from "../spec/types";
import type { ScenarioInjection, TaskState } from "../schema/twin_state";
import { compileBrain, type CompiledBrain } from "./brain";
import type { Brain, FailureEntry, RunShiftResponse, ScenarioEntry, SeedResult, SpecPatch, TimeSplit, ZoneMetrics } from "./contract";
import { DEFAULT_PROFILE, DEFAULT_TICKS, FAILURES_CAP_PER_TYPE, FAILURE_TYPES, TIME_STATES } from "./contract";
import { shortHash } from "./hash";
import { SPEC_SIM_OVERLAY } from "./settings";

export class BrainRejectedError extends Error {
  constructor(public compiled: CompiledBrain, message: string) { super(message); }
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The spec every brain runs on: the warehouse plus the frozen spec-level settings. Hashed once as spec_hash. */
export function baseSpec(spec: EnvSpec): EnvSpec {
  return { ...spec, sim: { ...SPEC_SIM_OVERLAY, ...(spec.sim ?? {}) } };
}

export function applyPatch(spec: EnvSpec, patch: SpecPatch): EnvSpec {
  const out: EnvSpec = JSON.parse(JSON.stringify(spec));
  out.sim = { ...(out.sim ?? {}), ...(patch.sim ?? {}) };
  for (const [cid, fields] of Object.entries(patch.classes ?? {})) {
    const c = out.fleet.classes.find((x) => x.id === cid);
    if (c) Object.assign(c, fields);
  }
  for (const [zid, fields] of Object.entries(patch.zones ?? {})) {
    const z = out.zones.find((x) => x.id === zid);
    if (z && fields.capacity !== undefined) z.capacity = fields.capacity;
  }
  return out;
}

type Scripted = ScenarioInjection & { clear_at_tick?: number };

/** Seeded disruption script. Same profile + seed → same script. */
export function scenarioScript(spec: EnvSpec, profile: string, seed: number, ticks: number): Scripted[] {
  if (profile === "none") return [];
  const rnd = mulberry32((seed * 7919 + hashStr(profile)) | 0);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));
  const groundZones = spec.zones.filter((z) => (z.floor ?? 1) === 1).map((z) => z.id);
  const out: Scripted[] = [];
  if (spec.lifts.length) {
    const at = between(Math.round(ticks * 0.3), Math.round(ticks * 0.6));
    out.push({ kind: "LIFT_FAULT", lift_id: pick(spec.lifts).id, at_tick: at, clear_at_tick: at + between(1200, 2400) });
  }
  out.push({ kind: "HUMAN_INTRUSION", zone_id: pick(groundZones), duration_ticks: between(600, 1200), at_tick: between(Math.round(ticks * 0.15), Math.round(ticks * 0.45)) });
  out.push({ kind: "TASK_BURST", count: between(4, 8), priority: "HIGH", at_tick: between(Math.round(ticks * 0.4), Math.round(ticks * 0.7)) });
  if (profile === "stress") {
    out.push({ kind: "TASK_BURST", count: between(6, 10), priority: "HIGH", at_tick: between(Math.round(ticks * 0.2), Math.round(ticks * 0.35)) });
    out.push({ kind: "HUMAN_INTRUSION", zone_id: pick(groundZones), duration_ticks: between(600, 900), at_tick: between(Math.round(ticks * 0.6), Math.round(ticks * 0.8)) });
  }
  return out.sort((a, b) => (a.at_tick ?? 0) - (b.at_tick ?? 0));
}

function hashStr(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h | 0; }

export interface RunOptions {
  ticks?: number; profile?: string; allowLocked?: boolean; heldOut?: boolean;
  engineSha: string;
  onEngine?: (engine: SimEngine, seed: number) => void;
}

export function runSeed(spec: EnvSpec, seed: number, ticks: number, profile: string, onEngine?: RunOptions["onEngine"]): SeedResult {
  const site = compileSite(spec);
  const engine = new SimEngine(site, { seed });
  onEngine?.(engine, seed);
  const script = scenarioScript(spec, profile, seed, ticks);
  const clears: Array<{ at: number; kind: ScenarioInjection["kind"]; target: string }> = [];
  for (const inj of script) {
    engine.inject(inj);
    if (inj.kind === "LIFT_FAULT" && inj.clear_at_tick) clears.push({ at: inj.clear_at_tick, kind: "LIFT_FAULT", target: inj.lift_id });
  }
  clears.sort((a, b) => a.at - b.at);
  let ci = 0;
  for (let i = 0; i < ticks; i++) {
    engine.step();
    while (ci < clears.length && clears[ci].at <= engine.state.sim.tick) { engine.clearInjection(clears[ci].kind, clears[ci].target); ci++; }
  }
  return score(engine, spec, seed, ticks, script);
}

function score(engine: SimEngine, spec: EnvSpec, seed: number, ticks: number, script: Scripted[]): SeedResult {
  const S = engine.state, H = engine.harness, P = engine.P;
  type Row = ZoneMetrics & { durations: number[] };
  const zones: Record<string, Row> = {};
  for (const z of spec.zones) zones[z.id] = { offered: 0, on_time: 0, late: 0, failed: 0, dropped: H.dropped[z.id] ?? 0, censored: 0, safety_events: 0, score: 0, avg_task_s: null, time_split: emptySplit(), durations: [] };
  const tasks: Array<Pick<TaskState, "id" | "type" | "status" | "source" | "destination" | "parent_task_id" | "created_tick" | "completed_tick" | "deadline_tick">> = [...H.closed, ...Object.values(S.tasks)];
  for (const t of tasks) {
    const z = engine.taskZone(t as TaskState); if (!z || !zones[z]) continue;
    const row = zones[z];
    if (t.parent_task_id === null) row.offered++;
    if (t.status === "COMPLETED") {
      if (t.deadline_tick === null || (t.completed_tick ?? 0) <= t.deadline_tick) row.on_time++; else row.late++;
      row.durations.push(((t.completed_tick ?? 0) - t.created_tick) * P.TICK_S);
    } else if (t.status === "FAILED" || t.status === "CANCELLED") row.failed++;
  }
  // safety events are attributed to the zone the intrusion happened in; without one, to the busiest zone
  const intrusionZones = script.filter((s) => s.kind === "HUMAN_INTRUSION").map((s) => (s as { zone_id: string }).zone_id);
  const safetyZone = intrusionZones[0] ?? Object.keys(zones)[0];
  if (zones[safetyZone]) zones[safetyZone].safety_events = H.human_proximity;
  const out: Record<string, ZoneMetrics> = {};
  for (const [zid, row] of Object.entries(zones)) {
    row.censored = Math.max(0, row.offered - row.on_time - row.late - row.failed);
    const scored = Math.max(1, row.offered - row.censored);
    row.score = r3(Math.min(1, Math.max(0, row.on_time / scored - 0.05 * row.safety_events)));
    row.avg_task_s = row.durations.length ? Math.round(row.durations.reduce((a, b) => a + b, 0) / row.durations.length) : null;
    const tm = H.time[zid];
    if (tm) { const tot = TIME_STATES.reduce((a, k) => a + tm[k], 0) || 1; for (const k of TIME_STATES) row.time_split[k] = r3(tm[k] / tot); }
    const { durations: _d, ...m } = row; void _d;
    out[zid] = m;
  }
  const robots = Object.values(S.robots);
  const lifts = Object.values(S.lifts);
  const waitN = lifts.reduce((a, l) => a + l.wait_n, 0);
  const failures: FailureEntry[] = [];
  const perType: Record<string, number> = {};
  for (const f of H.failures) { perType[f.type] = (perType[f.type] ?? 0) + 1; if (perType[f.type] <= FAILURES_CAP_PER_TYPE) failures.push(f as FailureEntry); }
  const failure_counts: Record<string, number> = {};
  for (const t of FAILURE_TYPES) failure_counts[t] = H.failure_counts[t] ?? 0;
  const scenario: ScenarioEntry[] = script.map((s) => {
    const { kind, at_tick, ...rest } = s as Scripted & Record<string, unknown>;
    return { kind, at_tick: at_tick ?? 0, ...rest } as ScenarioEntry;
  });
  return {
    seed, ticks,
    zones: out,
    fleet: {
      completed: S.kpi.operation.completed_today, on_time_rate: r3(S.kpi.operation.on_time_rate),
      energy_kwh: r3(robots.reduce((a, r) => a + r.stats.energy_wh, 0) / 1000),
      stair_trips: H.stair_trips, lift_trips: lifts.reduce((a, l) => a + l.trips, 0),
      avg_lift_wait_s: waitN ? r3(lifts.reduce((a, l) => a + l.wait_total_ticks, 0) / waitN * P.TICK_S) : 0,
      battery_strandings: H.battery_strandings,
    },
    safety: { human_proximity: H.human_proximity, near_misses: H.near_misses, separation_pushes: H.separation_pushes },
    failures, failure_counts, scenario,
  };
}

function emptySplit(): TimeSplit { return { travel: 0, lift_wait: 0, lift_ride: 0, stairs: 0, blocked: 0, pick_drop: 0 }; }

export function runShift(spec: EnvSpec, brain: Brain, seeds: number[], opts: RunOptions): RunShiftResponse {
  const t0 = Date.now();
  const ticks = opts.ticks ?? DEFAULT_TICKS, profile = opts.profile ?? DEFAULT_PROFILE;
  const base = baseSpec(spec);
  const compiled = compileBrain(brain);
  if (compiled.rejected.length) throw new BrainRejectedError(compiled, `brain rejected: ${compiled.rejected.map((r) => `${r.target}=${String(r.value)} (${r.reason})`).join("; ")}`);
  if (compiled.locked_edits.length && !opts.allowLocked) throw new BrainRejectedError(compiled, `locked edits need approval: ${compiled.locked_edits.map((l) => `${l.target}=${l.value}`).join(", ")}`);
  const patched = applyPatch(base, compiled.patch);
  const per_seed = seeds.map((s) => runSeed(patched, s, ticks, profile, opts.onEngine));
  const zoneIds = spec.zones.map((z) => z.id);
  const pooled: RunShiftResponse["pooled"] = { zones: {} };
  const mean: RunShiftResponse["mean"] = { zones: {}, fleet: { on_time_rate: 0, completed: 0, stair_trips: 0, lift_trips: 0, avg_lift_wait_s: 0 } };
  const n = Math.max(1, per_seed.length);
  for (const z of zoneIds) {
    const sum = { offered: 0, on_time: 0, late: 0, failed: 0, dropped: 0, censored: 0, safety_events: 0 };
    for (const r of per_seed) { const m = r.zones[z]; if (!m) continue; for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += m[k]; }
    const scored = Math.max(1, sum.offered - sum.censored);
    pooled.zones[z] = { ...sum, score: r3(Math.min(1, Math.max(0, sum.on_time / scored - 0.05 * (sum.safety_events / n)))) };
    mean.zones[z] = { score: r3(per_seed.reduce((a, r) => a + (r.zones[z]?.score ?? 0), 0) / n) };
  }
  for (const k of Object.keys(mean.fleet) as (keyof typeof mean.fleet)[]) mean.fleet[k] = r3(per_seed.reduce((a, r) => a + r.fleet[k], 0) / n);
  const warnings = [...compiled.warnings];
  if (compiled.locked_edits.length) warnings.push(`ran with ${compiled.locked_edits.length} locked edit(s) under allow_locked`);
  return {
    engine_sha: opts.engineSha, spec_id: spec.meta.id, spec_hash: specHash(spec), brain_version: brain.version,
    patch_hash: compiled.patch_hash, ticks, scenario_profile: profile, per_seed, mean, pooled, warnings, wall_ms: Date.now() - t0,
  };
}

const specHashCache = new WeakMap<EnvSpec, string>();
export function specHash(spec: EnvSpec): string {
  let h = specHashCache.get(spec);
  if (!h) { h = shortHash(baseSpec(spec)); specHashCache.set(spec, h); }
  return h;
}
