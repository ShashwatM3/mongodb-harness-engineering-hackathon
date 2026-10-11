/**
 * compileBrain: Brain (hierarchical knowledge graph export) -> SpecPatch the engine runs with.
 *
 * Precedence: for one target, the edit on the deepest node wins; a tie goes to the later node.
 * (kg/hashing.py effective_edits mirrors this exactly.) The envelope (SETTINGS) wins over any node:
 * unknown / spec / fixed / out-of-range edits are rejected, locked edits need a matching approval.
 * Settings omitted from the brain fall back to the engine default, and a warning says so when that
 * default differs from v1, because that is how an "always take the stairs" fleet sneaks in.
 */
import type { Brain, BrainEdit, BrainNode, EffectiveEdit, LockedEdit, RejectedEdit, SpecPatch } from "./contract";
import { SETTINGS, SETTINGS_BY_TARGET } from "./settings";
import { shortHash } from "./hash";

export interface CompiledBrain {
  ok: boolean;
  patch: SpecPatch;
  patch_hash: string;
  effective: EffectiveEdit[];
  locked_edits: LockedEdit[];
  rejected: RejectedEdit[];
  warnings: string[];
}

function editOf(n: BrainNode): BrainEdit | null {
  const b = n.body as Record<string, unknown> | null | undefined;
  if (b && typeof b === "object" && b.op === "set" && typeof b.target === "string" && typeof b.value === "number" && Number.isFinite(b.value)) {
    return { op: "set", target: b.target, value: b.value };
  }
  return null;
}

function nodeDepths(nodes: BrainNode[]): Record<string, number> {
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const memo = new Map<string, number>();
  const depth = (id: string | null, seen: Set<string>): number => {
    if (id === null) return 0;
    const n = byId.get(id);
    if (!n || !n.parent_id || seen.has(id)) return 0;
    const m = memo.get(id); if (m !== undefined) return m;
    seen.add(id);
    const d = 1 + depth(n.parent_id, seen);
    memo.set(id, d);
    return d;
  };
  const out: Record<string, number> = {};
  for (const n of nodes) out[n.node_id] = depth(n.node_id, new Set());
  return out;
}

export function effectiveEdits(brain: Brain): Record<string, EffectiveEdit & { depth: number }> {
  const depths = nodeDepths(brain.nodes);
  const best: Record<string, { key: [number, number]; e: EffectiveEdit & { depth: number } }> = {};
  brain.nodes.forEach((n, i) => {
    const e = editOf(n); if (!e) return;
    const key: [number, number] = [depths[n.node_id] ?? 0, i];
    const cur = best[e.target];
    if (!cur || key[0] > cur.key[0] || (key[0] === cur.key[0] && key[1] > cur.key[1])) {
      best[e.target] = { key, e: { target: e.target, value: e.value, node_id: n.node_id, depth: key[0] } };
    }
  });
  return Object.fromEntries(Object.keys(best).sort().map((t) => [t, best[t].e]));
}

export function toPatch(effective: Record<string, EffectiveEdit>): { patch: SpecPatch; unknown: RejectedEdit[] } {
  const patch: Required<SpecPatch> = { sim: {}, classes: {}, zones: {} };
  const unknown: RejectedEdit[] = [];
  for (const [target, e] of Object.entries(effective)) {
    const parts = target.split(".");
    if (parts[0] === "sim" && parts.length === 2) patch.sim[parts[1]] = e.value;
    else if (parts[0] === "assign" && parts.length === 2) patch.sim[parts[1]] = e.value;
    else if (parts[0] === "class" && parts.length === 3) (patch.classes[parts[1]] ??= {})[parts[2]] = e.value;
    else if (parts[0] === "zone" && parts.length === 3 && parts[2] === "capacity") (patch.zones[parts[1]] ??= {}).capacity = e.value;
    else unknown.push({ target, value: e.value, node_id: e.node_id, reason: "unknown target namespace" });
  }
  const out: SpecPatch = {};
  if (Object.keys(patch.sim).length) out.sim = patch.sim;
  if (Object.keys(patch.classes).length) out.classes = patch.classes;
  if (Object.keys(patch.zones).length) out.zones = patch.zones;
  return { patch: out, unknown };
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9;

export function compileBrain(brain: Brain): CompiledBrain {
  const eff = effectiveEdits(brain);
  const { patch, unknown } = toPatch(eff);
  const approvals = brain.approvals ?? [];
  const rejected: RejectedEdit[] = [...unknown];
  const locked: LockedEdit[] = [];
  const warnings: string[] = [];
  const unknownTargets = new Set(unknown.map((u) => u.target));
  for (const [t, e] of Object.entries(eff)) {
    if (unknownTargets.has(t)) continue;
    const d = SETTINGS_BY_TARGET[t];
    const v = e.value;
    if (!d) rejected.push({ target: t, value: v, node_id: e.node_id, reason: "unknown setting" });
    else if (d.status === "spec") rejected.push({ target: t, value: v, node_id: e.node_id, reason: "spec setting: describes the building or the robot, never set by the brain" });
    else if (d.status === "fixed" && !same(v, d.v1)) rejected.push({ target: t, value: v, node_id: e.node_id, reason: `fixed setting (${d.v1}): never editable or approvable` });
    else if (v < d.min - 1e-9 || v > d.max + 1e-9) rejected.push({ target: t, value: v, node_id: e.node_id, reason: `out of range [${d.min}, ${d.max}]` });
    else if (d.integer && !Number.isInteger(v)) rejected.push({ target: t, value: v, node_id: e.node_id, reason: "must be a whole number" });
    else if (d.status === "locked" && !same(v, d.v1) && !approvals.some((a) => a.target === t && same(a.value, v))) {
      locked.push({ target: t, value: v, baseline: d.v1, node_id: e.node_id, reason: "locked: needs the Robotics Lead's approval" });
    }
  }
  const val = (t: string) => (t in eff ? eff[t].value : SETTINGS_BY_TARGET[t]?.engine_default);
  if (val("sim.PERC_SLOW") < val("sim.PERC_STOP")) {
    const t = "sim.PERC_SLOW" in eff ? "sim.PERC_SLOW" : "sim.PERC_STOP";
    if (t in eff) rejected.push({ target: t, value: eff[t].value, node_id: eff[t].node_id, reason: "PERC_SLOW must be at least PERC_STOP" });
  }
  for (const d of SETTINGS) {
    if (d.target in eff || (d.status !== "editable" && d.status !== "locked") || same(d.engine_default, d.v1)) continue;
    if (d.status === "locked") locked.push({ target: d.target, value: d.engine_default, baseline: d.v1, node_id: null, reason: "omitted: the engine default applies" });
    else warnings.push(`${d.target} omitted: engine default ${d.engine_default} applies instead of v1 ${d.v1}`);
  }
  const effective: EffectiveEdit[] = Object.values(eff).map(({ target, value, node_id }) => ({ target, value, node_id }));
  return { ok: rejected.length === 0 && locked.length === 0, patch, patch_hash: shortHash(patch), effective, locked_edits: locked, rejected, warnings };
}
