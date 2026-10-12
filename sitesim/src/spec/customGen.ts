/**
 * Deterministic rubric → EnvSpec generation for the create-environment flow.
 *
 * A new environment is still just a spec file: the rubric selects a proven
 * base template (warehouse / retail / offshore) and applies data-only
 * parameter overrides. No engine or renderer code paths are touched, so the
 * generated document runs through exactly the same compile → simulate → render
 * pipeline as the bundled specs.
 */
import type { EnvSpec } from "./types";
import { SPECS } from "./registry";
import { validateSpec, compileSite } from "../compiler/compile";

export interface Rubric {
  /** Environment purpose / domain */
  domain: "warehouse" | "retail" | "offshore" | null;
  /** Display name for the environment */
  name: string | null;
  /** Site scale relative to the template */
  scale: "compact" | "standard" | null;
  /** Fleet emphasis */
  fleet: "full" | "lean" | null;
  /** Operational tempo (task generation rate) */
  tempo: "calm" | "busy" | null;
  /** Environmental conditions (marine visuals for offshore-based sites) */
  conditions: "standard" | "marine" | null;
}

export const EMPTY_RUBRIC: Rubric = { domain: null, name: null, scale: null, fleet: null, tempo: null, conditions: null };

export interface RubricItem { key: keyof Rubric; label: string }
export const RUBRIC_ITEMS: RubricItem[] = [
  { key: "domain", label: "Purpose & domain" },
  { key: "name", label: "Environment name" },
  { key: "scale", label: "Site layout & scale" },
  { key: "fleet", label: "Robot fleet" },
  { key: "tempo", label: "Tasks & operational tempo" },
  { key: "conditions", label: "Environmental conditions" },
];

export const rubricComplete = (r: Rubric) => RUBRIC_ITEMS.every((i) => r[i.key] !== null);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "custom";

/** Pure data transform: rubric → new EnvSpec document. Deterministic — same rubric, same spec. */
export function generateSpec(r: Rubric): { key: string; spec: EnvSpec } {
  const base = SPECS[r.domain ?? "warehouse"];
  const spec = JSON.parse(JSON.stringify(base)) as EnvSpec;
  const name = r.name ?? "Custom Environment";
  const key = `custom-${slug(name)}`;
  spec.meta = { ...spec.meta, id: key, name, description: `Generated from the create-environment rubric (base template: ${base.meta.name}).` };

  if (r.fleet === "lean") {
    // Keep at least one robot of every class so all locomotion models stay represented
    const seen = new Set<string>();
    spec.fleet.spawns = spec.fleet.spawns.filter((s) => (seen.has(s.class) ? false : (seen.add(s.class), true)));
  }
  if (r.tempo === "busy") spec.tasks.interval_ticks = Math.max(10, Math.round(spec.tasks.interval_ticks * 0.6));
  if (r.tempo === "calm") spec.tasks.interval_ticks = Math.round(spec.tasks.interval_ticks * 1.6);
  if (r.scale === "compact") spec.kpis.completed_target = Math.max(10, Math.round(spec.kpis.completed_target * 0.6));
  if (r.conditions === "marine") { spec.theme.marine = true; spec.theme.water_level = spec.theme.water_level ?? -4; }
  if (r.conditions === "standard") spec.theme.marine = false;
  return { key, spec };
}

/** Physics/consistency gate run during the generation workflow. Throws with a readable message on failure. */
export function verifySpec(spec: EnvSpec): { fixtures: number; locations: number; robots: number; gaps: number } {
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(`Spec validation failed: ${problems.join("; ")}`);
  const site = compileSite(spec);
  for (const s of spec.fleet.spawns) {
    if (!spec.floors.some((f) => f.id === s.floor)) throw new Error(`${s.id} spawns on unknown floor ${s.floor}`);
  }
  return { fixtures: spec.fixtures.length, locations: spec.locations.length, robots: spec.fleet.spawns.length, gaps: site.gaps.length };
}
