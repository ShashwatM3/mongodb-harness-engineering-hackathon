"""Read-only views over the KG: what the improver sees, and what the demo shows.

get_context(V)     sections A-C for GEPA's side_info and the improver prompt
suggest(V)         top untested candidates, plus "passed but not promoted"
explain(id)        rule → habit + clip → episodes → gate run, plus heldout_passed
lineage(V)         $graphLookup over brain_versions.parent, joined to promoting runs and habits
graph_snapshot(V)  nodes and links for one version, added/retired components marked
history(target)    one setting across every version, with the evidence behind each change
get_signals(shift) Raindrop's signals for one shift, grouped by category (reads the Query API)

Nothing here reads heldout_* collections, so every view works with the improver client
and can never leak a held-out seed or score.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Optional

import httpx

from . import metrics
from .contract import FAILURE_TYPES
from .hashing import same_value
from .ontology import FAILURE_GROUPS, SKELETON_KINDS, TIME_STATES, failure_group_of
from .raindrop_sink import EVENT_NAME, SIGNALS
from .registry import LEVER_GROUPS


def _pct(x: float) -> str:
    return f"{100 * x:.0f}%"


def _num(x) -> str:
    return "-" if x is None else f"{x:g}"


def run_row(r: dict) -> dict:
    zones = r.get("zones") or {}
    return {
        "gate_run_id": r["_id"], "split": r["split"], "origin": (r.get("origin") or {}).get("source"),
        "edits": [{"target": e["target"], "value": e["value"], "base_value": e.get("base_value")} for e in r["edits"]],
        "verdict": r["verdict"], "reason": r.get("reason"),
        "zones": {z: {k: v[k] for k in ("delta", "seeds_better", "seeds_worse")} for z, v in zones.items()},
        "failure_deltas": {t: v["cand"] - v["base"] for t, v in (r.get("failures") or {}).items() if v["cand"] != v["base"]},
        "rounds": sorted({e["round"] for e in r.get("events", [])}), "proposals": len(r.get("events", [])),
    }


def time_concept_id(state: str) -> str:
    productive = TIME_STATES[state][0]
    return f"c:time/{'productive' if productive else 'non_productive'}/{state}"


def lever_group_order(kg, A: Optional[dict], learned: Optional[dict] = None) -> list[tuple[str, str]]:
    """Section C's ranking keys, in order: the worst zone's largest non-productive time state, then its
    late/dropped counts, then the top failure group. Each key brings its concepts' candidate lever groups."""
    from .core import order_time_states

    concepts = {d["_id"]: d for d in kg.c("concepts").find({}, {"candidate_lever_groups": 1, "learned_lever_groups": 1})}
    order: list[tuple[str, str]] = []

    def groups_of(cid: str) -> list[str]:
        c = concepts.get(cid) or {}
        if learned is not None and cid in learned:
            return learned[cid]
        return c.get("candidate_lever_groups") or []

    def add(cid: str, why: str):
        for g in groups_of(cid):
            name = g.removeprefix("c:lever/")
            if name not in [o[0] for o in order]:
                order.append((name, why))

    if A and A.get("worst_zone"):
        worst, ts = A["worst_zone"], A["worst_time_split"]
        for s in order_time_states(ts):
            add(time_concept_id(s), f"zone {worst}: {s} is {_pct(ts[s])} of task time")
        oc = A["zones"][worst]
        for metric in ("late", "dropped"):
            if oc.get(metric, 0) > 0:
                add(f"c:outcome/{metric}", f"zone {worst}: {oc['late']} late, {oc['dropped']} dropped")
        by_group = Counter()
        for t, n in A["failures"].items():
            g = failure_group_of(t)
            if g and n:
                by_group[g] += n
        for g, n in by_group.most_common():
            add(f"c:failure/{g}", f"{n} {g} failures ({', '.join(t for t in FAILURE_GROUPS[g]['leaves'] if A['failures'].get(t))})")
    for g in LEVER_GROUPS:
        if g not in [o[0] for o in order]:
            order.append((g, "default order"))
    return order


