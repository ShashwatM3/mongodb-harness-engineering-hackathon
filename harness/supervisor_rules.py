"""A supervisor round without a language model: the default order from supervisor.SYSTEM_PROMPT, followed
literally. Used when the Claude session is unavailable (rate limit, no login) or when SUPERVISOR_BACKEND=rules.

  1. current_scores -> worst zone; get_trajectories -> dominant failure type and time state
  2. get_playbook on task:<zone>:PICK and get_brain_context (recorded as a brain read)
  3. candidates: playbook habits that apply to the zone (their `suggests`), then kg.suggest() untested settings;
     skip anything already evaluated on this brain version (gate_runs with the same base_version and edits)
  4. propose_edit -> run_gate -> commit_brain_version | call_robotics_lead; at most three candidates
"""
from __future__ import annotations

import logging
from typing import Any

from . import tools as T
from .state import State

log = logging.getLogger("harness.supervisor.rules")


def _already_tried(st: State, V: int, edits: dict[str, float]) -> bool:
    for r in st.improver.c("gate_runs").find({"base_version": V}, {"edits": 1}):
        if {e["target"]: e["value"] for e in r.get("edits", [])} == edits:
            return True
    return False


def _candidates(st: State, V: int, zone: str, failure: str | None) -> list[tuple[dict[str, float], str, str | None]]:
    out: list[tuple[dict[str, float], str, str | None]] = []
    habits = st.improver.c("playbook").find({"applies_to": {"$in": [f"zone:{zone}", f"task:{zone}:PICK", f"task:{zone}:TRANSPORT"]}}).sort([("helpful", -1), ("harmful", 1)])
    for h in habits:
        sug = h.get("suggests") or {}
        if not sug:
            continue
        out.append((dict(sug), f"Habit '{h['_id']}' ({h.get('text', '')[:80]}) applied to zone {zone}" + (f", where {failure} dominates" if failure else ""), h["_id"]))
    # the stairs lever at a second value, because zone M's problem is the lift queue
    if zone == "M":
        out.append(({"sim.STAIR_MIN_LIFT_QUEUE": 3}, "Take the west stairs once three robots wait for the lift (lift_wait dominates zone M)", "habit:stairs-when-lift-busy"))
        out.append(({"sim.STAIR_MIN_LIFT_QUEUE": 1}, "Take the west stairs whenever anyone is already waiting for the lift", "habit:stairs-when-lift-busy"))
    for s in T.suggest(st, V, k=6).get("suggestions", []):
        t = s["target"]
        if s.get("status") not in ("editable", "locked"):
            continue
        env = st.improver.c("envelope").find_one({"_id": t}) or {}
        cur = s.get("current", env.get("v1"))
        lo, hi = env.get("min"), env.get("max")
        if cur is None or lo is None:
            continue
        v = round(cur + (hi - cur) * 0.3, 2) if cur < hi else round(cur - (cur - lo) * 0.3, 2)
        if env.get("integer"):
            v = int(round(v))
        if v == cur:
            continue
        out.append(({t: v}, f"Untested lever {t} ({env.get('description', '')[:60]}) moved from {cur} to {v} for zone {zone}", None))
    seen, uniq = set(), []
    for c in out:
        k = tuple(sorted(c[0].items()))
        if k in seen or _already_tried(st, V, c[0]):
            continue
        seen.add(k); uniq.append(c)
    return uniq


def run_round_rules(st: State, round_no: int) -> dict[str, Any]:
    V = st.gate.latest_version()
    say = lambda text: st.bus.emit("supervisor_text", round=round_no, text=text, backend="rules")  # noqa: E731
    calls: list[dict] = []

    def call(tool: str, **kw):
        st.bus.emit("tool_call", round=round_no, tool=tool, input=kw, backend="rules")
        fn = getattr(T, tool)
        res = fn(st, **kw)
        calls.append({"tool": tool, "input": kw, "result": res})
        st.bus.emit("tool_result", round=round_no, tool=tool, result=res if len(str(res)) < 4000 else {"truncated": str(res)[:4000]})
        return res

    scores = call("current_scores", version=V)
    if not scores.get("zones"):
        say(f"No shifts recorded for brain v{V} yet; running the baseline on the training seeds first.")
        scores = call("ensure_baseline", version=V)
    zone = scores.get("worst_zone") or "M"
    traj = call("get_trajectories", zone=zone, limit=6)
    fc = traj.get("failure_counts") or {}
    failure = max(fc, key=fc.get) if fc else None
    ts = (traj.get("zones") or {}).get(zone, {}).get("time_split") or {}
    state = max(ts, key=ts.get) if ts else None
    zs0 = scores.get("zones", {}).get(zone)
    say(f"Brain v{V}. Zone {zone} is the worst at {zs0 if zs0 is None else f'{zs0:.3f}'}; its shifts show {failure or 'no dominant failure'}" + (f" and spend most task time in {state} ({ts.get(state, 0):.0%})." if state else "."))
    call("get_playbook", task_node=f"task:{zone}:PICK")
    call("get_brain_context", task_node_id=f"task:{zone}:PICK")
    summary: dict[str, Any] = {"round": round_no, "base_version": V, "text": "", "tool_calls": calls, "promoted_to": None, "pending_approval": None, "backend": "rules"}
    tried = 0
    for edits, hyp, habit in _candidates(st, V, zone, failure):
        if tried >= 3:
            break
        tried += 1
        say(f"Candidate {tried}: {', '.join(f'{k}={v}' for k, v in edits.items())}. {hyp}.")
        res = call("propose_edit", edits=edits, hypothesis=hyp, habit_id=habit, round_=round_no)
        if res.get("status") == "invalid":
            say(f"The twin refused it: {res.get('reason')}.")
            continue
        zs = res.get("zones") or {}
        say("Measured: " + ", ".join(f"{z} {v['delta']:+.3f}" for z, v in sorted(zs.items())) + ".")
        g = call("run_gate", gate_run_id=res["gate_run_id"])
        if g["verdict"] == "passed":
            pro = call("commit_brain_version", gate_run_id=res["gate_run_id"], hypothesis=hyp)
            summary["promoted_to"] = pro["version"]
            summary["text"] = f"Promoted brain v{pro['version']}: {', '.join(f'{k}={v}' for k, v in edits.items())}. Zone {zone} moved {zs.get(zone, {}).get('delta', 0):+.3f} on training shifts and the held-out seeds agreed. {hyp}."
            break
        if g["verdict"] == "needs_approval":
            inc = call("call_robotics_lead", gate_run_id=res["gate_run_id"], questions=["Is the measured gain worth the change to a locked setting?"])
            summary["pending_approval"] = res["gate_run_id"]
            summary["text"] = f"Candidate {', '.join(f'{k}={v}' for k, v in edits.items())} improves zone {zone} by {zs.get(zone, {}).get('delta', 0):+.3f} but touches a locked setting, so the Robotics Lead is being called (incident {inc.get('incident_id')}). The brain stays at v{V} until they decide."
            break
        say(f"The gate rejected it: {g['reason']}.")
    if not summary["text"]:
        summary["text"] = f"No change was promoted this round; brain v{V} stands. Zone {zone} remains the worst and {tried} candidate(s) failed the gate."
    say(summary["text"])
    return summary
