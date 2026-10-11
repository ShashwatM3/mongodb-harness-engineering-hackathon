"""The supervisor's toolbelt, as plain functions over the two kg clients.

Reads:   get_brain_context, get_signals, get_playbook, current_scores, get_trajectories, explain, suggest
Change:  propose_edit (record_proposal + evaluate in one step), run_gate (the real gate), commit_brain_version
Human:   call_robotics_lead (incident POST to the gateway, contract A), save_preference

The SDK wrappers in supervisor.py call these; the HTTP routes in app.py and the loop driver reuse them.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

from . import gate as gate_rules
from .state import State

log = logging.getLogger("harness.tools")

ZONE_NAMES = {"A": "zone A (ground, inbound)", "B": "zone B (ground, sorting/outbound)", "C": "zone C (ground, stairwell, packing)", "D": "zone D (ground, packing)", "M": "zone M (mezzanine, lift or west stairs)"}


# ── reads ────────────────────────────────────────────────────

def get_brain_context(st: State, task_node_id: str, version: int | None = None, reader: str = "supervisor") -> dict:
    out = st.improver.get_brain_context(task_node_id, version, reader=reader)
    st.bus.emit("brain_read", node_id=task_node_id, scope=out["scope"], version=out["version"], reader=reader,
                component_ids=[c["_id"] for c in out["components"]])
    return out


def get_signals(st: State, shift_id: str) -> dict:
    return st.improver.get_signals(shift_id)


def get_playbook(st: State, task_node: str) -> list[dict]:
    return st.improver.get_playbook(task_node)


def current_scores(st: State, version: int | None = None, split: str = "train") -> dict:
    return st.improver.current_scores(version=version, split=split)


def get_trajectories(st: State, shift_id: str | None = None, version: int | None = None, zone: str | None = None, limit: int = 12) -> dict:
    """The shift's raw per-zone result and its failure episodes, from the shifts and episodes collections."""
    imp = st.improver
    if shift_id is None:
        V = version if version is not None else imp.latest_version()
        H = imp.validate(imp.export_brain(V)).patch_hash
        docs = list(imp.c("shifts").find({"env_key": imp.env.key, "patch_hash": H, "split": "train"}, {"_id": 1, "seed": 1}).sort("seed", 1))
        if not docs:
            return {"error": f"no training shifts recorded for brain v{V} yet; call propose_edit or current_scores first"}
        shift_id = docs[0]["_id"]
    s = imp.c("shifts").find_one({"_id": shift_id})
    if s is None:
        return {"error": f"no shift {shift_id}"}
    q: dict = {"shift_id": shift_id}
    if zone:
        q["zone"] = zone
    eps = list(imp.c("episodes").find(q, {"_id": 1, "type": 1, "zone": 1, "tick": 1, "robots": 1, "detail": 1, "task_id": 1}).sort("tick", 1))
    res = s["result"]
    return {
        "shift_id": shift_id, "seed": s["seed"], "brain_version": s["brain_version"], "split": s["split"],
        "zones": {z: {k: m[k] for k in ("offered", "on_time", "late", "dropped", "censored", "safety_events", "score", "avg_task_s", "time_split")} for z, m in res["zones"].items()},
        "fleet": res["fleet"], "safety": res["safety"], "failure_counts": res["failure_counts"],
        "scenario": res.get("scenario", []),
        "episodes": eps[:limit], "episodes_total": len(eps),
    }


def explain(st: State, component_id: str) -> dict:
    return st.improver.explain(component_id)


def suggest(st: State, version: int | None = None, k: int = 3) -> dict:
    V = version if version is not None else st.improver.latest_version()
    return st.improver.suggest(V, k=k)


def brain_context_markdown(st: State, version: int | None = None) -> str:
    V = version if version is not None else st.improver.latest_version()
    return st.improver.get_context(V)["markdown"]


# ── change path ──────────────────────────────────────────────

_attempt = {"n": 0}