def brain_summary(kg, V: int, split: str = "train", patch_hash: Optional[str] = None) -> Optional[dict]:
    """Section A: brain V pooled over its recorded shifts on one split, in the current env (None if none yet,
    or if no runner env is set, e.g. in the approval agent: callers then fall back to brain_versions.scores)."""
    if kg._env is None:
        return None
    H = patch_hash or kg.validate(kg.export_brain(V)).patch_hash
    results = [s["result"] for s in kg.c("shifts").find({"env_key": kg.env.key, "patch_hash": H, "split": split},
                                                        {"result": 1})]
    return metrics.summarize(results) if results else None


def get_context(kg, V: int, split: str = "train", learned: Optional[dict] = None) -> dict:
    env = kg.env
    base = kg.export_brain(V)
    val = kg.validate(base)
    H = val.patch_hash

    # A. the current brain
    A = brain_summary(kg, V, split, patch_hash=H)

    # B. everything evaluated on this brain, in this env
    runs = list(kg.c("gate_runs").find({"env_key": env.key, "base_patch_hash": H}).sort("created_at", 1))
    B: dict[str, list] = {}
    tested: dict[str, list] = defaultdict(list)
    no_effect: dict[str, list] = defaultdict(list)   # values whose run changed no zone on any seed
    improved: set[str] = set()                        # targets with at least one run that helped somewhere
    for r in runs:
        row = run_row(r)
        groups = sorted({e.get("lever_group") or "unknown" for e in r["edits"]}) or ["(no edits)"]
        for g in groups:
            B.setdefault(g, []).append(row)
        zones = r.get("zones") or {}
        inert = bool(zones) and all(v["delta"] == 0 and not v["seeds_better"] and not v["seeds_worse"]
                                    for v in zones.values())
        helped = any(v["delta"] > 0 for v in zones.values())
        for e in r["edits"]:
            if not any(same_value(e["value"], t) for t in tested[e["target"]]):
                tested[e["target"]].append(e["value"])
            if inert and len(r["edits"]) == 1:
                no_effect[e["target"]].append(e["value"])
            if helped:
                improved.add(e["target"])

    # C. untested settings, ordered by the ontology
    order = lever_group_order(kg, A, learned)
    rank = {g: i for i, (g, _) in enumerate(order)}
    envelope = kg._envelope()
    current = {t: e["value"] for t, e in val.effective.items()}
    # values the gate rejected on an earlier brain in this env, and values a promotion in this env moved away
    # from: still allowed, but never among the first to try again
    rejected_before: dict[str, list] = defaultdict(list)
    superseded: dict[str, list] = defaultdict(list)
    for r in kg.c("gate_runs").find({"env_key": env.key, "verdict": {"$in": ["rejected", "promoted"]}},
                                    {"verdict": 1, "base_patch_hash": 1, "edits.target": 1, "edits.value": 1,
                                     "edits.base_value": 1}):
        for e in r["edits"]:
            if r["verdict"] == "promoted":
                bucket, v = superseded[e["target"]], e.get("base_value")
            elif r["base_patch_hash"] != H:
                bucket, v = rejected_before[e["target"]], e["value"]
            else:
                continue
            if v is not None and not any(same_value(v, t) for t in bucket):
                bucket.append(v)
    rows = []
    for i, s in enumerate(kg.settings):
        if not s.is_lever:
            continue
        d = envelope.get(s.target, {})
        cur = current.get(s.target, d.get("engine_default", s.engine_default))  # absent: the engine default runs
        tried = sorted(tested.get(s.target, []))
        rej = sorted(v for v in rejected_before.get(s.target, []) if not same_value(v, cur))
        old = sorted(v for v in superseded.get(s.target, []) if not same_value(v, cur)
                     and not any(same_value(v, x) for x in rej))
        last = rej + old
        nxt = [v for v in s.candidates() if not same_value(v, cur) and not any(same_value(v, t) for t in tried)]
        nxt.sort(key=lambda v: any(same_value(v, x) for x in last))  # stable: keeps the grid order within each half
        inert = bool(tried) and s.target not in improved and \
            all(any(same_value(t, x) for x in no_effect.get(s.target, [])) for t in tried)
        rows.append({"target": s.target, "lever_group": s.group, "status": d.get("status", s.status),
                     "min": d.get("min", s.min), "max": d.get("max", s.max), "v1": d.get("v1", s.v1), "current": cur,
                     "tested": tried, "no_effect": sorted(no_effect.get(s.target, [])), "inert": inert,
                     "rejected_before": rej, "superseded": old, "untested": nxt[:5],
                     "stale_only": bool(nxt) and all(any(same_value(v, x) for x in last) for v in nxt),
                     "needs_call": d.get("status", s.status) == "locked", "_i": i})
    # a setting whose every tried value changed nothing on this brain goes after the ones still worth probing
    rows.sort(key=lambda r: (r["needs_call"], r["inert"], rank.get(r["lever_group"], 99), r["_i"]))
    for r in rows:
        r.pop("_i")

    data = {"version": V, "split": split, "env_key": env.key, "env": env.model_dump(), "patch_hash": H,
            "A": A, "B": B, "C": {"lever_group_order": [{"group": g, "why": w} for g, w in order], "settings": rows}}
    return {"markdown": render_context(data), "data": data}


