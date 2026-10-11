"""Content hashes, the env key, and a local mirror of the brain compiler.

Every id the KG mints is a hash of what the thing *is*, so the same evaluation
recorded twice lands on the same document:
  shift     hash(env key, patch_hash, seed)
  gate run  hash(env key, sorted seeds, base_patch_hash, cand_patch_hash)
  event     hash(gate run, round, policy)

Until the runner serves /validate_brain, patch hashes come from `compile_patch`,
which applies the compiler's precedence (deepest node wins; a tie goes to the
later node, as in physical-ai src/harness/fake.ts) and hashes the resulting
SpecPatch. Local hashes start with "kg-", so they are never mistaken for the
runner's; the env key (engine_sha "fake" vs a real SHA) keeps the two apart anyway.
"""
from __future__ import annotations

import hashlib
import json
import math
import uuid
from typing import Any, Iterable, Optional

from pydantic import BaseModel

from .contract import Brain, BrainEdit, BrainNode


def norm_number(v: Any) -> Any:
    """2.0 → 2, -0.0 → 0, so equal settings always hash equal."""
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        if math.isfinite(v) and v.is_integer():
            return int(v)
        return v
    return v


def _norm(obj: Any) -> Any:
    if isinstance(obj, BaseModel):
        obj = obj.model_dump(mode="json", exclude_none=True)
    if isinstance(obj, dict):
        return {str(k): _norm(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_norm(v) for v in obj]
    return norm_number(obj)


def canonical_json(obj: Any) -> str:
    return json.dumps(_norm(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(obj: Any, n: int = 24) -> str:
    return hashlib.sha256(canonical_json(obj).encode()).hexdigest()[:n]


def same_value(a: Optional[float], b: Optional[float]) -> bool:
    if a is None or b is None:
        return a is b
    return math.isclose(float(a), float(b), rel_tol=0, abs_tol=1e-9)


# ── env key and ids ──────────────────────────────────────────

class Env(BaseModel):
    """Where a result was measured. Results from different envs are never mixed."""
    engine_sha: str
    spec_id: str
    spec_hash_or_epoch: str
    ticks: int
    profile: str

    @property
    def key(self) -> str:
        return "env-" + digest(self.model_dump(), 16)


def sorted_seeds(seeds: Iterable[int]) -> list[int]:
    return sorted({int(s) for s in seeds})


def shift_id(env_key: str, patch_hash: str, seed: int) -> str:
    return "sh-" + digest([env_key, patch_hash, int(seed)])


def gate_run_id(env_key: str, seeds: Iterable[int], base_hash: str, cand_hash: str) -> str:
    return "gr-" + digest([env_key, sorted_seeds(seeds), base_hash, cand_hash])


def event_id(gate_run: str, round_: int, policy: str) -> str:
    """UUID-shaped, so any Raindrop surface that expects a UUID accepts it; deterministic."""
    return str(uuid.UUID(hex=digest([gate_run, int(round_), str(policy)], 32)))


def episode_ids(shift: str, failures: list[dict]) -> list[str]:
    """ep:<shift>:<type>:<tick>, with :2, :3 … when one shift has several of a type at one tick."""
    seen: dict[tuple, int] = {}
    out = []
    for f in failures:
        k = (f["type"], int(f["tick"]))
        seen[k] = seen.get(k, 0) + 1
        base = f"ep:{shift}:{k[0]}:{k[1]}"
        out.append(base if seen[k] == 1 else f"{base}:{seen[k]}")
    return out


# ── local compiler mirror ────────────────────────────────────

def edit_of(node: BrainNode) -> Optional[BrainEdit]:
    b = node.body
    if isinstance(b, BrainEdit):
        return b
    if isinstance(b, dict) and b.get("op") == "set" and isinstance(b.get("target"), str) \
            and isinstance(b.get("value"), (int, float)) and not isinstance(b.get("value"), bool):
        return BrainEdit(op="set", target=b["target"], value=b["value"])
    return None


def node_depths(nodes: list[BrainNode]) -> dict[str, int]:
    """depth = 1 + depth(parent); a root, or a node whose parent is missing, counts from 0 (fake.ts depthOf)."""
    by_id = {n.node_id: n for n in nodes}
    memo: dict[str, int] = {}

    def depth(nid: Optional[str], seen: frozenset = frozenset()) -> int:
        n = by_id.get(nid) if nid is not None else None
        if n is None or not n.parent_id or nid in seen:
            return 0
        if nid in memo:
            return memo[nid]
        d = 1 + depth(n.parent_id, seen | {nid})
        memo[nid] = d
        return d

    return {n.node_id: depth(n.node_id) for n in nodes}


def effective_edits(brain: Brain) -> dict[str, dict]:
    """target → {value, node_id, depth}: the winning edit per target after precedence."""
    depths = node_depths(brain.nodes)
    best: dict[str, tuple] = {}
    for i, n in enumerate(brain.nodes):
        e = edit_of(n)
        if e is None:
            continue
        key = (depths.get(n.node_id, 0), i)
        if e.target not in best or key > best[e.target][0]:
            best[e.target] = (key, norm_number(e.value), n.node_id)
    return {t: {"value": v, "node_id": nid, "depth": k[0]} for t, (k, v, nid) in sorted(best.items())}


def compile_patch(effective: dict[str, dict]) -> tuple[dict, list[dict]]:
    """Effective edits → SpecPatch dict, plus targets the compiler would not know where to put."""
    patch: dict[str, dict] = {"sim": {}, "classes": {}, "zones": {}}
    unknown = []
    for target, e in effective.items():
        v = norm_number(e["value"])
        parts = target.split(".")
        if parts[0] == "sim" and len(parts) == 2:
            patch["sim"][parts[1]] = v
        elif parts[0] == "assign" and len(parts) == 2:
            patch["sim"][parts[1]] = v          # assign.W_* compile to sim.W_*
        elif parts[0] == "class" and len(parts) == 3:
            patch["classes"].setdefault(parts[1], {})[parts[2]] = v
        elif parts[0] == "zone" and len(parts) == 3 and parts[2] == "capacity":
            patch["zones"].setdefault(parts[1], {})["capacity"] = v
        else:
            unknown.append({"target": target, "value": v, "node_id": e["node_id"], "reason": "unknown target namespace"})
    return {k: v for k, v in patch.items() if v}, unknown


def local_patch_hash(patch: dict) -> str:
    return "kg-" + digest(patch, 16)