def propose_edit(st: State, edits: dict[str, float] | list[dict], hypothesis: str, origin: str = "supervisor", habit_id: str | None = None,
                 round_: int = 0, base_version: int | None = None) -> dict:
    """record_proposal + evaluate on the training seeds, in one step (evaluate needs the Proposal object)."""
    imp = st.improver
    V = base_version if base_version is not None else imp.latest_version()
    org = {"source": "habit", "ref": habit_id} if habit_id else {"source": origin}
    _attempt["n"] += 1
    p = imp.record_proposal(V, edits, origin=org, round=round_, policy="supervisor", split="train", hypothesis=hypothesis, attempt=_attempt["n"])
    st.proposals[p.gate_run_id] = p
    st.bus.emit("proposal", gate_run_id=p.gate_run_id, status=p.status, edits=p.edits, hypothesis=hypothesis, base_version=V, locked=[e["target"] for e in p.locked_edits])
    if p.status == "invalid":
        return {"gate_run_id": p.gate_run_id, "status": "invalid", "reason": p.reason, "base_version": V}
    res = imp.evaluate(p)
    out = {"gate_run_id": p.gate_run_id, "status": p.status, "base_version": V, "edits": p.edits, "repeat": p.repeat,
           "locked_edits": p.locked_edits, "zones": res.get("zones"), "failures": res.get("failures"),
           "time_split": {z: v for z, v in (res.get("time_split") or {}).items()}, "verdict": res.get("verdict"), "reason": res.get("reason")}
    st.bus.emit("evaluated", gate_run_id=p.gate_run_id, zones=out["zones"], failures=out["failures"], repeat=p.repeat)
    return out


def run_gate(st: State, gate_run_id: str) -> dict:
    out = gate_rules.decide(st.gate, gate_run_id, st.cfg)
    st.bus.emit("verdict", gate_run_id=gate_run_id, **{k: out[k] for k in ("verdict", "reason", "heldout_passed")})
    return out


def commit_brain_version(st: State, gate_run_id: str, hypothesis: str | None = None) -> dict:
    out = st.gate.promote(gate_run_id, hypothesis)
    out["lineage"] = st.gate.lineage(out["version"])["markdown"]
    st.bus.emit("promoted", gate_run_id=gate_run_id, version=out["version"], added=out["added"], retired=out["retired"], approvals=out.get("approvals", []))
    return out


def save_preference(st: State, text: str, by: str = "Robotics Lead", ref: str | None = None) -> dict:
    out = st.gate.save_preference(text, by=by, ref=ref)
    st.bus.emit("preference", text=text, by=by, version=out["version"])
    return out


def record_approval(st: State, target: str, value: float, decision: str, by: str, ref: str | None) -> dict:
    out = st.gate.record_approval(target, value, decision, by=by, ref=ref)
    st.bus.emit("approval", target=target, value=value, decision=decision, by=by, ready=out["ready_to_promote"], rejected=out["rejected"])
    return out


# ── the human path: contract A ───────────────────────────────

def _envelope(st: State, target: str) -> dict:
    return st.improver.c("envelope").find_one({"_id": target}) or {}