def render_context(d: dict) -> str:
    env = d["env"]
    out = [f"## Brain v{d['version']}: what has been measured and what to try next",
           f"Seeds: {d['split']}. Env: engine {env['engine_sha']}, {env['spec_id']}, {env['spec_hash_or_epoch']}, "
           f"{env['ticks']} ticks, profile {env['profile']}.", ""]
    A = d["A"]
    out.append("### A. The current brain")
    if not A:
        out.append(f"Not evaluated yet on {d['split']} seeds in this env.")
    else:
        out.append("| zone | score | on time | late | dropped | offered |")
        out.append("|---|---|---|---|---|---|")
        for z, m in A["zones"].items():
            mark = " (worst)" if z == A["worst_zone"] else ""
            out.append(f"| {z}{mark} | {m['score']:.3f} | {m['on_time']} | {m['late']} | {m['dropped']} | {m['offered']} |")
        ts = A["worst_time_split"]
        out.append(f"Time split in zone {A['worst_zone']}: " +
                   ", ".join(f"{s} {_pct(v)}" for s, v in sorted(ts.items(), key=lambda kv: -kv[1]) if v > 0))
        fails = {t: n for t, n in A["failures"].items() if n}
        out.append("Failures, all seeds (uncapped): " + (", ".join(f"{t} {n}" for t, n in fails.items()) or "none"))
        per_zone = []
        for t, info in A["failures_by_zone"].items():
            zs = ", ".join(f"{z} {n}" for z, n in sorted(info["zones"].items()))
            per_zone.append(f"{t}: {zs or '-'}" + (" (capped: at least)" if info["capped"] else ""))
        if per_zone:
            out.append("Per zone (from the per-entry lists): " + "; ".join(per_zone))
    out.append("")
    B = d["B"]
    n_runs = len({r["gate_run_id"] for rows in B.values() for r in rows})
    out.append(f"### B. Already evaluated on this brain ({n_runs} candidates)")
    if not B:
        out.append("Nothing yet.")
    for g, rows in B.items():
        out.append(f"**{g}**")
        for r in rows:
            edits = ", ".join(f"{e['target']} {_num(e['base_value'])}→{_num(e['value'])}" for e in r["edits"]) or "(none)"
            z = "; ".join(f"{zn} {v['delta']:+.3f} ({v['seeds_better']} better, {v['seeds_worse']} worse)"
                          for zn, v in r["zones"].items() if v["delta"] or v["seeds_better"] or v["seeds_worse"])
            f = ", ".join(f"{t} {n:+d}" for t, n in r["failure_deltas"].items())
            bits = [edits, r["split"], z or ("no zone changed" if r["zones"] else ""), f, r["verdict"] or "pending"]
            if r["reason"]:
                bits.append(r["reason"])
            if r["proposals"] > 1:
                bits.append(f"proposed {r['proposals']} times")
            out.append("- " + " · ".join(b for b in bits if b))
    out.append("")
    C = d["C"]
    out.append("### C. Untested settings, in the order to try them")
    out.append("Lever groups: " + "; ".join(f"{o['group']} ({o['why']})" for o in C["lever_group_order"]))
    out.append("| setting | group | status | min | max | v1 | current | tried | try next | tried before, no good |")
    out.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in C["settings"]:
        status = "locked: needs a call" if r["needs_call"] else r["status"]
        if r.get("inert"):
            status += "; no effect so far"
        before = [f"{_num(v)} (rejected)" for v in r.get("rejected_before") or []] + \
                 [f"{_num(v)} (superseded)" for v in r.get("superseded") or []]
        out.append(f"| {r['target']} | {r['lever_group']} | {status} | {_num(r['min'])} | {_num(r['max'])} | "
                   f"{_num(r['v1'])} | {_num(r['current'])} | {', '.join(map(_num, r['tested'])) or '-'} | "
                   f"{', '.join(map(_num, r['untested'])) or '-'} | {', '.join(before) or '-'} |")
    return "\n".join(out)


