/**
 * Launch configuration — the choices made on the Launch screen, carried in the
 * URL so a reload keeps them and the harness/demo can deep-link:
 *   ?spec=warehouse&agents=8&seed=42&allot=R01:PICK,R02:ANY,...&mix=0.5,0.2,0.2,0.1[&worker=1]
 *
 * This module is deliberately dependency-free (no store, no registry) so both
 * the Launch screen and the simulation runner can import it without cycles.
 */

export const ANY = "ANY";

export interface LaunchConfig {
  /** Number of robots deployed (first N of spec.fleet.spawns). undefined = all. */
  agents?: number;
  /** Robot id → allowed task type ids. Robots not listed (or listed as ANY) take any task. */
  allotment?: Record<string, string[]>;
  /** Task generation weights, positional in the order of spec.tasks.types (see taskMixFor). */
  mix?: number[];
  seed: number;
  worker: boolean;
}

export interface LaunchInput {
  spec: string;
  agents: number;
  seed: number;
  /** robot id → task type id or ANY, in deploy order */
  allot: Record<string, string>;
  /** weights in the order of spec.tasks.types */
  mix: number[];
  worker: boolean;
}

const clampInt = (v: string | null, lo: number, hi: number): number | undefined => {
  if (v === null || v === "") return undefined;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

/** Parse the launch configuration from a query string. */
export function parseLaunch(search: string): LaunchConfig {
  const q = new URLSearchParams(search);
  const cfg: LaunchConfig = { seed: clampInt(q.get("seed"), 0, 2 ** 31 - 1) ?? 42, worker: q.get("worker") === "1" };
  const agents = clampInt(q.get("agents"), 1, 999);
  if (agents !== undefined) cfg.agents = agents;
  const allot = q.get("allot");
  if (allot) {
    const map: Record<string, string[]> = {};
    for (const part of allot.split(",")) {
      const [id, type] = part.split(":");
      if (!id || !type) continue;
      const t = type.toUpperCase();
      if (t !== ANY) map[id] = t.split("|");
    }
    if (Object.keys(map).length) cfg.allotment = map;
  }
  const mix = q.get("mix");
  if (mix) {
    const ws = mix.split(",").map(Number);
    if (ws.every((w) => Number.isFinite(w) && w >= 0) && ws.some((w) => w > 0)) cfg.mix = ws;
  }
  return cfg;
}

/** Map the positional `mix` onto task type ids; undefined when absent or the lengths disagree. */
export function taskMixFor(cfg: LaunchConfig, typeIds: string[]): Record<string, number> | undefined {
  if (!cfg.mix || cfg.mix.length !== typeIds.length) return undefined;
  return Object.fromEntries(typeIds.map((id, i) => [id, cfg.mix![i]]));
}

/** Serialize launch choices into the query string the console loads. */
export function serializeLaunch(input: LaunchInput): string {
  const q = new URLSearchParams();
  q.set("spec", input.spec);
  q.set("agents", String(input.agents));
  q.set("seed", String(input.seed));
  q.set("allot", Object.entries(input.allot).map(([id, t]) => `${id}:${t}`).join(","));
  q.set("mix", input.mix.map((w) => String(Math.round(w * 100) / 100)).join(","));
  if (input.worker) q.set("worker", "1");
  return "?" + q.toString();
}

/** The configuration of the current page, parsed once at module load. */
export const launchConfig: LaunchConfig = typeof window !== "undefined" ? parseLaunch(window.location.search) : { seed: 42, worker: false };