def build_incident(st: State, gate_run_id: str, summary: str | None = None, questions: list[str] | None = None) -> dict:
    """An IncidentInput (gateway/src/shared/schemas.ts) for a gate run that needs the Robotics Lead's authority."""
    run = st.gate.c("gate_runs").find_one({"_id": gate_run_id})
    if run is None:
        raise KeyError(gate_run_id)
    now = datetime.now(timezone.utc).isoformat()
    locked = run.get("locked_edits") or []
    edits = run.get("edits") or []
    zones = run.get("zones") or {}
    best = max(zones, key=lambda z: zones[z]["delta"]) if zones else None
    worst_base = min(zones, key=lambda z: zones[z]["base"]) if zones else None
    moved = ", ".join(f"{z} {v['base']:.2f}→{v['cand']:.2f}" for z, v in sorted(zones.items()) if abs(v["delta"]) >= 0.005) or "no zone moved"
    fails = run.get("failures") or {}
    fixed = sorted(((v["base"] - v["cand"], t) for t, v in fails.items() if v["base"] > v["cand"]), reverse=True)
    signal = fixed[0][1] if fixed else None
    params = []
    changes = []
    for e in edits:
        env = _envelope(st, e["target"])
        params.append({"key": e["target"], "label": env.get("description") or e["target"], "unit": "m/s" if e["target"].endswith("max_speed") else ("m" if "PERC" in e["target"] else ""),
                       "type": "integer" if env.get("integer") else "number", "min": env.get("min"), "max": env.get("max"),
                       "current_value": e.get("base_value"), "proposed_value": e["value"]})
        changes.append({"op": "set_param", "key": e["target"], "value": e["value"]})
    edits_txt = "; ".join(f"{e['target']} {e.get('base_value')}→{e['value']}" for e in edits)
    plain = summary or (f"The fleet wants to change {len(locked)} locked setting{'s' if len(locked) != 1 else ''}: {edits_txt}. "
                        f"In the twin this moved {moved}." + (f" It cut {signal.replace('_', ' ').lower()} failures from {fails[signal]['base']} to {fails[signal]['cand']}." if signal else ""))
    incident_id = f"inc-{gate_run_id[3:15]}"
    event_id = f"evt-{hashlib.sha256(gate_run_id.encode()).hexdigest()[:16]}"
    body = {
        "schema_version": "1", "event_id": event_id, "incident_id": incident_id,
        "task_id": f"task:{worst_base or 'M'}:PICK:gate-{run['base_version']}", "robot_id": f"fleet:HUM-1",
        "timestamp": now, "severity": "HIGH", "category": "policy.locked_setting_change",
        "plain_summary": plain[:400],
        "observed_behavior": f"Brain v{run['base_version']} on {len(run['env']['seeds'])} training shifts: " + ", ".join(f"zone {z} {v['base']:.3f}" for z, v in sorted(zones.items())),
        "expected_behavior": "Improvements stay inside the settings the robot may change on its own; locked settings need the Robotics Lead.",
        "failure_summary": f"Gate run {gate_run_id}: candidate {edits_txt} changes a locked setting; measured effect {moved}; failures " + json.dumps({t: [v['base'], v['cand']] for t, v in fails.items()}),
        "root_cause_hypothesis": {"text": run.get("hypothesis") or "The proposed edit reduces the dominant failure type in the worst zone.", "confidence": 0.6},
        "evidence_refs": [{"id": f"ev:{gate_run_id}", "kind": "MEASURED", "summary": f"Gate run {gate_run_id} on training seeds {run['env']['seeds']}: {moved}", "source": "sitesim runner (deterministic twin)", "timestamp": now}],
        "metrics_refs": ["zone_scores", "failure_counts"],
        "proposal": {
            "proposal_id": f"prop-{gate_run_id[3:15]}", "revision": 1, "source_agent": "harness-supervisor", "risk": "HIGH",
            "summary": f"Set {edits_txt} (gate run {gate_run_id}).",
            "plain_summary": (f"Let the robots {'walk up to ' + str(edits[0]['value']) + ' metres per second' if edits and edits[0]['target'].endswith('max_speed') else 'change ' + edits_txt}; "
                              f"the twin says {best or 'the worst'} zone goes {zones[best]['base']:.2f} to {zones[best]['cand']:.2f}." if best else f"Change {edits_txt}.")[:400],
            "justification": f"Measured on {len(run['env']['seeds'])} deterministic training shifts: {moved}." + (f" {signal} failures {fails[signal]['base']}→{fails[signal]['cand']}." if signal else ""),
            "constraints": ["Locked settings change only with the Robotics Lead's approval.", "The gate re-checks the exact approved value on held-out shifts before promotion."],
            "affected_resources": ["envelope", *[f"zone:{z}" for z in zones]],
            "created_at": now, "changes": changes, "editable_parameters": params,
        },
        "responsible_supervisor": {"id": st.cfg.lead_id, "name": st.cfg.lead_name},
        "escalation": {"reason": "A locked setting needs authority the fleet does not have.", "requires_authority": True},
        "synthetic": False,
        "metadata": {"gate_run_id": gate_run_id, "brain_version": run["base_version"], "targets": [e["target"] for e in edits], "questions": questions or []},
    }
    return body


def call_robotics_lead(st: State, gate_run_id: str, summary: str | None = None, questions: list[str] | None = None) -> dict:
    """Contract A: POST the incident to the gateway, which phones the Robotics Lead. Returns {incident_id, duplicate}."""
    body = build_incident(st, gate_run_id, summary, questions)
    st.incidents[body["incident_id"]] = {"incident": body, "gate_run_id": gate_run_id, "revisions": [body["proposal"]], "decision": None}
    try:
        r = httpx.post(f"{st.cfg.gateway_url}/v1/incidents", json=body, headers={"authorization": f"Bearer {st.cfg.harness_token}"}, timeout=20)
        if r.status_code not in (200, 201):
            st.bus.emit("incident_failed", incident_id=body["incident_id"], status=r.status_code, body=r.text[:500])
            return {"incident_id": body["incident_id"], "error": f"gateway HTTP {r.status_code}: {r.text[:300]}", "gate_run_id": gate_run_id}
        out = r.json()
    except httpx.HTTPError as e:
        st.bus.emit("incident_failed", incident_id=body["incident_id"], error=str(e))
        return {"incident_id": body["incident_id"], "error": f"gateway unreachable: {e}", "gate_run_id": gate_run_id,
                "note": "the incident is recorded locally; approve it later via POST /feedback or the gateway dashboard"}
    st.bus.emit("incident", incident_id=body["incident_id"], gate_run_id=gate_run_id, duplicate=out.get("duplicate", False),
                plain_summary=body["plain_summary"], proposal_summary=body["proposal"]["plain_summary"],
                open_url=f"{st.cfg.gateway_web_url}/?incident={body['incident_id']}")
    return {**out, "gate_run_id": gate_run_id, "plain_summary": body["plain_summary"]}


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"