def suggest(kg, V: int, k: int = 3, split: str = "train") -> dict:
    """The k candidates to try next: section C's first untested setting of each lever group in turn, so one
    round never spends every proposal on a single group (a group that has stopped paying off would
    otherwise be probed value after value, as the simulation showed), then the groups' second settings."""
    ctx = get_context(kg, V, split)
    why = {o["group"]: o["why"] for o in ctx["data"]["C"]["lever_group_order"]}
    by_group: dict[str, list] = {}
    for r in ctx["data"]["C"]["settings"]:
        if r["untested"]:
            by_group.setdefault(r["lever_group"], []).append(r)
    for rows in by_group.values():  # within a group, a setting with fresh values before one with only old ones
        rows.sort(key=lambda r: r["stale_only"])
    cands = []
    while len(cands) < k and any(by_group.values()):
        for g in list(by_group):
            if not by_group[g] or len(cands) >= k:
                continue
            r = by_group[g].pop(0)
            cands.append({"target": r["target"], "value": r["untested"][0], "lever_group": r["lever_group"],
                          "status": r["status"], "needs_call": r["needs_call"], "why": why.get(r["lever_group"])})
    H = ctx["data"]["patch_hash"]
    passed = [run_row(r) for r in kg.c("gate_runs").find({"env_key": kg.env.key, "base_patch_hash": H,
                                                          "verdict": "passed"})]
    return {"version": V, "candidates": cands, "passed_not_promoted": passed}


