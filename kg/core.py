"""The knowledge graph: the robot brain in Atlas, and everything the harness learns about it.

Boundary rules (KG plan, section 1):
  - The gate decides; the KG records and recommends. Nothing here promotes on its own.
  - The brain the runner receives is a projection of the KG (`export_brain`).
  - Held-out data never enters a collection the improver can read.
  - Raindrop is never on the critical path, and neither is the phone (kg/phone.py).
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional, Union

from pymongo import UpdateOne
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError, OperationFailure

from . import metrics, registry
from .config import Config
from .contract import Brain, BrainApproval, BrainNode, RunShiftResponse
from .db import ensure_schema
from .hashing import (Env, compile_patch, digest, edit_of, effective_edits, episode_ids, event_id as make_event_id,
                      gate_run_id as make_gate_run_id, local_patch_hash, norm_number, same_value, shift_id,
                      sorted_seeds)
from .ontology import (COMPONENT_KINDS, SITE_ID, SKELETON_KINDS, SKELETON_ZONES, TIME_STATES, concept_docs,
                       failure_group_of, skeleton_nodes)
from .phone import NullPhone
from .raindrop_sink import NullSink, Sink

log = logging.getLogger("kg")

VERDICTS = ("invalid", "evaluated", "passed", "promoted", "rejected", "needs_approval")


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class KGError(RuntimeError):
    pass


class PermissionDenied(KGError):
    pass


class StalePromotion(KGError):
    pass


class NeedsApproval(KGError):
    pass


class EnvMismatch(KGError):
    pass


@dataclass
class Validation:
    patch_hash: str
    effective: dict[str, dict]
    locked_edits: list[dict]
    rejected: list[dict]
    warnings: list[str]
    source: str  # "runner" | "local"


@dataclass
class Proposal:
    gate_run_id: str
    event_id: str
    status: str                       # new | cached | invalid
    edits: list[dict]
    reason: Optional[str]
    brain: Optional[Brain]            # the candidate to run (base export with the edits applied)
    base_brain: Optional[Brain]
    base_version: int
    seeds: list[int]
    split: str
    need_base: bool = False
    need_cand: bool = False
    locked_edits: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    repeat: bool = False
    cached_result: Optional[dict] = None

    @property
    def allow_locked(self) -> bool:
        """Simulate locked edits anyway (allow_locked: true), so the call can quote the effect."""
        return bool(self.locked_edits)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["brain"] = self.brain.model_dump(mode="json", exclude_none=True) if self.brain else None
        d["base_brain"] = None
        return d


def setting_component(target: str, value: float, status: str, origin: dict,
                      setting: Optional[registry.Setting] = None, parent_id: str = SITE_ID) -> dict:
    """A rule (editable setting) or guardrail (locked setting) that compiles to one typed edit, as an `add`
    item for commit_brain_version. `key` equals the setting target, so "same key, deeper wins" is the
    compiler's rule; `when`/`then` are doc 03's readable form, `compiles_to` is what the engine runs."""
    when, then = registry.rule_text(target, value)
    return {
        "kind": "guardrail" if status == "locked" else "rule", "parent_id": parent_id, "key": target,
        "label": registry.label_for(target, value), "when": when, "then": then,
        "compiles_to": {"op": "set", "target": target, "value": norm_number(value)},
        "lever": setting.lever_id if setting is not None and setting.is_lever else None, "origin": origin,
    }


def finalize_component(item: dict, version: int, evidence: Optional[dict] = None) -> dict:
    """Stamp an `add` item for version N: id `<kind>:<key>@<node>:v<N>`, since N, until null, merged evidence."""
    d = {k: v for k, v in item.items() if k not in ("_id", "since", "until")}
    d["_id"] = item.get("_id") or f"{item['kind']}:{item['key']}@{item['parent_id']}:v{version}"
    d["since"], d["until"] = version, None
    d["evidence"] = {**(item.get("evidence") or {}), **(evidence or {})}
    return d


def parse_candidate(candidate: Any) -> dict[str, float]:
    """Accepts {target: value}, [{target, value}], {"edits": [...]}, a Brain or brain dict, or JSON text of any of these."""
    c = candidate
    if isinstance(c, (bytes, str)):
        c = json.loads(c)
    if isinstance(c, Brain):
        return {t: e["value"] for t, e in effective_edits(c).items()}
    if isinstance(c, dict) and "nodes" in c:
        return {t: e["value"] for t, e in effective_edits(Brain.model_validate(c)).items()}
    if isinstance(c, dict) and "edits" in c:
        c = c["edits"]
    if isinstance(c, dict) and "target" in c and "value" in c:
        c = [c]
    if isinstance(c, dict):
        items = list(c.items())
    elif isinstance(c, list):
        items = [(e["target"], e["value"]) for e in c]
    else:
        raise ValueError(f"unrecognised candidate of type {type(c).__name__}")
    out = {}
    for t, v in items:
        if not isinstance(t, str) or isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"edit {t!r}: value must be a number, got {v!r}")
        out[t] = norm_number(v)
    return out


class KG:
    """One instance per database user. The GEPA side holds only the improver instance."""

    def __init__(self, db: Database, role: str = "gate", *, sink: Optional[Sink] = None, runner=None,
                 env: Optional[Env] = None, config: Optional[Config] = None,
                 settings: Optional[list[registry.Setting]] = None, phone=None):
        if role not in ("improver", "gate"):
            raise ValueError("role must be 'improver' or 'gate'")
        self.db, self.role = db, role
        self.sink: Sink = sink or NullSink()
        self.phone = phone or NullPhone()  # calls the Robotics Lead after significant gate decisions
        self.cfg = config or Config()
        self.runner = runner
        self._env = env
        self.settings = settings or registry.SETTINGS
        self.seed_sets = self.cfg.seed_sets()
        self._validation_cache: dict[str, Validation] = {}

    # ── plumbing ─────────────────────────────────────────────

    def c(self, name: str):
        return self.db[name]

    def _require_gate(self, what: str):
        if self.role != "gate":
            raise PermissionDenied(f"{what} needs the gate client; the improver client can't do it")

    def use_runner(self, runner, env_epoch: Optional[str] = None) -> Env:
        """Point the KG at a runner. Its /health fixes the env key for everything recorded from now on."""
        h = runner.health()
        spec_hash = h.spec_hash
        tag = f"spec:{spec_hash}" if spec_hash else f"epoch:{env_epoch or self.cfg.env_epoch}"
        self._env = Env(engine_sha=h.engine_sha, spec_id=h.spec_id, spec_hash_or_epoch=tag,
                        ticks=self.cfg.ticks, profile=self.cfg.profile)
        self.runner = runner
        self._validation_cache.clear()
        return self._env

    @property
    def env(self) -> Env:
        if self._env is None:
            raise KGError("no runner env: call kg.use_runner(runner) first")
        return self._env

    def _envelope(self) -> dict[str, dict]:
        return {d["_id"]: d for d in self.c("envelope").find({})}

    def _setting(self, target: str) -> Optional[registry.Setting]:
        return registry.by_target(self.settings).get(target)

    # ── Phase 0: seed, load, export ──────────────────────────

    def seed(self, v1_brain: Union[None, str, Path, dict, Brain] = None) -> dict:
        """Skeleton, concepts, envelope, one v1 component per setting at site:main, and brain_versions v1.
        Idempotent: a second run reports nothing inserted or updated. Never overwrites a v1 component."""
        self._require_gate("seed()")
        report = {"collections_created": ensure_schema(self.db), "inserted": Counter(), "updated": Counter(),
                  "warnings": []}

        def upsert(coll, _id, set_fields=None, on_insert=None):
            upd = {}
            if set_fields:
                upd["$set"] = set_fields
            if on_insert:
                upd["$setOnInsert"] = on_insert
            r = self.c(coll).update_one({"_id": _id}, upd, upsert=True)
            if r.upserted_id is not None:
                report["inserted"][coll] += 1
            elif r.modified_count:
                report["updated"][coll] += 1

        for n in skeleton_nodes():
            upsert("brain_nodes", n["_id"], on_insert={k: v for k, v in n.items() if k != "_id"})
        for cdoc in concept_docs(self.settings):
            upsert("concepts", cdoc["_id"], set_fields={k: v for k, v in cdoc.items() if k != "_id"})
        for s in self.settings:
            fields = {"target": s.target, "description": s.description, "status": s.status, "min": s.min,
                      "max": s.max, "v1": s.v1, "engine_default": s.engine_default, "note": s.note,
                      "integer": s.integer, "lever": s.lever_id if s.is_lever else None, "lever_group": s.group}
            upsert("envelope", s.target, set_fields=fields, on_insert={"approvals": [], "approved_value": s.v1})

        by_t = registry.by_target(self.settings)
        if v1_brain is None:
            v1_values = {s.target: s.v1 for s in self.settings if s.gets_v1_component}
        else:  # brains/v1.json (WP-B) verbatim, so export_brain(1) compiles to the same patch hash
            v1_values = {}
            for t, v in self._read_v1_brain(v1_brain).items():
                if t in by_t:
                    v1_values[t] = v
                else:
                    report["warnings"].append(f"v1 brain sets {t}, which the registry doesn't list; skipped")
            for s in self.settings:
                if s.gets_v1_component and s.target not in v1_values:
                    report["warnings"].append(f"v1 brain omits {s.target}: the engine default {s.engine_default:g} "
                                              f"applies instead of v1 {s.v1:g}")
        added = []
        for t, v in v1_values.items():
            s = by_t[t]
            doc = finalize_component(setting_component(t, v, s.status, {"source": "baseline"}, s), 1,
                                     {"origin": "baseline"})
            have = self.c("brain_nodes").find_one({"_id": doc["_id"]})
            if have is None:
                self.c("brain_nodes").insert_one(doc)
                report["inserted"]["brain_nodes"] += 1
            elif not same_value(have["compiles_to"]["value"], v):
                report["warnings"].append(
                    f"{doc['_id']} holds {have['compiles_to']['value']}, the registry says {v}; left unchanged "
                    "(v1 is history: re-seed a fresh database to change it)")
            added.append(doc["_id"])

        v1 = {"version": 1, "parent": None, "status": "committed", "added": added, "retired": [],
              "hypothesis": "Baseline: an integrator's cautious first-day setup (lifts only, 80% speed)",
              "promoted_by": None, "approvals": [], "scores": {}, "heldout_passed": None, "final": None,
              "created_at": now()}
        if self.c("brain_versions").find_one({"_id": "v1"}, {"_id": 1}) is None:
            v1["patch_hash"] = self._local_validation(self._build_brain(1)).patch_hash
        upsert("brain_versions", "v1", on_insert=v1)
        report["inserted"], report["updated"] = dict(report["inserted"]), dict(report["updated"])
        return report

    @staticmethod
    def _read_v1_brain(v1_brain) -> dict[str, float]:
        if isinstance(v1_brain, (str, Path)):
            v1_brain = json.loads(Path(v1_brain).read_text())
        brain = v1_brain if isinstance(v1_brain, Brain) else Brain.model_validate(v1_brain)
        return {t: e["value"] for t, e in effective_edits(brain).items()}

    def sync_settings(self, runner=None) -> dict:
        """Replace the static registry with the runner's GET /settings and refresh envelope bounds and
        lever leaves. Components are history and are not touched; differing v1 values are reported."""
        self._require_gate("sync_settings()")
        resp = (runner or self.runner).settings()
        if resp is None:
            return {"synced": False, "reason": "runner does not serve /settings"}
        old = registry.by_target(self.settings)
        self.settings = registry.from_settings_response(resp)
        diffs = []
        for s in self.settings:
            o = old.get(s.target)
            if o is None:
                diffs.append(f"new setting {s.target} ({s.status})")
            elif (o.v1, o.min, o.max, o.status) != (s.v1, s.min, s.max, s.status):
                diffs.append(f"{s.target}: v1 {o.v1}->{s.v1}, range [{o.min},{o.max}]->[{s.min},{s.max}], "
                             f"{o.status}->{s.status}")
        for t in old:
            if t not in registry.by_target(self.settings):
                diffs.append(f"{t} is not served by /settings")
        self.seed()
        return {"synced": True, "spec_id": resp.spec_id, "diffs": diffs}

    def latest_version(self) -> int:
        d = self.c("brain_versions").find_one({"status": {"$ne": "pending"}}, sort=[("version", -1)])
        if d is None:
            raise KGError("no brain versions: run seed() first")
        return int(d["version"])

    def _active_filter(self, V: int, exclude: Iterable[str] = ()) -> dict:
        q: dict = {"kind": {"$in": COMPONENT_KINDS}, "since": {"$lte": V},
                   "$or": [{"until": None}, {"until": {"$gt": V}}]}
        ex = list(exclude)
        if ex:
            q["_id"] = {"$nin": ex}
        return q

    def load_brain(self, V: int, node_id: str, exclude: Iterable[str] = ()) -> dict:
        """Team doc 03's two-stage pipeline: $graphLookup up the parent_id links, then $lookup every
        component on that path whose since/until range includes V. Same key: the deeper node wins.
        `exclude` drops components by id (ablation)."""
        match: dict = {"$expr": {"$in": ["$parent_id", "$$scope"]}, "kind": {"$in": COMPONENT_KINDS},
                       "since": {"$lte": V}, "$or": [{"until": None}, {"until": {"$gt": V}}]}
        ex = list(exclude)
        if ex:
            match["_id"] = {"$nin": ex}
        pipeline = [
            {"$match": {"_id": node_id}},
            {"$graphLookup": {"from": "brain_nodes", "startWith": "$parent_id", "connectFromField": "parent_id",
                              "connectToField": "_id", "as": "ancestors", "depthField": "depth"}},
            {"$project": {"scope": {"$concatArrays": [["$_id"], "$ancestors._id"]},
                          "ancestors._id": 1, "ancestors.depth": 1}},
            {"$lookup": {"from": "brain_nodes", "let": {"scope": "$scope"}, "pipeline": [{"$match": match}],
                         "as": "components"}},
        ]
        doc = next(self.c("brain_nodes").aggregate(pipeline), None)
        if doc is None:
            raise KeyError(f"no brain node {node_id!r}")
        dist = {node_id: 0, **{a["_id"]: int(a["depth"]) + 1 for a in doc.get("ancestors", [])}}
        comps = sorted(doc["components"], key=lambda c: (dist.get(c["parent_id"], 99), -c["since"], c["_id"]))
        winners: dict[str, dict] = {}
        shadowed = []
        for c in comps:
            k = c.get("key") or c["_id"]
            if k in winners:
                shadowed.append({**c, "shadowed_by": winners[k]["_id"]})
            else:
                winners[k] = {**c, "distance": dist.get(c["parent_id"])}
        env = self._envelope()
        out = []
        for k in sorted(winners):
            c = winners[k]
            e = env.get(k)
            if e:
                c["envelope"] = {f: e.get(f) for f in ("status", "min", "max", "v1")}
            out.append(c)
        scope = sorted(dist, key=lambda n: dist[n])
        return {"node_id": node_id, "version": V, "scope": scope, "components": out, "shadowed": shadowed}

    def export_brain(self, V: int, exclude: Iterable[str] = ()) -> Brain:
        """The contract Brain the runner receives: skeleton plus the components active at V
        (component _id → node_id, compiles_to → body), with approvals from the envelope."""
        if self.c("brain_versions").find_one({"version": V}, {"_id": 1}) is None:
            raise KeyError(f"no brain version {V}")
        return self._build_brain(V, exclude)

    def _build_brain(self, V: int, exclude: Iterable[str] = ()) -> Brain:
        skel = list(self.c("brain_nodes").find({"kind": {"$in": SKELETON_KINDS}}).sort("order", 1))
        depth = {"site": 0, "zone": 1, "task": 2}
        node_depth = {n["_id"]: depth.get(n["kind"], 0) for n in skel}
        comps = list(self.c("brain_nodes").find(self._active_filter(V, exclude)))
        comps.sort(key=lambda c: (node_depth.get(c["parent_id"], 0), c.get("key") or "", c["since"], c["_id"]))
        nodes = [BrainNode(node_id=n["_id"], parent_id=n.get("parent_id"), level=n["kind"], zone=n.get("zone"),
                           label=n.get("label")) for n in skel]
        for c in comps:
            body = c.get("compiles_to") or c.get("body") or (
                {"when": c.get("when"), "then": c["then"]} if c.get("then") else None)  # carried through untouched
            nodes.append(BrainNode(node_id=c["_id"], parent_id=c["parent_id"], level=c["kind"], zone=c.get("zone"),
                                   body=body, origin=c.get("origin"), key=c.get("key"), label=c.get("label"),
                                   since=c["since"]))
        brain = Brain(version=V, nodes=nodes)
        brain.approvals = self._approvals_for(brain)
        return brain

    def ablate(self, V: int, component_id: str) -> Brain:
        """Brain V without one learned component, its key reverted to the component it replaced
        (a plain `exclude` would let the engine default leak in instead)."""
        comp = self.c("brain_nodes").find_one({"_id": component_id})
        if comp is None:
            raise KeyError(f"no component {component_id!r}")
        if not (comp["since"] <= V and (comp.get("until") is None or comp["until"] > V)):
            raise KGError(f"{component_id} is not active at v{V}")
        prev = self.c("brain_nodes").find_one({"parent_id": comp["parent_id"], "key": comp.get("key"),
                                               "kind": {"$in": COMPONENT_KINDS}, "until": comp["since"]})
        brain = self.export_brain(V, exclude=[component_id])
        if prev is not None:
            brain.nodes.append(BrainNode(node_id=prev["_id"], parent_id=prev["parent_id"], level=prev["kind"],
                                         body=prev.get("compiles_to") or prev.get("body"), origin=prev.get("origin"),
                                         key=prev.get("key"), label=prev.get("label"), since=prev["since"]))
        brain.approvals = self._approvals_for(brain)
        return brain

    def _approvals_for(self, brain: Brain, envelope: Optional[dict] = None) -> list[BrainApproval]:
        env = envelope if envelope is not None else self._envelope()
        out = []
        for t, e in effective_edits(brain).items():
            d = env.get(t)
            if not d or d["status"] != "locked" or same_value(e["value"], d["v1"]):
                continue
            for a in reversed(d.get("approvals") or []):
                if a.get("decision", "approve") == "approve" and same_value(a["value"], e["value"]):
                    out.append(BrainApproval(target=t, value=e["value"], approved_by=a["approved_by"], ref=a.get("ref")))
                    break
        return out

    # ── validation and patch hashes ──────────────────────────

    def validate(self, brain: Brain) -> Validation:
        """The runner's /validate_brain when it has one, otherwise the local mirror of the compiler."""
        key = digest(brain.model_dump(mode="json", exclude_none=True))
        if key in self._validation_cache:
            return self._validation_cache[key]
        v = None
        if self.runner is not None:
            r = self.runner.validate_brain(brain)
            if r is not None:
                v = Validation(patch_hash=r.patch_hash,
                               effective={e.target: {"value": norm_number(e.value), "node_id": e.node_id}
                                          for e in r.effective},
                               locked_edits=[x.model_dump(mode="json") for x in r.locked_edits],
                               rejected=[x.model_dump(mode="json") for x in r.rejected],
                               warnings=list(r.warnings), source="runner")
        if v is None:
            v = self._local_validation(brain)
        self._validation_cache[key] = v
        return v

    def _local_validation(self, brain: Brain) -> Validation:
        eff = effective_edits(brain)
        patch, unknown = compile_patch(eff)
        env = self._envelope()
        approved = [(a.target, a.value) for a in brain.approvals]
        rejected, locked, warnings = list(unknown), [], []
        unknown_t = {u["target"] for u in unknown}
        for t, e in eff.items():
            if t in unknown_t:
                continue
            v, d = e["value"], env.get(t)
            if d is None:
                rejected.append({"target": t, "value": v, "node_id": e["node_id"], "reason": "unknown setting"})
            elif d["status"] == "spec":
                rejected.append({"target": t, "value": v, "node_id": e["node_id"],
                                 "reason": "spec setting: describes the building or the robot, never set by the brain"})
            elif d["status"] == "fixed" and not same_value(v, d["v1"]):
                rejected.append({"target": t, "value": v, "node_id": e["node_id"],
                                 "reason": f"fixed setting ({d['v1']:g}): never editable or approvable"})
            elif not (d["min"] - 1e-9 <= v <= d["max"] + 1e-9):
                rejected.append({"target": t, "value": v, "node_id": e["node_id"],
                                 "reason": f"out of range [{d['min']}, {d['max']}]"})
            elif d.get("integer") and not float(v).is_integer():
                rejected.append({"target": t, "value": v, "node_id": e["node_id"], "reason": "must be a whole number"})
            elif d["status"] == "locked" and not same_value(v, d["v1"]) and \
                    not any(at == t and same_value(av, v) for at, av in approved):
                locked.append({"target": t, "value": v, "baseline": d["v1"], "node_id": e["node_id"],
                               "reason": "locked: needs the Robotics Lead's approval"})
        val = lambda t: eff[t]["value"] if t in eff else (env.get(t) or {}).get("engine_default")
        if "sim.PERC_SLOW" in env and "sim.PERC_STOP" in env and val("sim.PERC_SLOW") < val("sim.PERC_STOP"):
            t = "sim.PERC_SLOW" if "sim.PERC_SLOW" in eff else "sim.PERC_STOP"
            if t in eff:
                rejected.append({"target": t, "value": eff[t]["value"], "node_id": eff[t]["node_id"],
                                 "reason": "PERC_SLOW must be at least PERC_STOP"})
        for t, d in env.items():
            if t in eff or d["status"] not in ("editable", "locked") or same_value(d["engine_default"], d["v1"]):
                continue
            if d["status"] == "locked":
                locked.append({"target": t, "value": d["engine_default"], "baseline": d["v1"], "node_id": None,
                               "reason": "omitted: the engine default applies"})
            else:
                warnings.append(f"{t} omitted: engine default {d['engine_default']:g} applies instead of v1 {d['v1']:g}")
        return Validation(local_patch_hash(patch), eff, locked, rejected, warnings, "local")

    # ── Phase 1: proposals, shifts, verdicts, promotion ──────

    def _apply_edits(self, base: Brain, edits: dict[str, float], origin: dict) -> Brain:
        """The candidate: base export with every component that sets an edited target (at any node) replaced
        by one site-level component. The compiled patch is flat, so a deeper rule for the same setting would
        otherwise shadow the candidate and turn it into a no-op."""
        env = self._envelope()

        def cand_node(t, v):
            locked = env.get(t, {}).get("status") == "locked"
            return BrainNode(node_id=f"cand:{t}@{SITE_ID}", parent_id=SITE_ID, level="guardrail" if locked else "rule",
                             body={"op": "set", "target": t, "value": v}, origin=origin, key=t,
                             label=registry.label_for(t, v))

        nodes, placed = [], set()
        for n in base.nodes:
            e = edit_of(n)
            if e is not None and e.target in edits:
                if e.target not in placed:
                    nodes.append(cand_node(e.target, edits[e.target]))
                    placed.add(e.target)
                continue
            nodes.append(n)
        nodes += [cand_node(t, v) for t, v in edits.items() if t not in placed]
        brain = Brain(version=base.version, nodes=nodes)
        brain.approvals = self._approvals_for(brain, env)
        return brain

    def _shifts_present(self, env_key: str, patch_hash: str, seeds: list[int]) -> bool:
        ids = [shift_id(env_key, patch_hash, s) for s in seeds]
        return self.c("shifts").count_documents({"_id": {"$in": ids}}) == len(ids)

    def record_proposal(self, base_V: int, candidate: Any, origin: Union[None, str, dict] = None, round: int = 0,
                        policy: str = "p0", split: str = "train", seeds: Optional[Iterable[int]] = None,
                        hypothesis: Optional[str] = None, attempt: Optional[int] = None) -> Proposal:
        """Diff the candidate against brain base_V into `edits` and record a gate run before anything runs.
        Refuses only rejected edits (unknown, out of range, spec-only) and no-ops; locked edits go through
        and come back in `locked_edits`. Status: new (run it), cached (already measured), invalid."""
        if split not in ("train", "val"):
            raise KGError("held-out data never enters the KG: split must be 'train' or 'val'")
        seeds = sorted_seeds(seeds if seeds is not None else self.seed_sets[split])
        env = self.env
        origin = {"source": origin} if isinstance(origin, str) else dict(origin or {"source": "unknown"})
        origin.setdefault("ref", None)
        base = self.export_brain(base_V)
        base_v = self.validate(base)
        reason, edits, cand_brain, cand_v = None, [], None, None
        try:
            wanted = parse_candidate(candidate)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
            wanted = None
            reason = f"unparseable candidate: {e}"
        if wanted is not None:
            cand_brain = self._apply_edits(base, wanted, origin)
            cand_v = self.validate(cand_brain)
            env_docs = self._envelope()
            for t in sorted(set(cand_v.effective) | set(base_v.effective)):
                cv = cand_v.effective.get(t, {}).get("value")
                bv = base_v.effective.get(t, {}).get("value")
                if bv is None:  # absent from the base brain: the engine default runs
                    bv = (env_docs.get(t) or {}).get("engine_default")
                if cv is not None and not same_value(cv, bv):
                    edits.append({"target": t, "value": cv, "base_value": bv, "scope": "fleet",
                                  "lever_group": (env_docs.get(t) or {}).get("lever_group")})
            if cand_v.rejected:
                reason = "; ".join(f"{r['target']}={r['value']}: {r['reason']}" for r in cand_v.rejected)
            elif not edits:
                reason = f"no-op: the candidate changes no setting of v{base_V}"
        cand_hash = cand_v.patch_hash if cand_v else "bad-" + digest(str(candidate), 16)
        gid = make_gate_run_id(env.key, seeds, base_v.patch_hash, cand_hash)
        eid = make_event_id(gid, round, policy, attempt)
        invalid = reason is not None
        doc = {
            "_id": gid, "base": f"v{base_V}", "base_version": base_V, "base_patch_hash": base_v.patch_hash,
            "cand_patch_hash": cand_hash, "edits": edits, "origin": origin, "split": split,
            "env": {**env.model_dump(), "seeds": seeds}, "env_key": env.key, "hash_source": base_v.source,
            "locked_edits": cand_v.locked_edits if cand_v else [], "warnings": cand_v.warnings if cand_v else [],
            "shift_ids": None, "zones": None, "time_split": None, "failures": None,
            "verdict": "invalid" if invalid else None, "reason": reason, "promoted_to": None,
            "hypothesis": hypothesis, "created_at": now(), "events": [],
        }
        self.c("gate_runs").update_one({"_id": gid}, {"$setOnInsert": doc}, upsert=True)
        ev = {"event_id": eid, "round": int(round), "policy": str(policy), "attempt": attempt, "origin": origin,
              "at": now(), "signals_sent": []}
        self.c("gate_runs").update_one({"_id": gid, "events.event_id": {"$ne": eid}}, {"$push": {"events": ev}})
        run = self.c("gate_runs").find_one({"_id": gid})
        first = next(e["event_id"] for e in run["events"] if e["policy"] == str(policy))
        need_base = need_cand = False
        if run["verdict"] == "invalid":
            status = "invalid"
        elif run.get("zones") is not None:
            status = "cached"
        else:
            need_base = not self._shifts_present(env.key, run["base_patch_hash"], seeds)
            need_cand = not self._shifts_present(env.key, run["cand_patch_hash"], seeds)
            status = "new"
            if not need_base and not need_cand and self._fill_numbers(gid):
                status = "cached"
                run = self.c("gate_runs").find_one({"_id": gid})
        self._sync_raindrop(gid)
        return Proposal(
            gate_run_id=gid, event_id=eid, status=status, edits=run["edits"], reason=run.get("reason"),
            brain=cand_brain if status != "invalid" else None, base_brain=base, base_version=base_V, seeds=seeds,
            split=split, need_base=need_base, need_cand=need_cand, locked_edits=run.get("locked_edits", []),
            warnings=run.get("warnings", []), repeat=first != eid,
            cached_result=self._result_view(run) if status == "cached" else None)

    @staticmethod
    def _result_view(run: dict) -> dict:
        return {k: run.get(k) for k in ("zones", "failures", "time_split", "outcomes", "fleet", "verdict", "reason",
                                        "edits", "split", "context")} | {"gate_run_id": run["_id"]}

    def record_shifts(self, response: Union[RunShiftResponse, dict], split: str, *, gate_run_id: Optional[str] = None,
                      side: str = "cand", brain: Optional[Brain] = None) -> dict:
        """Write `shifts` (raw SeedResult per seed) and `episodes` (one per FailureEntry), then fill the
        numbers of every gate run whose base and candidate shifts are now all present.
        Training and validation only. Pass gate_run_id + side (or the brain) so a fake runner's
        response can be tied to its patch hash."""
        if split not in ("train", "val"):
            raise KGError("held-out results never enter the KG: split must be 'train' or 'val'")
        resp = response if isinstance(response, RunShiftResponse) else RunShiftResponse.model_validate(response)
        run = self.c("gate_runs").find_one({"_id": gate_run_id}) if gate_run_id else None
        if gate_run_id and run is None:
            raise KeyError(f"no gate run {gate_run_id}")
        env = Env(**{k: run["env"][k] for k in Env.model_fields}) if run else self.env
        got = (resp.engine_sha, resp.spec_id, resp.ticks, resp.scenario_profile)
        want = (env.engine_sha, env.spec_id, env.ticks, env.profile)
        if got != want:
            raise EnvMismatch(f"response env {got} does not match {want}; refusing to mix results")
        spec_hash = resp.spec_hash
        if spec_hash and env.spec_hash_or_epoch.startswith("spec:") and env.spec_hash_or_epoch != f"spec:{spec_hash}":
            raise EnvMismatch(f"spec_hash {spec_hash} does not match the env's {env.spec_hash_or_epoch}")
        if run is not None:
            if side not in ("base", "cand"):
                raise ValueError("side must be 'base' or 'cand'")
            patch_hash = run[f"{side}_patch_hash"]
            if run.get("hash_source") == "runner" and resp.patch_hash != patch_hash:
                raise KGError(f"runner patch_hash {resp.patch_hash} != recorded {side} hash {patch_hash}: "
                              "the evaluator ran a different brain than the one proposed")
        elif brain is not None:
            patch_hash = self.validate(brain).patch_hash
        elif resp.engine_sha != "fake":
            patch_hash = resp.patch_hash
        else:
            raise KGError("fake runner responses carry no usable patch_hash: pass gate_run_id or brain")
        self._refuse_heldout_seeds([r.seed for r in resp.per_seed])

        ids, nondeterministic = [], []
        ep_ops = []
        for r in resp.per_seed:
            sid = shift_id(env.key, patch_hash, r.seed)
            result = r.model_dump(mode="json")
            doc = {"_id": sid, "env_key": env.key, "env": env.model_dump(), "patch_hash": patch_hash, "seed": r.seed,
                   "split": split, "brain_version": resp.brain_version, "result": result,
                   "warnings": resp.warnings, "recorded_at": now()}
            res = self.c("shifts").update_one({"_id": sid}, {"$setOnInsert": doc}, upsert=True)
            if res.upserted_id is None:
                have = self.c("shifts").find_one({"_id": sid}, {"result": 1})
                if digest(have["result"]) != digest(result):
                    nondeterministic.append(r.seed)
                    log.warning("shift %s (seed %s) differs from the stored result: the twin is not deterministic",
                                sid, r.seed)
            ids.append(sid)
            fails = result.get("failures") or []
            capped = metrics.capped_types(result)
            for f, eid in zip(fails, episode_ids(sid, fails)):
                ep = {"_id": eid, "shift_id": sid, "env_key": env.key, "patch_hash": patch_hash, "seed": r.seed,
                      "split": split, "type": f["type"], "zone": f.get("zone"), "tick": f["tick"],
                      "robots": f.get("robots", []), "detail": f.get("detail", ""), "task_id": f.get("task_id"),
                      "capped": f["type"] in capped}
                ep_ops.append(UpdateOne({"_id": eid}, {"$setOnInsert": ep}, upsert=True))
        if ep_ops:
            self.c("episodes").bulk_write(ep_ops, ordered=False)

        if gate_run_id:
            targets = [gate_run_id]
        else:
            targets = [d["_id"] for d in self.c("gate_runs").find(
                {"env_key": env.key, "zones": None, "verdict": {"$ne": "invalid"},
                 "$or": [{"base_patch_hash": patch_hash}, {"cand_patch_hash": patch_hash}]}, {"_id": 1})]
        filled = [g for g in targets if self._fill_numbers(g)]
        for g in targets:
            self._sync_raindrop(g)
        out = {"patch_hash": patch_hash, "shift_ids": ids, "filled": filled, "nondeterministic": nondeterministic}
        if gate_run_id:
            out["result"] = self._result_view(self.c("gate_runs").find_one({"_id": gate_run_id}))
        return out

    def _refuse_heldout_seeds(self, seeds: list[int]):
        """Defence in depth on the gate side: never store a shift for a locked test seed."""
        if self.role != "gate":
            return
        try:
            locked = {int(s) for d in self.c("heldout_seeds").find({}, {"seeds": 1, "seed": 1})
                      for s in (d.get("seeds") or ([d["seed"]] if "seed" in d else []))}
        except OperationFailure:
            return
        hit = sorted(set(seeds) & locked)
        if hit:
            raise KGError(f"seeds {hit} are held-out test seeds: their results never enter the KG")

    def _fill_numbers(self, gid: str) -> bool:
        run = self.c("gate_runs").find_one({"_id": gid})
        if run is None or run["verdict"] == "invalid":
            return False
        if run.get("zones") is not None:
            return True
        seeds, key = run["env"]["seeds"], run["env_key"]
        b_ids = [shift_id(key, run["base_patch_hash"], s) for s in seeds]
        c_ids = [shift_id(key, run["cand_patch_hash"], s) for s in seeds]
        docs = {d["_id"]: d["result"] for d in self.c("shifts").find({"_id": {"$in": b_ids + c_ids}}, {"result": 1})}
        if any(i not in docs for i in b_ids + c_ids):
            return False
        base, cand = [docs[i] for i in b_ids], [docs[i] for i in c_ids]
        nums = metrics.compare(base, cand)
        upd = {**nums, "shift_ids": {"base": b_ids, "cand": c_ids}, "context": self._context_of(base),
               "evaluated_at": now()}
        self.c("gate_runs").update_one({"_id": gid, "zones": None}, {"$set": upd})
        self.c("gate_runs").update_one({"_id": gid, "verdict": None}, {"$set": {"verdict": "evaluated"}})
        return True

    @staticmethod
    def _context_of(results: list[dict]) -> dict:
        """What the base brain looked like when this candidate was tried (the ranking keys of section C)."""
        s = metrics.summarize(results)
        worst = s["worst_zone"]
        ts = s["worst_time_split"]
        states = order_time_states(ts)
        oc = s["zones"].get(worst, {}) if worst else {}
        groups = Counter()
        for t, n in s["failures"].items():
            g = failure_group_of(t)
            if g and n:
                groups[g] += n
        return {"worst_zone": worst, "worst_score": oc.get("score"), "time_state": states[0] if states else None,
                "late_dropped": int(oc.get("late", 0)) + int(oc.get("dropped", 0)) if oc else 0,
                "failure_group": groups.most_common(1)[0][0] if groups else None}

    def evaluate(self, proposal: Proposal, runner=None) -> dict:
        """Convenience for the evaluator: run whatever the proposal still needs, record it, return the numbers."""
        runner = runner or self.runner
        if proposal.status == "invalid":
            return {"gate_run_id": proposal.gate_run_id, "verdict": "invalid", "reason": proposal.reason}
        if proposal.status == "cached":
            return proposal.cached_result
        from .runner import BrainRejected
        kw = {"ticks": self.env.ticks, "profile": self.env.profile}
        if proposal.need_base:
            resp = runner.run_shift(proposal.base_brain, proposal.seeds, **kw)
            self.record_shifts(resp, proposal.split, gate_run_id=proposal.gate_run_id, side="base")
        if proposal.need_cand:
            try:
                resp = runner.run_shift(proposal.brain, proposal.seeds, allow_locked=proposal.allow_locked, **kw)
            except BrainRejected as e:
                self.c("gate_runs").update_one({"_id": proposal.gate_run_id}, {"$set": {
                    "verdict": "invalid", "reason": f"runner refused: {e.rejection.message}"}})
                self._sync_raindrop(proposal.gate_run_id)
                return {"gate_run_id": proposal.gate_run_id, "verdict": "invalid", "reason": str(e)}
            self.record_shifts(resp, proposal.split, gate_run_id=proposal.gate_run_id, side="cand")
        if not proposal.need_base and not proposal.need_cand:
            self._fill_numbers(proposal.gate_run_id)
        return self._result_view(self.c("gate_runs").find_one({"_id": proposal.gate_run_id}))

    def record_verdict(self, gate_run_id: str, verdict: str, reason: Optional[str] = None) -> dict:
        """The gate's decision: passed (not promoted yet), rejected, or needs_approval (a locked edit
        that passed on numbers). Sends the gate signal once, and updates habit counters (Phase 2)."""
        self._require_gate("record_verdict()")
        if verdict not in ("passed", "rejected", "needs_approval"):
            raise ValueError("verdict must be passed, rejected or needs_approval (promotion goes through promote())")
        run = self.c("gate_runs").find_one({"_id": gate_run_id})
        if run is None:
            raise KeyError(f"no gate run {gate_run_id}")
        if run["verdict"] == "invalid":
            raise KGError("an invalid proposal has no verdict to record")
        if run["verdict"] == "promoted":
            raise KGError(f"already promoted to v{run['promoted_to']}")
        if run.get("zones") is None:
            raise KGError("not evaluated yet: record_shifts first")
        self.c("gate_runs").update_one({"_id": gate_run_id}, {"$set": {"verdict": verdict, "reason": reason,
                                                                      "decided_at": now()}})
        self.c("gate_runs").update_one({"_id": gate_run_id, "gate_decision": None},
                                       {"$set": {"gate_decision": "failed" if verdict == "rejected" else "passed"}})
        self._count_playbook(gate_run_id)
        self._sync_raindrop(gate_run_id)
        self.phone.after_verdict(self, gate_run_id)  # needs_approval: the Lead decides on the call
        return self._result_view(self.c("gate_runs").find_one({"_id": gate_run_id}))

    def _count_playbook(self, gid: str):
        """ACE-style counters: a habit's edit that passes the gate is helpful, one that fails is harmful.
        Counted once per gate run, at the gate's first decision."""
        run = self.c("gate_runs").find_one({"_id": gid}, {"origin": 1, "gate_decision": 1, "playbook_counted": 1})
        ref = (run.get("origin") or {}).get("ref")
        if not ref or not str(ref).startswith("habit:") or not run.get("gate_decision") or run.get("playbook_counted"):
            return
        claim = self.c("gate_runs").update_one({"_id": gid, "playbook_counted": {"$ne": True}},
                                               {"$set": {"playbook_counted": True}})
        if claim.modified_count:
            field_ = "helpful" if run["gate_decision"] == "passed" else "harmful"
            self.c("playbook").update_one({"_id": ref}, {"$inc": {field_: 1}})

    def promote(self, gate_run_id: str, hypothesis: Optional[str] = None) -> dict:
        """New version N+1 from a gate run: one component per edit at site:main (since N+1), the component it
        replaces retired (until N+1), evidence attached. A thin layer over commit_brain_version."""
        self._require_gate("promote()")
        run = self.c("gate_runs").find_one({"_id": gate_run_id})
        if run is None:
            raise KeyError(f"no gate run {gate_run_id}")
        if run["verdict"] == "promoted":
            v = self.c("brain_versions").find_one({"version": run["promoted_to"]})
            return {"version": v["version"], "added": v["added"], "retired": v["retired"], "already": True}
        self._check_promotable(run, self.latest_version())
        env, by_t = self._envelope(), registry.by_target(self.settings)
        add = [setting_component(e["target"], e["value"], env.get(e["target"], {}).get("status", "editable"),
                                 run.get("origin") or {"source": "unknown"}, by_t.get(e["target"]))
               for e in run["edits"]]
        return self.commit_brain_version(add, [], self._evidence_for(run),
                                         hypothesis=hypothesis or run.get("hypothesis"), _run=run)

    def _check_promotable(self, run: dict, latest: int):
        if run["verdict"] == "promoted":
            raise KGError(f"gate run {run['_id']} is already promoted to v{run['promoted_to']}")
        if run["verdict"] in ("invalid", "rejected"):
            raise KGError(f"gate run is {run['verdict']}: {run.get('reason')}")
        if run.get("zones") is None:
            raise KGError("not evaluated yet")
        if run["verdict"] not in ("passed", "needs_approval"):
            raise KGError(f"gate run {run['_id']} is {run['verdict']!r}: the gate has not decided yet, "
                          "record_verdict(passed | needs_approval) first")
        if self._env is not None and run.get("env_key") != self._env.key:
            raise EnvMismatch(f"gate run {run['_id']} was measured in env {run.get('env_key')}, but the runner now "
                              f"reports {self._env.key} (engine or spec changed): re-evaluate it before promoting")
        if run["base_version"] != latest and run["base_patch_hash"] != self._patch_hash_like(run, latest):
            raise StalePromotion(f"evaluated against v{run['base_version']}, but the latest brain is v{latest} and "
                                 "runs differently: re-evaluate the candidate on the latest brain")

    def _patch_hash_like(self, run: dict, V: int) -> str:
        """Brain V's patch hash from the same source the run used, so a newer version that only added
        non-compiling components (a saved preference, a note) doesn't make pending runs stale."""
        brain = self._build_brain(V)
        if run.get("hash_source") == "runner" and self.runner is not None:
            return self.validate(brain).patch_hash
        return self._local_validation(brain).patch_hash

    #: a pending brain_versions row older than this is an abandoned commit, not one in flight
    ABANDONED_COMMIT_S = 300

    def _recover_abandoned(self, N: int) -> bool:
        """The pending brain_versions row is the commit lock. A gate process that dies between taking it and
        committing leaves the lock, and maybe half its components, so every later commit would fail with
        "being created by another commit". Once the row is old enough, roll it back: drop the components it
        inserted (since == N) and un-retire the ones it retired (until == N)."""
        cutoff = now() - dt.timedelta(seconds=self.ABANDONED_COMMIT_S)
        stale = self.c("brain_versions").find_one_and_delete(
            {"_id": f"v{N}", "status": "pending", "created_at": {"$lt": cutoff}})
        if stale is None:
            return False
        dropped = self.c("brain_nodes").delete_many({"kind": {"$in": COMPONENT_KINDS}, "since": N}).deleted_count
        revived = self.c("brain_nodes").update_many({"kind": {"$in": COMPONENT_KINDS}, "until": N},
                                                    {"$set": {"until": None}}).modified_count
        log.warning("rolled back abandoned commit v%s from %s: %d components dropped, %d un-retired",
                    N, stale.get("created_at"), dropped, revived)
        return True

    def commit_brain_version(self, add: list[dict], retire: Iterable[str] = (), evidence: Optional[dict] = None, *,
                             hypothesis: Optional[str] = None, force: bool = False, _run: Optional[dict] = None) -> dict:
        """The interface contract's one write path into the brain (SCRATCHPADS/interface-contracts.md):
        insert-many the new components with since = N+1, update-many the retired ones to until = N+1,
        insert one brain_versions document. Never an aggregate with $merge or $out.

        `add` items are {kind, parent_id, key, ...fields}; one that compiles to a setting uses the target as
        its key. A component that changes a setting needs `evidence.gate_run_id` naming a run that is
        evaluated, not rejected, on the latest brain, with the same edit (force=True is a human override).
        Locked settings need an approval in the envelope. An active component with the same key at the
        same node is retired even when `retire` omits it (one component per key per node)."""
        self._require_gate("commit_brain_version()")
        evidence = dict(evidence or {})
        latest = self.latest_version()
        N = latest + 1
        run = _run
        if run is None and evidence.get("gate_run_id"):
            run = self.c("gate_runs").find_one({"_id": evidence["gate_run_id"]})
            if run is None:
                raise KeyError(f"no gate run {evidence['gate_run_id']}")
        if run is not None:
            self._check_promotable(run, latest)
            evidence.setdefault("gate_run_id", run["_id"])
        if not add and not retire:
            raise ValueError("nothing to commit: add or retire at least one component")

        parents = {d["_id"]: d.get("parent_id") for d in
                   self.c("brain_nodes").find({"kind": {"$in": SKELETON_KINDS}}, {"_id": 1, "parent_id": 1})}
        nodes = set(parents)
        env, by_t = self._envelope(), registry.by_target(self.settings)
        current = {t: e["value"] for t, e in effective_edits(self._build_brain(latest)).items()}
        docs, approvals, changes = [], [], {}
        for item in add:
            item = dict(item)
            item.setdefault("parent_id", SITE_ID)
            ct = item.get("compiles_to")
            if ct:
                item.setdefault("key", ct["target"])
                if item["key"] != ct["target"]:
                    raise ValueError(f"a component that compiles to {ct['target']} must use it as its key")
                when, then = registry.rule_text(ct["target"], ct["value"])
                item.setdefault("when", when)
                item.setdefault("then", then)
                item.setdefault("label", registry.label_for(ct["target"], ct["value"]))
                s = by_t.get(ct["target"])
                item.setdefault("lever", s.lever_id if s is not None and s.is_lever else None)
            if item.get("kind") not in COMPONENT_KINDS:
                raise ValueError(f"kind must be one of {COMPONENT_KINDS}, got {item.get('kind')!r}")
            if item["parent_id"] not in nodes:
                raise ValueError(f"no skeleton node {item['parent_id']!r}")
            if not item.get("key"):
                raise ValueError("every component needs a key")
            doc = finalize_component(item, N, evidence)
            if ct:
                t, v = ct["target"], norm_number(ct["value"])
                d = env.get(t)
                if d is None or d["status"] in ("spec", "fixed"):
                    raise KGError(f"{t} is not a setting the brain may set")
                if not (d["min"] - 1e-9 <= v <= d["max"] + 1e-9):
                    raise KGError(f"{t}={v} is outside [{d['min']}, {d['max']}]")
                if d["status"] == "locked" and not same_value(v, d["v1"]):
                    a = next((a for a in reversed(d.get("approvals") or []) if a.get("decision") == "approve"
                              and same_value(a["value"], v)), None)
                    if a is None:
                        raise NeedsApproval(f"locked edit {t}={v} needs the Robotics Lead's approval first")
                    approvals.append({"target": t, "value": v, "approved_by": a["approved_by"], "ref": a.get("ref")})
                if not same_value(current.get(t), v):
                    changes[t] = v
            docs.append(doc)
        if changes and run is None and not force:
            raise KGError(f"{', '.join(changes)}: a setting change needs evidence.gate_run_id (or force=True for "
                          "a human override)")
        if run is not None:
            tested = {e["target"]: e["value"] for e in run["edits"]}
            for t, v in changes.items():
                if t not in tested or not same_value(tested[t], v):
                    raise KGError(f"{t}={v} is not the edit gate run {run['_id']} measured")

        active = {c["_id"]: c for c in self.c("brain_nodes").find(self._active_filter(latest),
                                                                  {"parent_id": 1, "key": 1, "compiles_to": 1})}
        retire = list(dict.fromkeys(retire))
        for r in retire:
            if r not in active:
                raise KGError(f"{r} is not active in v{latest}")

        def under(node: Optional[str], ancestor: str) -> bool:
            while node is not None:
                if node == ancestor:
                    return True
                node = parents.get(node)
            return False

        for d in docs:
            for cid, c in active.items():
                if c.get("key") != d["key"] or cid in retire:
                    continue
                # one component per key per node; and a compiled setting is flat for the engine, so a deeper
                # component for the same setting would shadow the new one: retire it too
                if c["parent_id"] == d["parent_id"] or (d.get("compiles_to") and c.get("compiles_to")
                                                        and under(c["parent_id"], d["parent_id"])):
                    retire.append(cid)
        compiled = [d for d in docs if d.get("compiles_to")]
        if compiled:
            preview = self._build_brain(latest, exclude=retire)
            preview.nodes += [BrainNode(node_id=d["_id"], parent_id=d["parent_id"], level=d["kind"],
                                        body=d["compiles_to"], key=d["key"]) for d in compiled]
            eff = effective_edits(preview)
            for d in compiled:
                t, v = d["compiles_to"]["target"], d["compiles_to"]["value"]
                won = eff.get(t)
                if won is None or won["node_id"] != d["_id"]:
                    raise KGError(f"{d['_id']} would not take effect: {t} is set by {won['node_id'] if won else '?'} "
                                  f"at a node that is not above {d['parent_id']}; retire it or add there instead")
        self._recover_abandoned(N)
        try:
            self.c("brain_versions").insert_one({
                "_id": f"v{N}", "version": N, "parent": f"v{latest}", "status": "pending", "added": [],
                "retired": [], "hypothesis": hypothesis, "promoted_by": run["_id"] if run else None,
                "approvals": approvals, "scores": {}, "heldout_passed": None, "final": None, "created_at": now()})
        except DuplicateKeyError:
            raise KGError(f"v{N} is being created by another commit; retry after it lands")
        if docs:
            self.c("brain_nodes").insert_many(docs)
        if retire:
            self.c("brain_nodes").update_many({"_id": {"$in": retire}, "until": None}, {"$set": {"until": N}})
        fields = {"status": "committed", "added": [d["_id"] for d in docs], "retired": retire,
                  "patch_hash": self._local_validation(self._build_brain(N)).patch_hash, "committed_at": now()}
        if run is not None:
            fields["scores"] = self._scores_for(run)
            rows = list(self.c("heldout_results").find({"gate_run_id": run["_id"]}, {"passed": 1}))
            fields["heldout_passed"] = all(r["passed"] for r in rows) if rows else None
        self.c("brain_versions").update_one({"_id": f"v{N}"}, {"$set": fields})
        if run is not None:
            self.c("gate_runs").update_one({"_id": run["_id"]}, {"$set": {"verdict": "promoted", "promoted_to": N}})
            self.c("gate_runs").update_one({"_id": run["_id"], "gate_decision": None},
                                           {"$set": {"gate_decision": "passed"}})
            self._count_playbook(run["_id"])
            self._sync_raindrop(run["_id"])
            self.phone.after_promote(self, run["_id"], N)  # the harness changed: the Lead hears what and why
        return {"version": N, "added": fields["added"], "retired": retire, "approvals": approvals}

    def get_brain_context(self, task_node_id: str, version: Optional[int] = None,
                          reader: Optional[str] = None) -> dict:
        """The interface contract's read: every component that applies to a node at `version` (default: the
        latest), as {kind, key, when, then, since, until, evidence} plus the KG's own fields. Also logs the
        read to `brain_reads`, which the dashboard can watch to light up the nodes an agent just read."""
        V = version if version is not None else self.latest_version()
        lb = self.load_brain(V, task_node_id)
        comps = []
        for c in lb["components"]:
            when, then = c.get("when"), c.get("then")
            ct = c.get("compiles_to")
            if ct and (when is None or then is None):
                when, then = registry.rule_text(ct["target"], ct["value"])
            comps.append({"kind": c["kind"], "key": c.get("key"), "when": when, "then": then, "since": c["since"],
                          "until": c.get("until"), "evidence": c.get("evidence") or {}, "_id": c["_id"],
                          "parent_id": c["parent_id"], "label": c.get("label"), "compiles_to": ct})
        try:
            self.c("brain_reads").insert_one({"node_id": task_node_id, "version": V, "scope": lb["scope"],
                                              "component_ids": [c["_id"] for c in comps], "reader": reader,
                                              "at": now()})
        except OperationFailure:
            pass  # a read-only user still gets the context; only the dashboard pulse is lost
        return {"version": V, "node_id": task_node_id, "scope": lb["scope"], "components": comps}

    def save_preference(self, text: str, by: str, ref: Optional[str] = None, node_id: str = SITE_ID) -> dict:
        """A Robotics Lead's instruction from the call becomes a brain component at once (iteration 03):
        a non-compiling rule the supervisor and workers read through get_brain_context. It changes no
        setting, so it needs no gate run and leaves pending gate runs promotable."""
        slug = "".join(ch if ch.isalnum() else "-" for ch in text.lower()).strip("-")
        slug = "-".join(w for w in slug.split("-") if w)[:48] or "preference"
        item = {"kind": "rule", "parent_id": node_id, "key": f"preference:{slug}", "label": text, "when": "always",
                "then": text, "origin": {"source": "robotics_lead", "ref": ref}}
        return self.commit_brain_version([item], [], {"origin": "robotics_lead", "said_by": by, "ref": ref},
                                         hypothesis=f"Robotics Lead preference: {text}")

    def current_scores(self, version: Optional[int] = None, split: str = "train") -> dict:
        """Per-zone scores of a brain (default: the latest) on training seeds, for the call agent's
        get_current_scores webhook and the dashboard. Training/validation only, never held-out."""
        V = version if version is not None else self.latest_version()
        from .views import brain_summary
        A = brain_summary(self, V, split)
        if A:
            return {"version": V, "split": split, "zones": {z: m["score"] for z, m in A["zones"].items()},
                    "worst_zone": A["worst_zone"], "source": "shifts"}
        v = self.c("brain_versions").find_one({"version": V}, {"scores": 1}) or {}
        zones = (v.get("scores") or {}).get(split) or {}
        return {"version": V, "split": split, "zones": zones,
                "worst_zone": min(zones, key=zones.get) if zones else None, "source": "brain_versions"}

    def get_playbook(self, task_node: str) -> list[dict]:
        """Human habits that apply to a node: those scoped to it or an ancestor (`applies_to`), plus unscoped
        ones, best evidence first (helpful minus harmful)."""
        scope = self.load_brain(self.latest_version(), task_node)["scope"]
        q = {"$or": [{"applies_to": {"$in": scope}}, {"applies_to": {"$in": [None, []]}},
                     {"applies_to": {"$exists": False}}]}
        habits = list(self.c("playbook").find(q))
        habits.sort(key=lambda h: (-(h.get("helpful", 0) - h.get("harmful", 0)), h["_id"]))
        return habits

    def _scores_for(self, run: dict) -> dict:
        scores = {run["split"]: {z: v["cand"] for z, v in run["zones"].items()}}
        for s in self.c("gate_runs").find({"env_key": run["env_key"], "base_patch_hash": run["base_patch_hash"],
                                           "cand_patch_hash": run["cand_patch_hash"], "_id": {"$ne": run["_id"]},
                                           "zones": {"$ne": None}}, {"split": 1, "zones": 1}):
            scores.setdefault(s["split"], {z: v["cand"] for z, v in s["zones"].items()})
        return scores

    def _evidence_for(self, run: dict) -> dict:
        """Team doc 03's evidence: the habit, the base brain's failures of the type the edit reduced most,
        that failure type as the signal, the gate run, and where the problem was seen."""
        reduced = [(v["base"] - v["cand"], t) for t, v in (run.get("failures") or {}).items() if v["base"] > v["cand"]]
        # late and dropped tasks are the symptom of nearly every fix; name the cause when one also fell
        reduced.sort(key=lambda x: (failure_group_of(x[1]) == "throughput", -x[0], x[1]))
        signal = reduced[0][1] if reduced else None
        ep_ids, observed = [], None
        if signal:
            eps = list(self.c("episodes").find({"shift_id": {"$in": run["shift_ids"]["base"]}, "type": signal},
                                               {"zone": 1, "seed": 1, "tick": 1}).sort([("seed", 1), ("tick", 1)]))
            zc = Counter(e.get("zone") for e in eps if e.get("zone"))
            # the zone where the candidate removed the most of them (the per-entry lists are capped at 25 per
            # type and seed, so this is where the fix was seen, not an exact count)
            zc.subtract(e.get("zone") for e in self.c("episodes").find(
                {"shift_id": {"$in": run["shift_ids"]["cand"]}, "type": signal}, {"zone": 1}) if e.get("zone"))
            if zc and max(zc.values()) > 0:
                observed = zc.most_common(1)[0][0]
            # the examples come from that zone, so explain() shows what was fixed where
            eps.sort(key=lambda e: e.get("zone") != observed)
            ep_ids = [e["_id"] for e in eps[:10]]
        if observed is None and run.get("zones"):
            observed = max(run["zones"], key=lambda z: run["zones"][z]["delta"])
        ev = {"gate_run_id": run["_id"], "signal": signal, "episode_ids": ep_ids,
              "observed_at": f"zone:{observed}" if observed in SKELETON_ZONES else SITE_ID,
              "origin": (run.get("origin") or {}).get("source")}
        ref = (run.get("origin") or {}).get("ref")
        if ref and str(ref).startswith("habit:"):
            ev["habit_id"] = ref
        return ev

    # ── Raindrop: one event per proposal, signals exactly once ─

    def _sync_raindrop(self, gid: str):
        """Bring Raindrop up to date with this gate run. Each send is claimed in Atlas first, so a
        signal goes out at most once even with parallel evaluators."""
        run = self.c("gate_runs").find_one({"_id": gid})
        if run is None:
            return
        known = run["verdict"] == "invalid" or run.get("zones") is not None
        first: dict[str, str] = {}
        for e in run["events"]:
            first.setdefault(e["policy"], e["event_id"])
        for e in run["events"]:
            repeat = first[e["policy"]] != e["event_id"]
            want = []
            if known:
                want.append("event")
                if run["verdict"] == "invalid":
                    want.append("invalid_proposal")
                if repeat:
                    want.append("re_proposed")
                gd = run.get("gate_decision")
                if gd and not repeat:
                    want.append("gate_passed" if gd == "passed" else "gate_failed")
            for name in want:
                if name in e.get("signals_sent", []):
                    continue
                claim = self.c("gate_runs").update_one(
                    {"_id": gid, "events": {"$elemMatch": {"event_id": e["event_id"], "signals_sent": {"$ne": name}}}},
                    {"$addToSet": {"events.$.signals_sent": name}})
                if not claim.modified_count:
                    continue
                if name == "event":
                    self.sink.event(e["event_id"], self._event_properties(run, e, repeat))
                else:
                    self.sink.signal(e["event_id"], name)

    @staticmethod
    def _event_properties(run: dict, e: dict, repeat: bool) -> dict:
        ctx = run.get("context") or {}
        p = {"brain_version": run["base_version"], "base_patch_hash": run["base_patch_hash"],
             "cand_patch_hash": run["cand_patch_hash"],
             "lever_groups": sorted({x.get("lever_group") or "unknown" for x in run["edits"]}),
             "edits": ";".join(f"{x['target']}={x['value']:g}" for x in run["edits"]),
             "time_state": ctx.get("time_state"), "origin": (e.get("origin") or run.get("origin") or {}).get("source"),
             "policy": e["policy"], "split": run["split"], "round": e["round"], "gate_run_id": run["_id"],
             "status": run["verdict"], "repeat": repeat, "engine": run["env"]["engine_sha"], "env_key": run["env_key"]}
        zones = run.get("zones") or {}
        if "M" in zones:
            p["zone_M_score"] = zones["M"]["cand"]
            p["zone_M_delta"] = zones["M"]["delta"]
        return p

    # ── Phase 2: held-out, approvals, habits ─────────────────

    def record_heldout(self, gate_run_id: str, seed_set: str, passed: bool, zone_delta: dict) -> dict:
        """The gate's held-out verdict for one seed set. Only the gate client can write or read this;
        brain_versions gets the boolean alone."""
        self._require_gate("record_heldout()")
        run = self.c("gate_runs").find_one({"_id": gate_run_id}, {"promoted_to": 1})
        if run is None:
            raise KeyError(f"no gate run {gate_run_id}")
        doc = {"_id": "ho-" + digest([gate_run_id, seed_set]), "gate_run_id": gate_run_id, "seed_set": seed_set,
               "passed": bool(passed), "zone_delta": {str(z): float(v) for z, v in (zone_delta or {}).items()},
               "recorded_at": now()}
        self.c("heldout_results").replace_one({"_id": doc["_id"]}, doc, upsert=True)
        if run.get("promoted_to"):
            rows = list(self.c("heldout_results").find({"gate_run_id": gate_run_id}, {"passed": 1}))
            self.c("brain_versions").update_one({"version": run["promoted_to"]},
                                                {"$set": {"heldout_passed": all(r["passed"] for r in rows)}})
        return {"_id": doc["_id"], "passed": doc["passed"]}

    def record_final(self, version: int, passed: bool, zone_delta: dict, vs: int = 1, seed_set: str = "final") -> dict:
        """After the freeze: the gate runs the `final` seed set once, v1 against vN, and stores it here."""
        self._require_gate("record_final()")
        final = {"vs": f"v{vs}", "seed_set": seed_set, "passed": bool(passed),
                 "zone_delta": {str(z): float(v) for z, v in (zone_delta or {}).items()}, "at": now()}
        r = self.c("brain_versions").update_one({"version": version}, {"$set": {"final": final}})
        if not r.matched_count:
            raise KeyError(f"no brain version {version}")
        return final

    def record_approval(self, target: str, value: float, decision: str, by: str, ref: Optional[str] = None) -> dict:
        """The Robotics Lead's answer on the call, routed here by the Agent Engine resume handler.
        Writes envelope.approvals; matching needs_approval runs become promotable (or rejected)."""
        self._require_gate("record_approval()")
        if decision not in ("approve", "reject"):
            raise ValueError("decision must be 'approve' or 'reject'")
        d = self.c("envelope").find_one({"_id": target})
        if d is None:
            raise KeyError(f"no setting {target}")
        if d["status"] != "locked":
            raise KGError(f"{target} is {d['status']}: approvals only apply to locked settings")
        value = norm_number(value)
        if not (d["min"] - 1e-9 <= value <= d["max"] + 1e-9):
            raise KGError(f"{value} is outside [{d['min']}, {d['max']}]: no approval can move the envelope's bounds")
        entry = {"value": value, "decision": decision, "approved_by": by, "ref": ref, "at": now()}
        upd: dict = {"$push": {"approvals": entry}}
        if decision == "approve":
            upd["$set"] = {"approved_value": value}
        self.c("envelope").update_one({"_id": target}, upd)
        ready, rejected = [], []
        env = self._envelope()
        for run in self.c("gate_runs").find({"verdict": "needs_approval", "edits.target": target}):
            if not any(e["target"] == target and same_value(e["value"], value) for e in run["edits"]):
                continue
            if decision == "approve":
                self.c("gate_runs").update_one({"_id": run["_id"]}, {"$addToSet": {"approvals": {
                    "target": target, "value": value, "approved_by": by, "ref": ref}}})
                if all(self._is_approved(env, e) for e in run["edits"]):
                    ready.append(run["_id"])
            else:
                self.c("gate_runs").update_one({"_id": run["_id"]}, {"$set": {
                    "verdict": "rejected", "reason": f"declined by {by}" + (f" ({ref})" if ref else "")}})
                rejected.append(run["_id"])
        return {"target": target, "value": value, "decision": decision, "ready_to_promote": ready, "rejected": rejected}

    @staticmethod
    def _is_approved(env: dict, edit: dict) -> bool:
        d = env.get(edit["target"])
        if not d or d["status"] != "locked" or same_value(edit["value"], d["v1"]):
            return True
        return any(a.get("decision") == "approve" and same_value(a["value"], edit["value"])
                   for a in d.get("approvals") or [])

    def add_habit(self, habit_id: str, text: str, clip: Optional[dict] = None, steps: Optional[list] = None,
                  lever_group: Optional[str] = None, **extra) -> str:
        """Person C's pipeline writes habits (Gemini output); the KG owns only the counters."""
        if not habit_id.startswith("habit:"):
            habit_id = f"habit:{habit_id}"
        extra = {k: v for k, v in extra.items() if k not in ("helpful", "harmful", "_id")}  # counters are the KG's
        fields = {"text": text, "clip": clip, "steps": steps or [], "lever_group": lever_group, **extra}
        self.c("playbook").update_one({"_id": habit_id}, {"$set": fields,
                                                          "$setOnInsert": {"helpful": 0, "harmful": 0}}, upsert=True)
        return habit_id

    # ── read views (implemented in views.py) ─────────────────

    def get_context(self, V: int, split: str = "train", use_learned: bool = False) -> dict:
        """Sections A-C. use_learned=True orders section C by the Phase 3 learned lever groups, where stored."""
        from .views import get_context
        learned = None
        if use_learned:
            learned = {d["_id"]: d["learned_lever_groups"] for d in
                       self.c("concepts").find({"learned_lever_groups": {"$exists": True}}, {"learned_lever_groups": 1})}
        return get_context(self, V, split, learned)

    def suggest(self, V: int, k: int = 3, split: str = "train") -> dict:
        from .views import suggest
        return suggest(self, V, k, split)

    def explain(self, component_id: str) -> dict:
        from .views import explain
        return explain(self, component_id)

    def lineage(self, V: int) -> dict:
        from .views import lineage
        return lineage(self, V)

    def graph_snapshot(self, V: int, compare_to: Optional[int] = None) -> dict:
        from .views import graph_snapshot
        return graph_snapshot(self, V, compare_to)

    def history(self, target: str) -> dict:
        """One setting across every version, with the evidence behind each change."""
        from .views import history
        return history(self, target)

    def get_signals(self, shift_id: str, client=None, dev: Optional[bool] = None) -> dict:
        """Raindrop's signals for one shift, by category. Needs RAINDROP_QUERY_API_KEY unless `client`
        (a raindrop_query.QueryClient) is given; reads the project the sink writes to."""
        from .raindrop_query import query_client_from_config
        from .views import get_signals
        if client is not None:
            return get_signals(self, shift_id, client)
        client = query_client_from_config(self.cfg, dev)
        try:
            return get_signals(self, shift_id, client)
        finally:
            client.close()


def order_time_states(ts: dict) -> list[str]:
    """Non-productive states of a time_split by share, largest first; lift_ride never ahead of lift_wait.
    Empty when time_split is all zeros (cut #4 in the TwinForge slip list)."""
    states = [s for s, (productive, _, _) in TIME_STATES.items() if not productive and (ts.get(s) or 0) > 0]
    states.sort(key=lambda s: (-(ts.get(s) or 0), s))
    if "lift_ride" in states and "lift_wait" in states and states.index("lift_ride") < states.index("lift_wait"):
        states.remove("lift_ride")
        states.insert(states.index("lift_wait") + 1, "lift_ride")
    return states
