/**
 * shortHash: SHA-256 of key-sorted compact JSON, first 16 hex characters. kg/hashing.py uses the same
 * scheme (json.dumps(sort_keys=True, separators=(",", ":"))), so a patch hashes identically in both places.
 * -0 and integral floats are normalised the way Python's norm_number does (2.0 -> 2).
 */
import { createHash } from "node:crypto";

export function canonical(obj: unknown): string {
  return JSON.stringify(norm(obj));
}

function norm(v: unknown): unknown {
  if (typeof v === "number") return Object.is(v, -0) ? 0 : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = norm((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function shortHash(obj: unknown, n = 16): string {
  return createHash("sha256").update(canonical(obj)).digest("hex").slice(0, n);
}
