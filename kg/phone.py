"""The phone bridge: after the gate decides, the Robotics Lead gets a call through the Intervention Gateway
(team repo branch aseel-eleven-lab, docs/HARNESS_CONTRACT.md).

Who does what in the loop:
  - TwinForge flags the failures: each shift's FailureEntry list (LIFT_QUEUE_JAM in zone M at tick t, robot R03)
    becomes one `episodes` document per failure in record_shifts().
  - The improver proposes the fix (Claude, suggest() or GEPA) and the gate decides it: record_verdict(), promote().
  - Right after the gate's decision, this module calls the Lead, for the significant decisions only:
      approval  verdict needs_approval: the fix passed on the numbers but changes a locked setting, so it can't
                land without the Lead; the call asks for the decision
      update    a promotion: the gate changed the brain (the harness). The call says what failed and what changed,
                and the Lead can keep it or object
    Rejected runs and runs that passed but were not promoted never ring the phone. A promotion that the Lead just
    approved on a call doesn't ring again.

Calls go out as POST /v1/incidents (contract A). The Lead's decision comes back through PhoneHarness (contract
B-F), served by `python -m kg phone-harness` for a gateway started with HARNESS_MODE=http. Like Raindrop, the
phone is never on the critical path: when the gateway is down, the KG logs a warning, keeps the incident in
`phone_calls` with status "unreachable", and the loop goes on.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import parse_qs, unquote, urlparse

from . import registry
from .ontology import FAILURE_GROUPS, failure_group_of

log = logging.getLogger("kg.phone")

COLLECTION = "phone_calls"
SCHEMA_VERSION = "1"
SOURCE_AGENT = "kg-gate"
SUPERVISOR_ID = "robotics-lead"
EPISODES_IN_CALL = 8

#: one-line descriptions of the failure types, from the concept ontology
FAILURE_TEXT = {t: d for g in FAILURE_GROUPS.values() for t, (d, _) in g["leaves"].items()}
#: what a failure type is called on the phone
FAILURE_SPOKEN = {
    "LIFT_QUEUE_JAM": "lift queue jams", "STAIR_QUEUE": "stairwell queues", "DEADLOCK_BACKOFF": "deadlock back-offs",
    "LATE_TASK": "late tasks", "DROPPED_DEMAND": "dropped tasks", "BATTERY_STRANDING": "battery strandings",
    "HUMAN_REPLAN": "reroutes around people",
}
#: failure groups that put a robot in trouble on the floor, not just slow work
SERIOUS_GROUPS = {"energy", "disruption"}


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(t: Optional[dt.datetime] = None) -> str:
    t = t or _now()
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.isoformat(timespec="milliseconds")


def _clip(text: str, n: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _num(v: Any) -> str:
    return f"{v:g}" if isinstance(v, (int, float)) else str(v)


def _lower_first(text: str) -> str:
    """'Top walking speed of HUM-1 robots' → 'top walking speed of HUM-1 robots' (acronyms stay)."""
    return text[:1].lower() + text[1:] if text[:2] and not text[:2].isupper() else text


#: settings whose registry description is a sentence, not a name
LABELS = {"sim.STAIR_MIN_LIFT_QUEUE": "Lift queue length that sends robots to the stairs",
          "sim.STAIR_MAX_LOAD": "Most load a robot may carry on the stairs"}


def setting_label(target: str) -> str:
    """A name for the setting: LABELS, else the registry's description without its trailing unit
    ('Top walking speed of HUM-1 robots')."""
    if target in LABELS:
        return LABELS[target]
    s = registry.by_target().get(target)
    text = s.description if s else target
    return re.sub(r"\s*\([^)]*\)\s*$", "", text) or target


def setting_unit(target: str) -> str:
    s = registry.by_target().get(target)
    m = re.search(r"\(([^)]*)\)\s*$", s.description) if s else None
    if m and len(m.group(1)) <= 8:
        return m.group(1)
    if s and s.description.lower().startswith("ticks"):
        return "ticks"
    return ""


def _stairs_when(q: float) -> str:
    return "never" if q >= 99 else "always" if q <= 0 else f"when {q:g} or more robots are waiting for the lift"


def _stairs_load(n: float) -> str:
    return "only when empty-handed" if n < 1 else f"carrying up to {n:g} load units"


def change_phrase(edit: dict) -> str:
    """One edit as it is said on the phone: 'the top walking speed of HUM-1 robots goes from 1.2 to 1.35 m/s'."""
    t, a, b = edit["target"], edit.get("base_value"), edit["value"]
    if t == "sim.STAIR_MIN_LIFT_QUEUE" and isinstance(a, (int, float)):
        return f"robots take the stairs {_stairs_when(b)} (before: {_stairs_when(a)})"
    if t == "sim.STAIR_MAX_LOAD" and isinstance(a, (int, float)):
        return f"robots use the stairs {_stairs_load(b)} (before: {_stairs_load(a)})"
    unit = setting_unit(t)
    return f"the {_lower_first(setting_label(t))} goes from {_num(a)} to {_num(b)}{(' ' + unit) if unit else ''}"


def headline_failure(run: dict) -> Optional[str]:
    """The failure type the change addresses: the biggest relative drop among types seen at least 5 times
    on the base brain (LIFT_QUEUE_JAM 16 → 6 beats LATE_TASK 133 → 120); else the most frequent type."""
    fails = run.get("failures") or {}
    dropped = [((v["base"] - v["cand"]) / v["base"], v["base"] - v["cand"], t) for t, v in fails.items()
               if v["base"] >= 5 and v["cand"] < v["base"]]
    if dropped:
        return max(dropped)[2]
    return max(fails, key=lambda t: fails[t]["base"], default=None)


def _episodes(kg, run: dict, ftype: Optional[str]) -> list[dict]:
    if not ftype or not (run.get("shift_ids") or {}).get("base"):
        return []
    return list(kg.c("episodes").find({"shift_id": {"$in": run["shift_ids"]["base"]}, "type": ftype},
                                      {"seed": 1, "tick": 1, "zone": 1, "robots": 1, "detail": 1, "task_id": 1})
                .sort([("seed", 1), ("tick", 1)]))


def is_significant(kind: str, run: dict) -> bool:
    """Which gate decisions ring the phone: every locked fix awaiting approval, every promotion."""
    if kind == "approval":
        return run.get("verdict") == "needs_approval"
    if kind == "update":
        return run.get("verdict") == "promoted"
    return False


def build_incident(kg, run: dict, kind: str, version: Optional[int] = None, lead: str = "Robotics Lead") -> dict:
    """The gateway's IncidentInput (src/shared/schemas.ts) for one gate run. Everything spoken comes from the
    KG's own numbers: the failure episodes TwinForge flagged on the base brain, and the gate's comparison."""
    gid, V = run["_id"], run["base_version"]
    zones = run.get("zones") or {}
    fails = run.get("failures") or {}
    seeds = len((run.get("env") or {}).get("seeds") or [])
    split = run.get("split", "train")
    ftype = headline_failure(run)
    eps = _episodes(kg, run, ftype)
    zc = Counter(e.get("zone") for e in eps if e.get("zone"))
    zone = zc.most_common(1)[0][0] if zc else (run.get("context") or {}).get("worst_zone")
    if zone is None and zones:
        zone = max(zones, key=lambda z: zones[z]["delta"])
    rc = Counter(r for e in eps for r in (e.get("robots") or []))
    robot = rc.most_common(1)[0][0] if rc else "fleet"
    task = next((e["task_id"] for e in eps if e.get("task_id")), None) or (f"zone:{zone}" if zone else "site:main")
    spoken = FAILURE_SPOKEN.get(ftype, (ftype or "failures").lower().replace("_", " "))
    fb, fc = (fails.get(ftype) or {}).get("base", 0), (fails.get(ftype) or {}).get("cand", 0)
    zm = zones.get(zone) or {}
    better = sorted((z for z, v in zones.items() if v["delta"] > 0), key=lambda z: -zones[z]["delta"])
    worse = sorted((z for z, v in zones.items() if v["delta"] < 0), key=lambda z: zones[z]["delta"])
    rose = [t for t, v in fails.items() if v["cand"] > v["base"]]

    edits = run.get("edits") or []
    locked = {e["target"] for e in run.get("locked_edits") or []}
    change_words = "; ".join(change_phrase(e) for e in edits) or "no setting changes"
    where = f" in zone {zone}" if zone else ""
    moved = f"{spoken} went from {fb} to {fc}" if fb != fc else f"{spoken} stayed at {fb}"
    if not zm:
        gain = "the scores didn't move"
    elif abs(zm["delta"]) < 5e-4:
        gain = f"zone {zone}'s score didn't change ({zm['base']:.3f})"
    else:
        gain = f"zone {zone}'s score went from {zm['base']:.3f} to {zm['cand']:.3f}"

    if kind == "approval":
        plain_inc = (f"In the warehouse twin, robots on brain version {V} hit {fb} {spoken}{where} across {seeds} test "
                     f"shifts. The gate found a fix, but it changes a locked safety setting.")
        plain_prop = (f"{change_words[:1].upper()}{change_words[1:]}. In the twin, {moved} and {gain}. "
                      f"It can't go live without your approval.")
        severity, risk = "HIGH", "HIGH"
        escalation = {"reason": f"The fix changes a locked setting ({', '.join(sorted(locked)) or 'locked'}); only the "
                                f"Robotics Lead can approve a locked setting.", "requires_authority": True}
        category = "harness.locked_change_needs_approval"
    else:
        plain_inc = (f"The gate just changed the robots' brain to version {version}. On version {V}, robots hit {fb} "
                     f"{spoken}{where} across {seeds} test shifts.")
        plain_prop = (f"It is already live: {change_words}. In the twin, {moved} and {gain}. "
                      f"Approve to keep it, or reject and tell me why.")
        severity, risk = "MEDIUM", "LOW"
        escalation = {"reason": "The harness changed the robots' brain; the Robotics Lead hears about every change.",
                      "requires_authority": False}
        category = "harness.brain_updated"
    if failure_group_of(ftype or "") in SERIOUS_GROUPS:
        severity = "HIGH"

    observed = (f"On brain v{V} ({seeds} {split} seeds): " + ", ".join(
        f"{t} {v['base']}" for t, v in sorted(fails.items(), key=lambda kv: -kv[1]["base"])) + ". "
        + (f"Example: seed {eps[0]['seed']} tick {eps[0]['tick']}, {eps[0].get('detail') or ftype}." if eps else ""))
    tradeoffs = []
    if worse:
        tradeoffs.append("zones " + ", ".join(f"{z} {zones[z]['delta']:+.3f}" for z in worse) + " got slightly worse")
    if rose:
        tradeoffs.append(", ".join(f"{t} rose {fails[t]['base']} to {fails[t]['cand']}" for t in rose))
    justification = (f"Gate run {gid} on the {split} seeds: " + ", ".join(
        f"zone {z} {zones[z]['base']:.3f}→{zones[z]['cand']:.3f}" for z in better) + ". "
        + (f"Trade-offs: {'; '.join(tradeoffs)}. " if tradeoffs else "")
        + f"Gate's reason: {run.get('reason') or 'n/a'}.")
    confidence = (zm["seeds_better"] / seeds) if zm and seeds else None

    params = []
    for e in edits:
        s = registry.by_target().get(e["target"])
        params.append({"key": e["target"], "label": setting_label(e["target"]), "unit": setting_unit(e["target"]),
                       "type": "integer" if (s is None or s.integer) else "number",
                       **({"min": s.min, "max": s.max} if s else {}),
                       "current_value": e.get("base_value") if e.get("base_value") is not None else "unset",
                       "proposed_value": e["value"]})
    t = _iso()
    evidence = [{"id": f"ep:{i + 1}", "kind": "MEASURED", "source": "TwinForge twin, kg.episodes", "timestamp": t,
                 "summary": _clip(f"{ftype} on seed {e['seed']} at tick {e['tick']}"
                                  f"{(' in zone ' + e['zone']) if e.get('zone') else ''}"
                                  f"{(', robots ' + ', '.join(e['robots'])) if e.get('robots') else ''}: "
                                  f"{e.get('detail') or FAILURE_TEXT.get(ftype, '')}", 2000)}
                for i, e in enumerate(eps[:EPISODES_IN_CALL])]
    evidence.append({"id": "gate:1", "kind": "MEASURED", "source": f"kg.gate_runs {gid}", "timestamp": t,
                     "summary": _clip(justification, 2000)})
    tag = "approval" if kind == "approval" else "update"
    return {
        "schema_version": SCHEMA_VERSION,
        "event_id": f"kg:{tag}:{gid}",
        "incident_id": f"kg-{tag}-{gid}",
        "task_id": task, "robot_id": robot, "timestamp": t, "severity": severity, "category": category,
        "plain_summary": _clip(plain_inc, 400),
        "observed_behavior": _clip(observed, 4000),
        "expected_behavior": _clip(f"Fewer {spoken} without making ordinary shifts worse. "
                                   f"{FAILURE_TEXT.get(ftype, '')}", 4000),
        "failure_summary": _clip(f"{ftype}: {fb} on v{V} → {fc} with {change_words} ({split} seeds, gate run {gid}).",
                                 4000),
        "root_cause_hypothesis": {"text": _clip(run.get("hypothesis") or run.get("reason") or "not stated", 4000),
                                  **({"confidence": round(confidence, 2)} if confidence is not None else {})},
        "evidence_refs": evidence,
        "metrics_refs": [f"zone.{z}.score" for z in zones] + [f"failures.{t_}" for t_ in fails],
        "proposal": {
            "proposal_id": f"kg-{tag}-{gid}", "revision": 1, "source_agent": SOURCE_AGENT, "risk": risk,
            "plain_summary": _clip(plain_prop, 400),
            "summary": _clip("; ".join(f"set {e['target']} = {_num(e['value'])} (was {_num(e.get('base_value'))})"
                                       for e in edits) or "no setting change", 2000),
            "justification": _clip(justification, 4000),
            "constraints": ["Only the tested value can be approved on this call."] if kind == "approval" else
                           ["This change is already live; rejecting it records the objection for the improver."],
            "affected_resources": [f"zone:{z}" for z in better + worse] or ["site:main"],
            "created_at": t,
            "changes": [{"op": "set_param", "key": e["target"], "value": e["value"],
                         **({"unit": setting_unit(e["target"])} if setting_unit(e["target"]) else {})} for e in edits],
            "editable_parameters": params,
        },
        "responsible_supervisor": {"id": SUPERVISOR_ID, "name": lead},
        "escalation": escalation,
        "synthetic": True,  # measured in the digital twin, not on real robots
        "metadata": {"kg_gate_run_id": gid, "kg_kind": tag, "kg_base_version": V, "kg_version": version,
                     "kg_db": kg.db.name, "kg_failure_type": ftype},
    }


class NullPhone:
    """No gateway configured: the gate never calls anyone."""
    enabled = False

    def after_verdict(self, kg, gate_run_id: str) -> Optional[dict]:
        return None

    def after_promote(self, kg, gate_run_id: str, version: int) -> Optional[dict]:
        return None


class GatewayPhone:
    """Places calls through the Intervention Gateway. Each incident is kept in `phone_calls` (the gateway dedupes
    on event_id too), so a retried verdict never calls twice and the harness side can find the gate run again."""
    enabled = True

    def __init__(self, url: str, token: str, lead: str = "Robotics Lead", client=None, timeout: float = 5.0):
        self.url, self.token, self.lead, self.timeout = url.rstrip("/"), token, lead, timeout
        self._client = client

    @property
    def client(self):
        if self._client is None:
            import httpx
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def after_verdict(self, kg, gate_run_id: str) -> Optional[dict]:
        run = kg.c("gate_runs").find_one({"_id": gate_run_id})
        if run is None or not is_significant("approval", run):
            return None
        return self.place(kg, run, "approval")

    def after_promote(self, kg, gate_run_id: str, version: int) -> Optional[dict]:
        run = kg.c("gate_runs").find_one({"_id": gate_run_id})
        if run is None or not is_significant("update", run):
            return None
        if kg.c(COLLECTION).find_one({"gate_run_id": gate_run_id, "kind": "approval"}, {"_id": 1}):
            return None  # the Lead approved this exact change on a call a moment ago
        return self.place(kg, run, "update", version=version)

    def place(self, kg, run: dict, kind: str, version: Optional[int] = None) -> dict:
        """Never raises: a phone problem must not undo or block a gate decision."""
        inc_id = None
        try:
            inc = build_incident(kg, run, kind, version, lead=self.lead)
            inc_id = inc["incident_id"]
            have = kg.c(COLLECTION).find_one({"_id": inc_id}, {"status": 1})
            if have and have.get("status") in ("posted", "duplicate") or (have or {}).get("decisions"):
                return {"incident_id": inc_id, "status": "already_called"}
            kg.c(COLLECTION).update_one({"_id": inc_id}, {
                "$set": {"incident": inc, "status": "posting", "updated_at": _now()},
                "$setOnInsert": {"gate_run_id": run["_id"], "kind": kind, "version": version,
                                 "base_version": run["base_version"], "created_at": _now()}}, upsert=True)
            r = self.client.post(f"{self.url}/v1/incidents", json=inc,
                                 headers={"authorization": f"Bearer {self.token}"})
            if r.status_code in (200, 201):
                status = "duplicate" if (r.json() or {}).get("duplicate") else "posted"
                kg.c(COLLECTION).update_one({"_id": inc_id}, {"$set": {"status": status, "posted_at": _now()}})
                log.info("phone: %s call for %s placed (%s)", kind, run["_id"], inc_id)
                return {"incident_id": inc_id, "status": status}
            err = f"HTTP {r.status_code}: {r.text[:500]}"
            kg.c(COLLECTION).update_one({"_id": inc_id}, {"$set": {"status": "refused", "error": err}})
            log.warning("phone: the gateway refused the %s call for %s: %s", kind, run["_id"], err)
            return {"incident_id": inc_id, "status": "refused", "error": err}
        except Exception as e:  # noqa: BLE001 - never on the critical path
            log.warning("phone: could not place the %s call for %s: %s", kind, run.get("_id"), e)
            if inc_id:
                try:
                    kg.c(COLLECTION).update_one({"_id": inc_id}, {"$set": {"status": "unreachable", "error": str(e)[:500]}})
                except Exception:  # noqa: BLE001
                    pass
            return {"incident_id": inc_id, "status": "unreachable", "error": str(e)}


def phone_from_config(cfg) -> NullPhone | GatewayPhone:
    if cfg.gateway_url and cfg.phone_enabled:
        if not cfg.gateway_token:
            log.warning("phone: KG_GATEWAY_URL is set but KG_GATEWAY_TOKEN is not; the gateway will refuse the calls")
        return GatewayPhone(cfg.gateway_url, cfg.gateway_token or "", lead=cfg.phone_lead)
    return NullPhone()


# ── the harness side of the call (contract B-F) ──────────────────────────────


class PhoneHarness:
    """What the gateway asks the harness during and after a call. Answers come from the KG's own records; the one
    write is the Lead's feedback: an approval goes to record_approval and then promote(), a rejection blocks that
    value, and the Lead's words on a rejection or deferral become a preference in the brain."""

    def __init__(self, kg, lead: str = "Robotics Lead"):
        kg._require_gate("the phone harness (it records approvals and promotes)")
        self.kg, self.lead = kg, lead

    def _call(self, incident_id: str) -> Optional[dict]:
        return self.kg.c(COLLECTION).find_one({"_id": incident_id})

    def _run(self, call: dict) -> dict:
        return self.kg.c("gate_runs").find_one({"_id": call["gate_run_id"]}) or {}

    def question(self, body: dict) -> dict:
        call = self._call(body.get("incident_id", ""))
        if call is None:
            return {"status": "UNAVAILABLE", "evidence_refs": [], "limitations": "The knowledge graph has no record of this call."}
        run = self._run(call)
        ftype = headline_failure(run)
        eps = _episodes(self.kg, run, ftype)
        lines = [f"From the knowledge graph (all measured in the twin, gate run {run.get('_id')}, "
                 f"{run.get('split')} seeds, brain v{run.get('base_version')} vs the change):"]
        zones = run.get("zones") or {}
        same = [z for z, v in sorted(zones.items()) if not v["seeds_better"] and not v["seeds_worse"]]
        for z, v in sorted(zones.items()):
            if z not in same:
                lines.append(f"zone {z}: {v['base']:.3f} → {v['cand']:.3f} ({v['delta']:+.3f}; "
                             f"{v['seeds_better']} seeds better, {v['seeds_worse']} worse)")
        if same:
            lines.append(f"zones {', '.join(same)}: no change on any seed")
        for t, v in sorted((run.get("failures") or {}).items(), key=lambda kv: -kv[1]["base"]):
            lines.append(f"{t} ({FAILURE_TEXT.get(t, t)}): {v['base']} → {v['cand']}"
                         + (" (unchanged)" if v["base"] == v["cand"] else ""))
        for z, o in sorted((run.get("outcomes") or {}).items()):
            b, c = o.get("base") or {}, o.get("cand") or {}
            if (b.get("late"), b.get("dropped")) != (c.get("late"), c.get("dropped")):
                lines.append(f"zone {z} late/dropped tasks: {b.get('late', 0)}/{b.get('dropped', 0)} → "
                             f"{c.get('late', 0)}/{c.get('dropped', 0)}")
        if eps:
            lines.append(f"{len(eps)} {ftype} episodes on the base brain; the first ones:")
            lines += [f"seed {e['seed']} tick {e['tick']}{(' zone ' + e['zone']) if e.get('zone') else ''}: "
                      f"{e.get('detail') or ''}" for e in eps[:EPISODES_IN_CALL]]
        if run.get("hypothesis"):
            lines.append(f"The improver's hypothesis: {run['hypothesis']}")
        lines.append(f"The gate's reason: {run.get('reason')}")
        return {"status": "ANSWERED", "answer": _clip("\n".join(lines), 6000), "evidence_refs": ["gate:1"],
                "limitations": "Numbers only: the knowledge graph can't explain causes beyond the improver's hypothesis."}

    def metrics(self, incident_id: str, keys: Optional[list[str]] = None) -> Optional[dict]:
        call = self._call(incident_id)
        if call is None:
            return None
        run, t = self._run(call), _iso()
        src = f"kg.gate_runs {call['gate_run_id']}"
        out = []
        for z, v in sorted((run.get("zones") or {}).items()):
            out.append({"key": f"zone.{z}.score", "label": f"Zone {z} score", "value": v["cand"], "unit": "",
                        "kind": "MEASURED", "timestamp": t, "source": src, "expected": v["base"],
                        "history": [{"label": f"v{run['base_version']}", "value": v["base"], "timestamp": t},
                                    {"label": "with the change", "value": v["cand"], "timestamp": t}],
                        "note": f"{v['seeds_better']} seeds better, {v['seeds_worse']} worse"})
        for f, v in sorted((run.get("failures") or {}).items()):
            out.append({"key": f"failures.{f}", "label": FAILURE_SPOKEN.get(f, f).capitalize(), "value": v["cand"],
                        "unit": "", "kind": "MEASURED", "timestamp": t, "source": src, "expected": v["base"],
                        "history": [{"label": f"v{run['base_version']}", "value": v["base"], "timestamp": t},
                                    {"label": "with the change", "value": v["cand"], "timestamp": t}]})
        if keys:
            want = [k.lower() for k in keys]
            out = [m for m in out if any(k in m["key"].lower() or k in m["label"].lower() for k in want)]
        return {"metrics": out}

    def revise(self, proposal_id: str, body: dict) -> dict:
        return {"accepted": False, "reason": (
            "That value hasn't been tested in the twin, so I can't make it the plan on this call. I can approve or "
            "reject the tested value. If you reject it and tell me the value you want, I'll save that as your "
            "instruction for the improver.")}

    def feedback(self, body: dict, idempotency_key: Optional[str] = None) -> dict:
        key = idempotency_key or body.get("idempotency_key") or body.get("feedback_id")
        call = self._call(body.get("incident_id", ""))
        if call is None:
            return {"accepted": False, "reason": "The knowledge graph has no record of this call."}
        prior = next((d for d in call.get("decisions") or [] if d.get("key") == key), None)
        if prior:
            return prior["ack"]
        claim = self.kg.c(COLLECTION).update_one({"_id": call["_id"], "feedback_keys": {"$ne": key}},
                                                 {"$addToSet": {"feedback_keys": key}})
        if not claim.modified_count:
            return {"accepted": True, "reason": "Feedback already received."}
        try:
            ack, extra = self._apply(call, body)
        except Exception:
            self.kg.c(COLLECTION).update_one({"_id": call["_id"]}, {"$pull": {"feedback_keys": key}})
            raise
        decision = body.get("decision")
        self.kg.c(COLLECTION).update_one({"_id": call["_id"]}, {
            "$set": {"status": decision.lower() if decision else "decided", "decided_at": _now()},
            "$push": {"decisions": {"key": key, "decision": decision, "feedback": body.get("feedback"),
                                    "revision": body.get("revision"), "channel": body.get("channel"),
                                    "ack": ack, **extra, "at": _now()}}})
        return ack

    def _apply(self, call: dict, body: dict) -> tuple[dict, dict]:
        from .core import KGError, NeedsApproval, StalePromotion
        kg, run = self.kg, self._run(call)
        decision, words = body.get("decision"), (body.get("feedback") or "").strip()
        ref, extra = f"call:{call['_id']}", {}
        changes = [c for c in ((body.get("proposal") or {}).get("changes") or []) if c.get("op") == "set_param"]
        locked = {e["target"] for e in run.get("locked_edits") or []}
        if call["kind"] == "approval":
            if decision in ("APPROVE", "REJECT"):
                verb = "approve" if decision == "APPROVE" else "reject"
                ready: set[str] = set()
                for c in changes:
                    if c["key"] in locked:
                        r = kg.record_approval(c["key"], float(c["value"]), verb, by=self.lead, ref=ref)
                        ready.update(r["ready_to_promote"])
                if decision == "APPROVE":
                    if run.get("verdict") == "promoted":
                        msg = f"Approval recorded. The change is already live as version {run.get('promoted_to')}."
                    elif run["_id"] not in ready:
                        msg = "Approval recorded, but the change isn't promotable yet."
                    else:
                        try:
                            v = kg.promote(run["_id"], hypothesis=run.get("hypothesis"))
                            extra["promoted_to"] = v["version"]
                            msg = f"Approved. The robots' brain is now version {v['version']}."
                        except (StalePromotion, NeedsApproval, KGError) as e:
                            extra["promote_error"] = str(e)
                            msg = f"Approval recorded, but promotion was refused: {e}"
                else:
                    msg = "Declined. The gate won't try that value again."
            else:
                msg = "Deferred. The change stays pending until you decide."
        else:
            v = call.get("version")
            msg = {"APPROVE": f"Thanks. Version {v} stays live.",
                   "REJECT": f"Objection recorded against version {v}.",
                   }.get(decision, f"Noted. Version {v} stays live; you can decide later.")
        if words and decision in ("REJECT", "DEFER"):
            p = kg.save_preference(words, by=self.lead, ref=ref)
            extra["preference_version"] = p["version"]
            msg += " Your words are saved as an instruction in the brain."
        return {"accepted": True, "reason": msg}, extra


