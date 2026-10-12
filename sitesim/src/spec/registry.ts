/**
 * Spec registry — proof that "a new environment is just a new spec file".
 * Register a JSON document here and the whole console (3D twin, sim, panels,
 * scenario injection) works against it with zero code changes.
 * Switch with ?spec=<id-prefix> or the picker in the top bar.
 */
import type { EnvSpec } from "./types";
import { compileSite, validateSpec, type CompiledSite } from "../compiler/compile";
import warehouseJson from "../specs/warehouse.json";
import retailJson from "../specs/retail.json";
import offshoreJson from "../specs/offshore.json";

export const SPECS: Record<string, EnvSpec> = {
  warehouse: warehouseJson as unknown as EnvSpec,
  retail: retailJson as unknown as EnvSpec,
  offshore: offshoreJson as unknown as EnvSpec,
};

// User-created environments (from the create-environment flow) are plain spec
// documents persisted in localStorage and merged into the same registry.
const CUSTOM_KEY = "twinforge.customSpecs";
export function loadCustomSpecs(): Record<string, EnvSpec> {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "{}") as Record<string, EnvSpec>; } catch { return {}; }
}
export function saveCustomSpec(key: string, spec: EnvSpec) {
  const all = loadCustomSpecs();
  all[key] = spec;
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(all));
  SPECS[key] = spec;
}
export function deleteCustomSpec(key: string) {
  const all = loadCustomSpecs();
  delete all[key];
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(all));
  delete SPECS[key];
}
if (typeof window !== "undefined") Object.assign(SPECS, loadCustomSpecs());

export function activeSpecKey(): string {
  const q = new URLSearchParams(window.location.search).get("spec");
  return q && q in SPECS ? q : "warehouse";
}

export function switchSpec(key: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("spec", key);
  window.location.assign(url.toString()); // full reload: engine, grids and scene all derive from the spec
}

export const specKey = typeof window !== "undefined" ? activeSpecKey() : "warehouse";
export const spec: EnvSpec = SPECS[specKey];

const problems = spec ? validateSpec(spec) : [];
if (problems.length) console.warn(`[envspec] ${spec.meta.id} has ${problems.length} validation problem(s):`, problems);

export const site: CompiledSite = compileSite(spec ?? SPECS.warehouse);
if (site.gaps.length) console.info(`[envspec] capability gaps (rendered as placeholders):`, site.gaps);