def explain(kg, component_id: str) -> dict:
    """One aggregation that follows the evidence edges (team doc 03's click path)."""
    pipeline = [
        {"$match": {"_id": component_id}},
        {"$lookup": {"from": "playbook", "localField": "evidence.habit_id", "foreignField": "_id", "as": "habit"}},
        {"$lookup": {"from": "episodes", "localField": "evidence.episode_ids", "foreignField": "_id",
                     "as": "episodes"}},
        {"$lookup": {"from": "gate_runs", "localField": "evidence.gate_run_id", "foreignField": "_id",
                     "as": "gate_run"}},
        {"$lookup": {"from": "brain_versions", "localField": "since", "foreignField": "version", "as": "version"}},
    ]
    doc = next(kg.c("brain_nodes").aggregate(pipeline), None)
    if doc is None:
        raise KeyError(f"no component {component_id!r}")
    habit = doc["habit"][0] if doc["habit"] else None
    run = doc["gate_run"][0] if doc["gate_run"] else None
    ver = doc["version"][0] if doc["version"] else {}
    ev = doc.get("evidence") or {}
    episodes = sorted(doc["episodes"], key=lambda e: (e.get("seed", 0), e.get("tick", 0)))
    run_view = None
    if run:
        run_view = {"gate_run_id": run["_id"], "base": run["base"], "split": run["split"], "verdict": run["verdict"],
                    "zones": run.get("zones"), "failures": run.get("failures"), "edits": run["edits"],
                    "seeds": run["env"]["seeds"]}
    value = (doc.get("compiles_to") or {}).get("value")
    lines = [f"**{doc.get('label')}** ({doc['kind']} on {doc['parent_id']}, `{doc.get('key')}` = {_num(value)}, "
             f"since v{doc['since']}" + (f", retired in v{doc['until']}" if doc.get("until") else "") + ")"]
    if ev.get("origin") == "baseline":
        lines.append("Baseline component of brain v1: the integrator's first-day setup, not learned.")
    if habit:
        clip = habit.get("clip") or {}
        when = f" at {clip.get('t0', 0):g}-{clip.get('t1', 0):g} s" if clip else ""
        lines.append(f"Habit: {habit.get('text')} (clip {clip.get('uri', '-')}{when}; "
                     f"helpful {habit.get('helpful', 0)}, harmful {habit.get('harmful', 0)})")
    if ev.get("signal"):
        lines.append(f"Fixed: {ev['signal']} in the base brain, seen at {ev.get('observed_at')}; "
                     f"{len(episodes)} example episodes")
        for e in episodes[:3]:
            lines.append(f"  - seed {e.get('seed')}, tick {e.get('tick')}, zone {e.get('zone')}: {e.get('detail')}")
    if run:
        z = run.get("zones") or {}
        best = max(z, key=lambda k: z[k]["delta"]) if z else None
        if best:
            v = z[best]
            lines.append(f"Gate run {run['_id']} ({run['split']} seeds, against {run['base']}): zone {best} "
                         f"{v['base']:.3f} → {v['cand']:.3f} ({v['delta']:+.3f}), {v['seeds_better']} seeds better, "
                         f"{v['seeds_worse']} worse; verdict {run['verdict']}")
    hp = ver.get("heldout_passed")
    lines.append("Held-out: " + ("passed" if hp else "failed" if hp is False else "not recorded"))
    comp = {k: doc.get(k) for k in ("_id", "kind", "parent_id", "key", "label", "compiles_to", "since", "until",
                                    "lever", "evidence", "origin")}
    return {"component": comp, "habit": habit, "episodes": episodes, "gate_run": run_view, "heldout_passed": hp,
            "markdown": "\n".join(lines)}


def lineage(kg, V: int) -> dict:
    pipeline = [
        {"$match": {"version": V}},
        {"$graphLookup": {"from": "brain_versions", "startWith": "$parent", "connectFromField": "parent",
                          "connectToField": "_id", "as": "ancestors", "depthField": "depth"}},
        {"$project": {"chain": {"$concatArrays": [["$$ROOT"], "$ancestors"]}}},
        {"$unwind": "$chain"},
        {"$replaceRoot": {"newRoot": "$chain"}},
        {"$project": {"ancestors": 0}},
        {"$sort": {"version": 1}},
        {"$lookup": {"from": "gate_runs", "localField": "promoted_by", "foreignField": "_id", "as": "run"}},
        {"$lookup": {"from": "playbook", "localField": "run.origin.ref", "foreignField": "_id", "as": "habit"}},
    ]
    chain = []
    for d in kg.c("brain_versions").aggregate(pipeline):
        run = d["run"][0] if d["run"] else None
        habit = d["habit"][0] if d["habit"] else None
        chain.append({
            "version": d["version"], "parent": d.get("parent"), "hypothesis": d.get("hypothesis"),
            "added": d.get("added", []), "retired": d.get("retired", []), "scores": d.get("scores", {}),
            "heldout_passed": d.get("heldout_passed"), "approvals": d.get("approvals", []),
            "promoted_by": d.get("promoted_by"),
            "edits": run["edits"] if run else [], "origin": (run.get("origin") if run else None),
            "habit": {"_id": habit["_id"], "text": habit.get("text"), "clip": habit.get("clip")} if habit else None,
        })
    if not chain:
        raise KeyError(f"no brain version {V}")
    md = []
    for c in chain:
        if c["version"] == 1:
            md.append("v1: baseline")
            continue
        edits = ", ".join(f"{e['target']} {_num(e.get('base_value'))}→{_num(e['value'])}" for e in c["edits"])
        src = f" from {c['habit']['_id']}" if c["habit"] else (f" ({c['origin']['source']})" if c["origin"] else "")
        m = (c["scores"].get("train") or {}).get("M")
        hp = {True: "held-out passed", False: "held-out failed"}.get(c["heldout_passed"], "held-out not recorded")
        md.append(f"v{c['version']}: {edits}{src}" + (f", zone M train {m:.3f}" if m is not None else "") + f", {hp}")
    return {"version": V, "chain": chain, "markdown": " → ".join(md)}


