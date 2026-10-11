"""Read-only views over the KG: what the improver sees, and what the demo shows.

get_context(V)     sections A-C for GEPA's side_info and the improver prompt
suggest(V)         top untested candidates, plus "passed but not promoted"
explain(id)        rule → habit + clip → episodes → gate run, plus heldout_passed
lineage(V)         $graphLookup over brain_versions.parent, joined to promoting runs and habits
graph_snapshot(V)  nodes and links for one version, added/retired components marked

Nothing here reads heldout_* collections, so every view works with the improver client
and can never leak a held-out seed or score.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Optional

from . import metrics
from .hashing import same_value
from .ontology import COMPONENT_KINDS, FAILURE_GROUPS, SKELETON_KINDS, TIME_STATES, failure_group_of
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


def get_context(kg, V: int, split: str = "train", learned: Optional[dict] = None) -> dict:
    env = kg.env
    base = kg.export_brain(V)
    val = kg.validate(base)
    H = val.patch_hash

    # A. the current brain
    results = [s["result"] for s in kg.c("shifts").find({"env_key": env.key, "patch_hash": H, "split": split},
                                                        {"result": 1})]
    A = metrics.summarize(results) if results else None

    # B. everything evaluated on this brain, in this env
    runs = list(kg.c("gate_runs").find({"env_key": env.key, "base_patch_hash": H}).sort("created_at", 1))
    B: dict[str, list] = {}
    tested: dict[str, list] = defaultdict(list)
    for r in runs:
        row = run_row(r)
        groups = sorted({e.get("lever_group") or "unknown" for e in r["edits"]}) or ["(no edits)"]
        for g in groups:
            B.setdefault(g, []).append(row)
        for e in r["edits"]:
            if not any(same_value(e["value"], t) for t in tested[e["target"]]):
                tested[e["target"]].append(e["value"])

    # C. untested settings, ordered by the ontology
    order = lever_group_order(kg, A, learned)
    rank = {g: i for i, (g, _) in enumerate(order)}
    envelope = kg._envelope()
    current = {t: e["value"] for t, e in val.effective.items()}
    rows = []
    for i, s in enumerate(kg.settings):
        if not s.is_lever:
            continue
        d = envelope.get(s.target, {})
        cur = current.get(s.target)
        tried = sorted(tested.get(s.target, []))
        nxt = [v for v in s.candidates() if not same_value(v, cur) and not any(same_value(v, t) for t in tried)]
        rows.append({"target": s.target, "lever_group": s.group, "status": d.get("status", s.status),
                     "min": d.get("min", s.min), "max": d.get("max", s.max), "v1": d.get("v1", s.v1), "current": cur,
                     "tested": tried, "untested": nxt[:5], "needs_call": d.get("status", s.status) == "locked",
                     "_i": i})
    rows.sort(key=lambda r: (r["needs_call"], rank.get(r["lever_group"], 99), r["_i"]))
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
    out.append("| setting | group | status | min | max | v1 | current | tried | try next |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    for r in C["settings"]:
        status = "locked: needs a call" if r["needs_call"] else r["status"]
        out.append(f"| {r['target']} | {r['lever_group']} | {status} | {_num(r['min'])} | {_num(r['max'])} | "
                   f"{_num(r['v1'])} | {_num(r['current'])} | {', '.join(map(_num, r['tested'])) or '-'} | "
                   f"{', '.join(map(_num, r['untested'])) or '-'} |")
    return "\n".join(out)


def suggest(kg, V: int, k: int = 3, split: str = "train") -> dict:
    ctx = get_context(kg, V, split)
    why = {o["group"]: o["why"] for o in ctx["data"]["C"]["lever_group_order"]}
    cands = []
    for r in ctx["data"]["C"]["settings"]:
        if len(cands) >= k:
            break
        if r["untested"]:
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
