"""Worker MCP server (stdio): the tools one HUM-1 robot's worker agent may call.

Run: worker/.venv/bin/python worker/mcp_server.py   (stdout is the MCP channel; logs go to stderr)
Env: WORKER_ROBOT_ID, SIM_SERVER_URL, WORKER_SHIFT_ID, KG_MONGODB_URI_IMPROVER, KG_DB,
     RAINDROP_WRITE_KEY, RAINDROP_DEV_PROJECT_ID / RAINDROP_PROJECT_ID
"""
from __future__ import annotations

import json
import logging
import os
import sys
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))  # so `import kg` works from any cwd

import httpx  # noqa: E402
from mcp.server.fastmcp import FastMCP  # noqa: E402

import kg  # noqa: E402

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s worker-mcp %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("worker.mcp")
kg.load_dotenv(REPO_ROOT)

ROBOT_ID = os.getenv("WORKER_ROBOT_ID", "worker")
SIM_URL = os.getenv("SIM_SERVER_URL", "http://localhost:8790").rstrip("/")
SHIFT_ID = os.getenv("WORKER_SHIFT_ID", "")

SOPS = {
    "PICK": "PICK: go to the pick face, confirm the slot matches the task, pick one unit, then go to the "
            "drop point and place. If blocked for long while unloaded, reroute; never swap a task mid-pick.",
    "REPLENISH": "REPLENISH: fetch from the reserve location, travel to the shelf, place. Loaded robots prefer the "
                 "lift when the queue is short; take stairs only if unloaded or the lift queue is long.",
    "TRANSPORT": "TRANSPORT: carry the load between zones by the shortest safe route. When blocked while loaded, "
                 "wait at the holding point instead of threading past another robot; go charge only below 20%.",
    "RETURN": "RETURN: bring the empty tote or robot back to its home cell. Yield to loaded robots, reroute "
              "freely, and go charge if the battery is low on the way.",
}

_kg = None


def brain():
    """One lazy improver client (read-only brain access, no runner)."""
    global _kg
    if _kg is None:
        _kg = kg.connect("improver", with_runner=False)
    return _kg


def _compact(doc):
    """Make a Mongo document JSON-safe for the MCP channel."""
    return json.loads(json.dumps(doc, default=str))


mcp = FastMCP("twin-worker")


@mcp.tool()
def get_brain_context(task_node_id: str) -> list[dict]:
    """Components of the current brain that apply to a node, e.g. "task:M:PICK": [{kind, key, when, then}]."""
    ctx = brain().get_brain_context(task_node_id, reader=ROBOT_ID)
    return [{"kind": c["kind"], "key": c["key"], "when": c["when"], "then": c["then"]} for c in ctx["components"]]


@mcp.tool()
def get_sop(task_type: str) -> str:
    """The standard operating procedure for PICK / REPLENISH / TRANSPORT / RETURN (Mongo `sop_docs` first)."""
    t = task_type.upper()
    try:
        doc = brain().c("sop_docs").find_one({"task_type": t})
        if doc and doc.get("text"):
            return str(doc["text"])
    except Exception as e:  # collection missing, no permission, no network: fall back to the built-in text
        log.warning("sop_docs lookup failed: %s", e)
    return SOPS.get(t, f"No SOP for {t}; follow the brain context and keep the robot safe.")


@mcp.tool()
def get_playbook(task_node: str) -> list[dict]:
    """Human habits that apply to a node, best evidence first."""
    return [_compact(h) for h in brain().get_playbook(task_node)]


@mcp.tool()
def report_issue(category: str, detail: str) -> dict:
    """Flag a problem the brain should learn from. category: capability_gap | guardrail_conflict |
    repeated_failure | sop_gap. Sent to Raindrop as a worker_step event with a NEGATIVE signal when configured."""
    cats = {"capability_gap", "guardrail_conflict", "repeated_failure", "sop_gap"}
    if category not in cats:
        return {"ok": False, "error": f"category must be one of {sorted(cats)}"}
    event_id = str(uuid.uuid4())
    key = os.getenv("RAINDROP_WRITE_KEY")
    if not key:
        log.info("report_issue (no RAINDROP_WRITE_KEY): %s %s", category, detail)
        return {"ok": True, "sent": False, "event_id": event_id}
    try:
        from raindrop import Raindrop  # lazy: pulls in OpenTelemetry
        try:
            version = brain().latest_version()
        except Exception:
            version = None
        rd = Raindrop(api_key=key, project_id=os.getenv("RAINDROP_DEV_PROJECT_ID") or os.getenv("RAINDROP_PROJECT_ID"),
                      tracing_enabled=False, auto_instrument=False, app_git=False)
        rd.track_ai(user_id=ROBOT_ID, event="worker_step", event_id=event_id,
                    properties={"shift_id": SHIFT_ID, "robot_id": ROBOT_ID, "category": category,
                                "detail": detail[:2000], "brain_version": str(version)})
        rd.track_signal(event_id=event_id, name=category, sentiment="NEGATIVE")
        rd.flush()
        return {"ok": True, "sent": True, "event_id": event_id}
    except Exception as e:  # observability never breaks the worker
        log.warning("raindrop failed: %s", e)
        return {"ok": True, "sent": False, "event_id": event_id, "error": str(e)}


@mcp.tool()
def get_pending_exceptions(wait_ms: int = 0) -> list[dict]:
    """Unanswered exceptions from the sim mailbox; long-polls up to wait_ms (max 30000)."""
    wait = max(0, min(int(wait_ms), 30000))
    r = httpx.get(f"{SIM_URL}/worker/exceptions", params={"wait": wait}, timeout=wait / 1000 + 10)
    r.raise_for_status()
    return r.json().get("exceptions", [])


@mcp.tool()
def decide(exception_id: str, action: str, rationale: str = "", args_json: str = "{}") -> dict:
    """Answer one exception. action: move_to | pick | place | wait_at_holding_point | reroute | swap_task |
    go_charge | take_stairs | take_lift | continue. args_json: optional JSON object of action arguments."""
    try:
        args = json.loads(args_json or "{}")
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"args_json is not JSON: {e}"}
    body = {"id": exception_id, "action": action, "args": args, "rationale": rationale, "by": ROBOT_ID}
    r = httpx.post(f"{SIM_URL}/worker/decisions", json=body, timeout=10)
    if r.status_code >= 400:
        return {"ok": False, "status": r.status_code, "error": r.text}
    return r.json()


if __name__ == "__main__":
    log.info("starting stdio MCP server for %s against %s", ROBOT_ID, SIM_URL)
    mcp.run(transport="stdio")