def graph_snapshot(kg, V: int, compare_to: Optional[int] = None) -> dict:
    """Nodes and links for one version. Components new since `compare_to` (default V-1) are "added";
    components active then but not now are "retired". Evidence becomes extra nodes and links."""
    if kg.c("brain_versions").find_one({"version": V}, {"_id": 1}) is None:
        raise KeyError(f"no brain version {V}")
    prev = compare_to if compare_to is not None else (V - 1 if V > 1 else None)
    skel = list(kg.c("brain_nodes").find({"kind": {"$in": SKELETON_KINDS}}).sort("order", 1))
    active = list(kg.c("brain_nodes").find(kg._active_filter(V)))
    before = {c["_id"]: c for c in kg.c("brain_nodes").find(kg._active_filter(prev))} if prev else {}
    ids = {c["_id"] for c in active}
    nodes, links = [], []
    for n in skel:
        nodes.append({"id": n["_id"], "kind": n["kind"], "label": n.get("label"), "parent_id": n.get("parent_id"),
                      "status": "skeleton"})

    def comp_node(c, status):
        return {"id": c["_id"], "kind": c["kind"], "label": c.get("label"), "parent_id": c["parent_id"],
                "key": c.get("key"), "value": (c.get("compiles_to") or {}).get("value"), "since": c["since"],
                "until": c.get("until"), "lever": c.get("lever"), "status": status, "evidence": c.get("evidence")}

    for c in sorted(active, key=lambda c: (c.get("key") or "", c["since"])):
        nodes.append(comp_node(c, "added" if prev and c["_id"] not in before else "unchanged"))
    for cid, c in before.items():
        if cid not in ids:
            nodes.append(comp_node(c, "retired"))
    for n in nodes:
        if n.get("parent_id"):
            links.append({"source": n["parent_id"], "target": n["id"], "kind": "scope"})
    evidence_nodes = {}
    for n in nodes:
        ev = n.get("evidence") or {}
        for field_, kind in (("gate_run_id", "gate_run"), ("habit_id", "habit")):
            ref = ev.get(field_)
            if ref:
                evidence_nodes.setdefault(ref, kind)
                links.append({"source": n["id"], "target": ref, "kind": "evidence"})
    for ref, kind in evidence_nodes.items():
        if kind == "habit":
            h = kg.c("playbook").find_one({"_id": ref}, {"text": 1, "clip": 1}) or {}
            nodes.append({"id": ref, "kind": "habit", "label": h.get("text", ref), "clip": h.get("clip"),
                          "status": "evidence"})
        else:
            r = kg.c("gate_runs").find_one({"_id": ref}, {"zones": 1, "verdict": 1}) or {}
            m = ((r.get("zones") or {}).get("M") or {})
            label = f"gate run: zone M {m['delta']:+.3f}" if m else "gate run"
            nodes.append({"id": ref, "kind": "gate_run", "label": label, "verdict": r.get("verdict"),
                          "status": "evidence"})
    counts = Counter(n["status"] for n in nodes)
    return {"version": V, "compare_to": prev, "nodes": nodes, "links": links, "counts": dict(counts)}


