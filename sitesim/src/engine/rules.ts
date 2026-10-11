/**
 * Task validation, driven entirely by the EnvSpec task grammar:
 * locations must exist, differ, never be a charger, and match the task type's
 * allowed source/destination location kinds.
 */
import type { SpecLocation, SpecTaskType } from "../spec/types";

/** Returns an error message; null = valid. */
export function taskError(
  loc: Record<string, SpecLocation>,
  types: SpecTaskType[],
  type: string,
  source: string,
  destination: string,
): string | null {
  const rule = types.find((t) => t.id === type);
  if (!rule) return `unknown task type ${type}`;
  const s = loc[source], d = loc[destination];
  if (!s) return `unknown source location ${source}`;
  if (!d) return `unknown destination location ${destination}`;
  if (source === destination) return "source and destination must differ";
  if (s.kind === "CHARGING" || d.kind === "CHARGING") return "charging stations cannot be task locations";
  if (!rule.allowed_source_kinds.includes(s.kind)) return `${type} source must be one of ${[...rule.allowed_source_kinds].sort().join(", ")}, got ${s.kind}`;
  if (!rule.allowed_dest_kinds.includes(d.kind)) return `${type} destination must be one of ${[...rule.allowed_dest_kinds].sort().join(", ")}, got ${d.kind}`;
  return null;
}
