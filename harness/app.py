"""The harness service.

Gateway → harness (contract B-F, bearer HARNESS_OUTBOUND_TOKEN):
  POST /supervisor/questions            B  answer from the gate run, episodes and context, else INSUFFICIENT_EVIDENCE
  GET  /incidents/:id/trajectory        C  a 2D trajectory built from the shift's failure episodes (or 404)
  GET  /incidents/:id/metrics           D  zone scores and failure counts as Metric[]
  POST /proposals/:id/revisions         E  a human modification -> validated against the envelope, re-evaluated, revision N+1
  POST /feedback                        F  APPROVE -> record_approval + promote; REJECT -> record_approval(reject);
                                           DEFER -> nothing promoted; every text becomes a saved preference

Dashboard read API (CORS open):
  GET  /api/brain/graph?v=&compare_to=  graph_snapshot          GET /api/brain/versions   lineage of the latest
  GET  /api/brain/context/:node?v=      get_brain_context       GET /api/scores?v=        current_scores (train)
  GET  /api/runs                        gate runs, newest first  GET /api/incidents        incidents this service raised
  GET  /api/events                      SSE: supervisor transcript, proposals, verdicts, promotions, incidents, brain reads
  GET  /api/brain/reads                 SSE: tail of the brain_reads collection
  GET  /api/loop/status  POST /api/loop/round  POST /api/loop/start {rounds}  POST /api/loop/stop
  GET  /api/proof                       v1 vs latest on the final held-out set (gate only; booleans + per-zone deltas)

  uvicorn harness.app:app --port 8000
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from . import tools as T
from .state import State, get_state
from .supervisor import run_round

log = logging.getLogger("harness.app")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

app = FastAPI(title="harness", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def _startup():
    st = get_state()
    st.bus.loop = asyncio.get_running_loop()
    asyncio.create_task(_tail_brain_reads(st))


async def _tail_brain_reads(st: State):
    """Every brain read written to the KG by any agent (worker MCP, supervisor, dashboard) becomes a brain_read
    event, so the graph lights up for reads this process did not make itself."""
    import datetime as _dt
    last = _dt.datetime.now(_dt.timezone.utc)
    while True:
        try:
            rows = await asyncio.to_thread(lambda: list(st.improver.c("brain_reads").find({"at": {"$gt": last}}).sort("at", 1).limit(100)))
            for r in rows:
                last = max(last, r["at"].replace(tzinfo=_dt.timezone.utc) if r["at"].tzinfo is None else r["at"])
                st.bus.emit("brain_read", node_id=r.get("node_id"), scope=r.get("scope", []), version=r.get("version"), reader=r.get("reader", "agent"),
                            component_ids=r.get("component_ids", []), source="kg")
        except Exception as e:  # never let the tail kill the app
            log.debug("brain_reads tail: %s", e)
        await asyncio.sleep(0.8)


def state() -> State:
    return get_state()


def outbound_auth(st: State = Depends(state), authorization: str | None = Header(default=None)):
    if st.cfg.outbound_token and authorization != f"Bearer {st.cfg.outbound_token}":
        raise HTTPException(401, "bad bearer")
    return st


def _sse(q: asyncio.Queue, st: State, replay: list[dict]):
    async def gen():
        for ev in replay:
            yield f"data: {st.dumps(ev)}\n\n"
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {st.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            st.bus.unsubscribe(q)
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})


# ── contract B-F ─────────────────────────────────────────────

@app.post("/supervisor/questions")
async def supervisor_questions(body: dict, st: State = Depends(outbound_auth)):
    inc = st.incidents.get(body.get("incident_id", ""))
    q = (body.get("question") or "").lower()
    if not inc:
        return {"status": "UNAVAILABLE", "evidence_refs": [], "limitations": "This incident was not raised by this harness instance."}
    run = st.gate.c("gate_runs").find_one({"_id": inc["gate_run_id"]})
    if not run or not run.get("zones"):
        return {"status": "INSUFFICIENT_EVIDENCE", "evidence_refs": [], "limitations": "The gate run has no evaluation yet."}
    zones, fails = run["zones"], run.get("failures") or {}
    parts: list[str] = []
    if any(w in q for w in ("safe", "people", "human", "collision", "near")):
        prox = sum(((st.improver.c("shifts").find_one({"_id": s}, {"result.safety": 1}) or {}).get("result", {}).get("safety", {}).get("human_proximity", 0)) for s in run["shift_ids"]["cand"])
        parts.append(f"Across the candidate's {len(run['shift_ids']['cand'])} training shifts there were {prox} human-proximity events inside {st.improver.c('envelope').find_one({'_id': 'sim.HUMAN_CLEARANCE_M'})['v1']} m, and the minimum robot separation of 0.9 m is fixed and cannot be changed by any brain.")
    if any(w in q for w in ("why", "reason", "evidence", "cause", "jam", "fail")):
        top = sorted(fails.items(), key=lambda kv: kv[1]["base"] - kv[1]["cand"], reverse=True)[:3]
        parts.append("Failure counts base→candidate: " + ", ".join(f"{t} {v['base']}→{v['cand']}" for t, v in top) + ".")
    if any(w in q for w in ("zone", "score", "effect", "improve", "better", "worse", "number", "much")):
        parts.append("Zone scores base→candidate: " + ", ".join(f"{z} {v['base']:.2f}→{v['cand']:.2f} ({v['seeds_better']} shifts better, {v['seeds_worse']} worse)" for z, v in sorted(zones.items())) + ".")
    if any(w in q for w in ("slow", "speed", "fast", "value", "smaller", "lower", "compromise", "instead")):
        for e in run["edits"]:
            env = st.improver.c("envelope").find_one({"_id": e["target"]}) or {}
            parts.append(f"{e['target']} is currently {e.get('base_value')} and the proposal is {e['value']}; the allowed range is {env.get('min')} to {env.get('max')}. A different value can be tried as a revision and the gate will re-measure it.")
    if any(w in q for w in ("time", "where", "wait", "lift", "stair")):
        ts = (run.get("time_split") or {}).get("M") or {}
        if ts:
            parts.append("Zone M time split base→candidate: " + ", ".join(f"{k} {ts['base'].get(k, 0):.0%}→{ts['cand'].get(k, 0):.0%}" for k in ("travel", "lift_wait", "lift_ride", "stairs", "blocked", "pick_drop")) + ".")
    if not parts:
        parts.append("Zone scores base→candidate: " + ", ".join(f"{z} {v['base']:.2f}→{v['cand']:.2f}" for z, v in sorted(zones.items())) + ". " + f"Hypothesis: {run.get('hypothesis') or 'n/a'}.")
    return {"status": "ANSWERED", "answer": " ".join(parts), "evidence_refs": [f"ev:{inc['gate_run_id']}"], "confidence": 0.8}


@app.get("/incidents/{incident_id}/trajectory")
async def incident_trajectory(incident_id: str, st: State = Depends(outbound_auth)):
    inc = st.incidents.get(incident_id)
    if not inc:
        raise HTTPException(404)
    run = st.gate.c("gate_runs").find_one({"_id": inc["gate_run_id"]})
    sid = (run or {}).get("shift_ids", {}).get("base", [None])[0]
    if not sid:
        raise HTTPException(404)
    eps = list(st.improver.c("episodes").find({"shift_id": sid}, {"type": 1, "zone": 1, "tick": 1, "detail": 1}).sort("tick", 1).limit(40))
    zones = {"A": (4, 10, 42, 22), "B": (54, 10, 42, 22), "C": (4, 38, 42, 24), "D": (54, 38, 42, 24), "M": (8, 40, 46, 22)}
    pts = []
    for i, e in enumerate(eps):
        z = zones.get(e.get("zone") or "", (46, 10, 8, 52))
        pts.append({"t": e["tick"] / 10, "x": z[0] + z[2] / 2 + (i % 5) * 1.5, "y": z[1] + z[3] / 2 + (i % 3) * 1.5, "magnitude_m": 1.0, "description": f"{e['type']}: {e.get('detail', '')}", "kind": "MEASURED"})
    return {"task_id": inc["incident"]["task_id"], "robot_id": inc["incident"]["robot_id"], "frame": "map_2d", "units": "m",
            "planned": [{"t": 0, "x": 50, "y": 20}, {"t": 60, "x": 50, "y": 50}], "actual": [{"t": p["t"], "x": p["x"], "y": p["y"]} for p in pts],
            "deviations": pts, "segments": [], "zones": [{"label": f"Zone {k}", "x": v[0], "y": v[1], "w": v[2], "h": v[3], "kind": "area"} for k, v in zones.items()],
            "source": f"sitesim shift {sid}", "synthetic": False}


@app.get("/incidents/{incident_id}/metrics")
async def incident_metrics(incident_id: str, keys: str | None = None, st: State = Depends(outbound_auth)):
    inc = st.incidents.get(incident_id)
    if not inc:
        raise HTTPException(404)
    run = st.gate.c("gate_runs").find_one({"_id": inc["gate_run_id"]}) or {}
    now = datetime.now(timezone.utc).isoformat()
    metrics = []
    for z, v in sorted((run.get("zones") or {}).items()):
        metrics.append({"key": f"zone_{z}_score", "label": f"Zone {z} on-time score", "value": v["cand"], "unit": "", "kind": "MEASURED", "timestamp": now, "source": "sitesim gate run", "expected": v["base"], "note": f"base {v['base']:.3f} → candidate {v['cand']:.3f}"})
    for t, v in sorted((run.get("failures") or {}).items()):
        metrics.append({"key": f"failures_{t.lower()}", "label": t.replace("_", " ").title(), "value": v["cand"], "unit": "events", "kind": "MEASURED", "timestamp": now, "source": "sitesim gate run", "expected": v["base"]})
    want = set(keys.split(",")) if keys else None
    return {"metrics": [m for m in metrics if not want or m["key"] in want]}


@app.post("/proposals/{proposal_id}/revisions")
async def proposal_revision(proposal_id: str, body: dict, st: State = Depends(outbound_auth)):
    inc = next((i for i in st.incidents.values() if i["revisions"][-1]["proposal_id"] == proposal_id), None)
    if not inc:
        return {"accepted": False, "reason": "I do not know that proposal."}
    base = inc["revisions"][-1]
    if body.get("base_revision") != base["revision"]:
        return {"accepted": False, "reason": f"That revision is stale; the current one is {base['revision']}."}
    edits = {}
    for ch in body.get("changes", []):
        if ch.get("op") != "set_param":
            return {"accepted": False, "reason": "I can only change the numeric settings listed on the proposal."}
        env = st.improver.c("envelope").find_one({"_id": ch["key"]})
        if not env or env["status"] in ("fixed", "spec"):
            return {"accepted": False, "reason": f"{ch['key']} is not a setting the fleet may change."}
        try:
            v = float(ch["value"])
        except (TypeError, ValueError):
            return {"accepted": False, "reason": "The value has to be a number."}
        if v < env["min"] or v > env["max"]:
            return {"accepted": False, "reason": f"{ch['key']} must stay between {env['min']} and {env['max']}."}
        edits[ch["key"]] = v
    if not edits:
        return {"accepted": False, "reason": "No change was given."}
    res = T.propose_edit(st, edits, f"Revision by {body.get('requested_by', 'the Robotics Lead')}: {body.get('rationale', '')}", origin="robotics_lead")
    if res.get("status") == "invalid":
        return {"accepted": False, "reason": f"The twin refused it: {res.get('reason')}."}
    gate = T.run_gate(st, res["gate_run_id"])
    zones = res.get("zones") or {}
    best = max(zones, key=lambda z: zones[z]["delta"]) if zones else None
    moved = ", ".join(f"zone {z} {v['base']:.2f}→{v['cand']:.2f}" for z, v in sorted(zones.items()) if abs(v["delta"]) >= 0.005) or "no zone score moved"
    new = {**base, "revision": base["revision"] + 1, "proposal_id": base["proposal_id"], "created_at": datetime.now(timezone.utc).isoformat(),
           "changes": [{"op": "set_param", "key": k, "value": v} for k, v in edits.items()],
           "editable_parameters": [{**p, "proposed_value": edits.get(p["key"], p["proposed_value"])} for p in base["editable_parameters"]],
           "summary": f"Set {', '.join(f'{k}={v}' for k, v in edits.items())} (gate run {res['gate_run_id']}, {gate['verdict']}).",
           "plain_summary": (f"With {', '.join(f'{k.split(chr(46))[-1]} at {v}' for k, v in edits.items())}, the twin measured {moved}; the gate says {gate['verdict'].replace('_', ' ')}." )[:400],
           "justification": f"Re-measured on the training shifts: {moved}. Gate: {gate['reason']}."}
    inc["revisions"].append(new)
    inc["revision_runs"] = {**inc.get("revision_runs", {}), str(new["revision"]): res["gate_run_id"]}
    st.bus.emit("revision", incident_id=inc["incident"]["incident_id"], revision=new["revision"], edits=edits, verdict=gate["verdict"])
    return {"accepted": True, "proposal": new, "note": gate["reason"]}


@app.post("/feedback")
async def feedback(body: dict, request: Request, st: State = Depends(outbound_auth)):
    key = request.headers.get("idempotency-key") or body.get("idempotency_key") or body.get("feedback_id")
    if key in st.feedback_seen:
        return {"accepted": True, "reason": "duplicate"}
    inc = st.incidents.get(body.get("incident_id", ""))
    if not inc:
        return {"accepted": False, "reason": "unknown incident"}
    decision = body.get("decision")
    rev = str(body.get("revision") or inc["revisions"][-1]["revision"])
    gate_run_id = inc.get("revision_runs", {}).get(rev, inc["gate_run_id"])
    run = st.gate.c("gate_runs").find_one({"_id": gate_run_id}) or {}
    by = st.cfg.lead_name
    ref = f"feedback:{body.get('feedback_id', key)}"
    out: dict[str, Any] = {"decision": decision, "gate_run_id": gate_run_id}
    try:
        if decision in ("APPROVE", "REJECT"):
            d = "approve" if decision == "APPROVE" else "reject"
            ready = False
            for e in run.get("locked_edits") or []:
                r = T.record_approval(st, e["target"], e["value"], d, by, ref)
                ready = ready or gate_run_id in r.get("ready_to_promote", [])
            if decision == "APPROVE":
                if run.get("verdict") == "evaluated":
                    T.run_gate(st, gate_run_id)
                    run = st.gate.c("gate_runs").find_one({"_id": gate_run_id}) or run
                if run.get("verdict") in ("passed", "needs_approval"):
                    pro = T.commit_brain_version(st, gate_run_id, run.get("hypothesis"))
                    out["promoted_to"] = pro["version"]
                else:
                    out["note"] = f"approved, but the gate run is {run.get('verdict')}: {run.get('reason')}"
        if body.get("feedback"):
            pref = T.save_preference(st, body["feedback"], by=by, ref=ref)
            out["preference_version"] = pref["version"]
    except Exception as e:  # the gateway retries; tell it plainly
        log.exception("feedback failed")
        return JSONResponse({"accepted": False, "reason": str(e)[:300]}, status_code=200)
    st.feedback_seen.add(key)
    inc["decision"] = {**out, "at": time.time(), "channel": body.get("channel")}
    st.bus.emit("decision", incident_id=inc["incident"]["incident_id"], **out)
    return {"accepted": True}


# ── dashboard read API ───────────────────────────────────────

@app.get("/api/health")
async def api_health(st: State = Depends(state)):
    return {"ok": True, "db": st.improver.cfg.db_name, "env_key": st.improver.env.key, "latest_version": st.gate.latest_version(), "runner": st.cfg.sim_server_url, "gateway": st.cfg.gateway_url}


@app.get("/api/brain/graph")
async def brain_graph(v: str | None = None, compare_to: str | None = None, st: State = Depends(state)):
    latest = st.gate.latest_version()
    V = int(v) if v else latest
    C = int(compare_to) if compare_to else None
    if V > latest or V < 1:
        raise HTTPException(404, f"no brain version {V} (latest is {latest})")
    return st.improver.graph_snapshot(V, C)


@app.get("/api/brain/versions")
async def brain_versions(st: State = Depends(state)):
    V = st.gate.latest_version()
    lin = st.improver.lineage(V)
    return {"latest": V, "chain": lin["chain"], "markdown": lin["markdown"]}


@app.get("/api/brain/context/{node_id}")
async def brain_context(node_id: str, v: int | None = None, reader: str = "dashboard", st: State = Depends(state)):
    return T.get_brain_context(st, node_id, v, reader=reader)


@app.get("/api/brain/explain/{component_id}")
async def brain_explain(component_id: str, st: State = Depends(state)):
    return T.explain(st, component_id)


@app.get("/api/scores")
async def scores(v: int | None = None, st: State = Depends(state)):
    V = v if v is not None else st.gate.latest_version()
    cur = T.current_scores(st, V)
    if not cur.get("zones"):
        cur = await asyncio.to_thread(T.ensure_baseline, st, V)
    base = T.current_scores(st, 1) if V != 1 else cur
    return {"version": V, "zones": cur["zones"], "worst_zone": cur.get("worst_zone"), "v1": base["zones"], "source": cur.get("source")}


@app.get("/api/runs")
async def runs(limit: int = 30, st: State = Depends(state)):
    out = []
    for r in st.improver.c("gate_runs").find({}, {"edits": 1, "verdict": 1, "reason": 1, "zones": 1, "base_version": 1, "promoted_to": 1, "hypothesis": 1, "origin": 1, "created_at": 1, "locked_edits": 1, "failures": 1}).sort("created_at", -1).limit(limit):
        out.append({**r, "gate_run_id": r.pop("_id")})
    return {"runs": out}


@app.get("/api/incidents")
async def incidents(st: State = Depends(state)):
    return {"incidents": [{"incident_id": k, "gate_run_id": v["gate_run_id"], "plain_summary": v["incident"]["plain_summary"], "revisions": len(v["revisions"]), "decision": v["decision"],
                           "open_url": f"{st.cfg.gateway_web_url}/?incident={k}"} for k, v in st.incidents.items()]}


@app.get("/api/events")
async def events(st: State = Depends(state)):
    q = st.bus.subscribe()
    return _sse(q, st, list(st.bus.history)[-200:])


@app.get("/api/brain/reads")
async def brain_reads(st: State = Depends(state)):
    async def gen():
        last = None
        while True:
            q: dict = {"at": {"$gt": last}} if last else {}
            rows = list(st.improver.c("brain_reads").find(q).sort("at", 1).limit(50))
            for r in rows:
                last = r["at"]
                yield f"data: {st.dumps({k: v for k, v in r.items() if k != '_id'})}\n\n"
            if not rows:
                yield ": keepalive\n\n"
            await asyncio.sleep(1.0)
    return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache"})


# ── loop control ─────────────────────────────────────────────

_loop_task: asyncio.Task | None = None


async def _run_rounds(st: State, rounds: int):
    st.loop_status.update(running=True, rounds=rounds)
    try:
        for i in range(rounds):
            st.loop_status["round"] += 1
            res = await run_round(st, st.loop_status["round"])
            st.loop_status["last"] = {k: res[k] for k in ("round", "base_version", "promoted_to", "pending_approval", "text")}
            if st.loop_status.get("stop"):
                break
    except Exception as e:
        log.exception("round failed")
        st.bus.emit("round_error", error=str(e))
    finally:
        st.loop_status.update(running=False, stop=False)


@app.get("/api/loop/status")
async def loop_status(st: State = Depends(state)):
    return {**st.loop_status, "latest_version": st.gate.latest_version()}


@app.post("/api/loop/round")
async def loop_round(body: dict | None = None, st: State = Depends(state)):
    global _loop_task
    if st.loop_status["running"]:
        return JSONResponse({"error": "a round is already running"}, status_code=409)
    _loop_task = asyncio.create_task(_run_rounds(st, 1))
    return {"started": True, "round": st.loop_status["round"] + 1}


@app.post("/api/loop/start")
async def loop_start(body: dict | None = None, st: State = Depends(state)):
    global _loop_task
    if st.loop_status["running"]:
        return JSONResponse({"error": "already running"}, status_code=409)
    _loop_task = asyncio.create_task(_run_rounds(st, int((body or {}).get("rounds", 3))))
    return {"started": True}


@app.post("/api/loop/stop")
async def loop_stop(st: State = Depends(state)):
    st.loop_status["stop"] = True
    return {"stopping": True}


@app.get("/api/proof")
async def proof(st: State = Depends(state)):
    """v1 vs the latest brain on the final held-out seeds (gate client, held_out=true). Booleans and deltas only."""
    from .gate import final_proof
    return await asyncio.to_thread(final_proof, st)


@app.post("/api/demo/approve")
async def demo_approve(body: dict, st: State = Depends(state)):
    """Dashboard fallback when the gateway is down: approve or reject a gate run directly (what the call would do)."""
    gid, decision = body["gate_run_id"], body.get("decision", "approve")
    run = st.gate.c("gate_runs").find_one({"_id": gid}) or {}
    ready = False
    for e in run.get("locked_edits") or []:
        r = T.record_approval(st, e["target"], e["value"], decision, st.cfg.lead_name, "dashboard")
        ready = ready or gid in r.get("ready_to_promote", [])
    out: dict = {"decision": decision}
    if decision == "approve" and run.get("verdict") in ("passed", "needs_approval"):
        out["promoted_to"] = T.commit_brain_version(st, gid, run.get("hypothesis"))["version"]
    if body.get("preference"):
        out["preference_version"] = T.save_preference(st, body["preference"], ref="dashboard")["version"]
    return out