def history(kg, target: str) -> dict:
    """One setting across every committed version: its effective value at each, and for each change the
    component, gate run, hypothesis and origin behind it. "What has the stair threshold been, and why did
    it move?" in one call, instead of export_brain over every version."""
    from .hashing import effective_edits

    env = kg.c("envelope").find_one({"_id": target}) or {}
    if not env and not kg.c("brain_nodes").find_one({"key": target}, {"_id": 1}):
        raise KeyError(f"no setting or component key {target!r}")
    versions = list(kg.c("brain_versions").find({"status": {"$ne": "pending"}}).sort("version", 1))
    rows = []
    for v in versions:
        e = effective_edits(kg._build_brain(v["version"])).get(target)
        rows.append({"version": v["version"], "value": e["value"] if e else env.get("engine_default"),
                     "component_id": e["node_id"] if e else None, "hypothesis": v.get("hypothesis"),
                     "promoted_by": v.get("promoted_by"), "heldout_passed": v.get("heldout_passed")})
    changes = []
    for prev, cur in zip(rows, rows[1:]):
        if same_value(prev["value"], cur["value"]):
            continue
        comp = kg.c("brain_nodes").find_one({"_id": cur["component_id"]}) if cur["component_id"] else None
        ev = (comp or {}).get("evidence") or {}
        gid = ev.get("gate_run_id") or cur["promoted_by"]
        run = kg.c("gate_runs").find_one({"_id": gid}, {"zones": 1, "verdict": 1, "origin": 1, "split": 1}) if gid else None
        m = ((run or {}).get("zones") or {}).get("M") or {}
        changes.append({"version": cur["version"], "from": prev["value"], "to": cur["value"],
                        "component_id": cur["component_id"], "gate_run_id": gid, "hypothesis": cur["hypothesis"],
                        "origin": (comp or {}).get("origin") or (run or {}).get("origin"),
                        "signal": ev.get("signal"), "habit_id": ev.get("habit_id"),
                        "zone_M_delta": m.get("delta"), "heldout_passed": cur["heldout_passed"]})
    md = [f"**{target}**" + (f" ({env['status']}, [{_num(env.get('min'))}, {_num(env.get('max'))}], v1 {_num(env.get('v1'))})"
                             if env else "") + ": " + " → ".join(f"v{r['version']} {_num(r['value'])}" for r in rows)]
    for c in changes:
        src = (c["origin"] or {}).get("source") if isinstance(c["origin"], dict) else None
        bits = [f"v{c['version']}: {_num(c['from'])}→{_num(c['to'])}"]
        if c["hypothesis"]:
            bits.append(f'"{c["hypothesis"]}"')
        if src:
            bits.append(f"from {c['habit_id'] or src}")
        if c["signal"]:
            bits.append(f"fixed {c['signal']}")
        if c["zone_M_delta"] is not None:
            bits.append(f"zone M {c['zone_M_delta']:+.3f}")
        bits.append({True: "held-out passed", False: "held-out failed"}.get(c["heldout_passed"], "held-out not recorded"))
        md.append("- " + ", ".join(bits))
    return {"target": target, "envelope": {k: env.get(k) for k in ("status", "min", "max", "v1", "engine_default")},
            "versions": rows, "changes": changes, "markdown": "\n".join(md)}


# Signal names by category. Gate signals come from the KG itself; hard metrics are the runner's
# failure types (sent by whoever instruments them, on the KG's event ids); Self Diagnostics are
# iteration 03's warehouse categories plus Raindrop's defaults.
SIGNAL_CATEGORIES = {
    "gate": set(SIGNALS),
    "hard_metrics": {t.lower() for t in FAILURE_TYPES},
    "self_diagnostics": {"capability_gap", "guardrail_conflict", "repeated_failure", "sop_gap",
                         "missing_context", "repeatedly_broken_tool", "complete_task_failure"},
}
SIGNAL_SPLITS = ("train", "val")