def make_server(harness: PhoneHarness, host: str = "127.0.0.1", port: int = 8799,
                token: Optional[str] = None) -> ThreadingHTTPServer:
    """The HTTP form of PhoneHarness for HARNESS_MODE=http (HARNESS_BASE_URL=http://host:port)."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quieter than stderr per request
            log.info("phone-harness %s", fmt % args)

        def _send(self, code: int, obj: Any = None):
            data = json.dumps(obj if obj is not None else {}, default=str).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            if not token:
                return True
            if self.headers.get("authorization", "") == f"Bearer {token}":
                return True
            self._send(401, {"error": "unauthorized"})
            return False

        def _body(self) -> dict:
            n = int(self.headers.get("content-length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/health":
                return self._send(200, {"ok": True, "db": harness.kg.db.name})
            if not self._authorized():
                return
            m = re.fullmatch(r"/incidents/([^/]+)/(trajectory|metrics)", u.path)
            if not m:
                return self._send(404, {"error": "not found"})
            inc, what = unquote(m.group(1)), m.group(2)
            if what == "trajectory":
                return self._send(404, {"error": "no trajectory for this incident"})
            keys = [k for k in (parse_qs(u.query).get("keys") or [""])[0].split(",") if k]
            out = harness.metrics(inc, keys)
            return self._send(200, out) if out is not None else self._send(404, {"error": "unknown incident"})

        def do_POST(self):
            u = urlparse(self.path)
            if not self._authorized():
                return
            try:
                body = self._body()
                if u.path == "/supervisor/questions":
                    return self._send(200, harness.question(body))
                if u.path == "/feedback":
                    return self._send(200, harness.feedback(body, self.headers.get("idempotency-key")))
                m = re.fullmatch(r"/proposals/([^/]+)/revisions", u.path)
                if m:
                    return self._send(200, harness.revise(unquote(m.group(1)), body))
                return self._send(404, {"error": "not found"})
            except Exception as e:  # noqa: BLE001 - the gateway retries feedback on a 5xx
                log.exception("phone-harness %s failed", u.path)
                return self._send(500, {"error": str(e)[:500]})

    return ThreadingHTTPServer((host, port), Handler)