def signal_category(name: str) -> str:
    n = (name or "").lower()
    return next((c for c, names in SIGNAL_CATEGORIES.items() if n in names), "other")


def get_signals(kg, shift_id: str, client) -> dict:
    """Raindrop's signals for one shift, grouped by category, for the supervisor's first call after a shift.

    The KG sends one candidate_brain event per proposal, not per shift, so a shift maps to the gate runs
    that used it (base or candidate side) and, through their gate_run_id property, to those events and
    the signals on them. Events carrying a `shift_id` property themselves (worker agents, Self
    Diagnostics) match directly. Events whose `split` or `seed_set` is anything but train or val are dropped."""
    shift = kg.c("shifts").find_one({"_id": shift_id}, {"seed": 1, "split": 1, "brain_version": 1,
                                                         "patch_hash": 1, "env_key": 1})
    runs = list(kg.c("gate_runs").find({"$or": [{"shift_ids.base": shift_id}, {"shift_ids.cand": shift_id}]},
                                       {"env_key": 1, "shift_ids": 1, "verdict": 1}))
    side = {r["_id"]: "base" if shift_id in r["shift_ids"]["base"] else "cand" for r in runs}

    found: dict[str, dict] = {}
    error = None
    try:
        for key in sorted({r["env_key"] for r in runs}):
            for e in client.events(event_name=EVENT_NAME, properties={"env_key": key}):
                if (e.get("properties") or {}).get("gate_run_id") in side:
                    found.setdefault(e["id"], e)
        for e in client.events(properties={"shift_id": shift_id}):
            found.setdefault(e["id"], e)
    except httpx.HTTPError as e:  # Raindrop is never on the critical path
        error = f"Raindrop query failed: {e}"
    if shift is None and not runs and not found and error is None:
        raise KeyError(f"no shift {shift_id!r} in the KG or in Raindrop")

    events, dropped = [], 0
    categories: dict[str, dict] = {c: {} for c in (*SIGNAL_CATEGORIES, "other")}
    for e in sorted(found.values(), key=lambda e: e.get("timestamp") or ""):
        p = e.get("properties") or {}
        if any(p.get(k) not in (None, *SIGNAL_SPLITS) for k in ("split", "seed_set")):  # iteration 03 tags seed_set
            dropped += 1
            continue
        names = [s["name"] for s in e.get("signals") or []]
        gid = p.get("gate_run_id")
        events.append({"id": e["id"], "event_name": e.get("event_name"), "timestamp": e.get("timestamp"),
                       "gate_run_id": gid, "side": side.get(gid), "brain_version": p.get("brain_version"),
                       "status": p.get("status"), "signals": names})
        for n in names:
            slot = categories[signal_category(n)].setdefault(n, {"count": 0, "event_ids": []})
            slot["count"] += 1
            slot["event_ids"].append(e["id"])

    head = f"Shift {shift_id}"
    if shift:
        head += f" (seed {shift.get('seed')}, {shift.get('split')}, brain v{shift.get('brain_version')})"
    head += f", Raindrop project {client.project_id or 'default'}: {len(events)} events from {len(runs)} gate runs."
    lines = [head]
    if error:
        lines.append(error)
    elif runs and not events:
        lines.append("No Raindrop events yet: the KG sends them once a gate run's outcome is known, and "
                     "ingestion can lag.")
    for c, sigs in categories.items():
        body = ", ".join(f"{n} ×{v['count']}" for n, v in sorted(sigs.items(), key=lambda kv: -kv[1]["count"]))
        lines.append(f"- {c.replace('_', ' ')}: {body or 'none'}")
    return {"shift_id": shift_id, "shift": shift, "project": client.project_id,
            "gate_runs": [{"gate_run_id": r["_id"], "side": side[r["_id"]], "verdict": r.get("verdict")} for r in runs],
            "events": events, "categories": categories, "dropped_other_splits": dropped, "error": error,
            "markdown": "\n".join(lines)}
