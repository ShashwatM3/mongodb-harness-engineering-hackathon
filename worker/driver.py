"""Worker driver: long-polls the sim mailbox and answers each exception with one discrete action.

    worker/.venv/bin/python worker/driver.py                 # loop forever against SIM_SERVER_URL
    WORKER_BACKEND=rules worker/.venv/bin/python worker/driver.py --once --fake   # offline self-test

Backends (env WORKER_BACKEND): "devin" (default) asks a cheap model through `devin -p` with the worker MCP
server attached, falling back to "rules" on any failure; "rules" is the deterministic chooser below.
One devin call is in flight at a time; while it runs, other pending exceptions are answered by the rules.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
sys.path.insert(0, str(REPO_ROOT))

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s driver %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("worker.driver")

import httpx  # noqa: E402

import kg  # noqa: E402
from mcp_server import SOPS  # noqa: E402  (same fixed SOP text as the MCP tool)

kg.load_dotenv(REPO_ROOT)

SIM_URL = os.getenv("SIM_SERVER_URL", "http://localhost:8790").rstrip("/")
BACKEND = os.getenv("WORKER_BACKEND", "devin")
MODEL = os.getenv("WORKER_MODEL", "gpt-5-mini")
DEVIN_TIMEOUT = float(os.getenv("WORKER_DEVIN_TIMEOUT", "90"))
ACTIONS = ["move_to", "pick", "place", "wait_at_holding_point", "reroute", "swap_task", "go_charge",
           "take_stairs", "take_lift", "continue"]

FAKE_EXCEPTION = {"id": "ex-fake-1", "robot_id": "HUM-1-07", "kind": "OBSTACLE_DETECTED", "tick": 4210,
                  "ctx": {"blocked_by": "HUM-1-03", "wait_ticks": 75, "phase": "to_drop", "zone": "M", "loaded": True,
                          "battery": 61, "task": {"id": "t-991", "type": "TRANSPORT", "level": 1}}, "decision": None}

_kg = None


def brain_context(node_id: str, reader: str = "worker-driver") -> list[dict]:
    """Compact brain components for a node; empty on any KG problem so the worker still answers."""
    global _kg
    try:
        if _kg is None:
            _kg = kg.connect("improver", with_runner=False)
        ctx = _kg.get_brain_context(node_id, reader=reader)
        return [{"kind": c["kind"], "key": c["key"], "when": c["when"], "then": c["then"]} for c in ctx["components"]]
    except Exception as e:
        log.warning("brain context unavailable for %s: %s", node_id, e)
        return []


def node_for(ctx: dict) -> str:
    zone, ttype = ctx.get("zone"), (ctx.get("task") or {}).get("type")
    if zone and ttype:
        return f"task:{zone}:{ttype}"
    return f"zone:{zone}" if zone else "site:main"


def rules(exc: dict) -> dict:
    """Deterministic chooser: the fallback and the WORKER_BACKEND=rules policy."""
    ctx = exc.get("ctx") or {}
    loaded = bool(ctx.get("loaded"))
    battery = ctx.get("battery")
    if isinstance(battery, (int, float)) and battery < 20:
        return {"action": "go_charge", "rationale": f"battery {battery}% is below the 20% floor"}
    if exc.get("kind") == "FLOOR_CHOICE":
        q = int(ctx.get("lift_queue") or 0)
        if loaded and q <= 1:
            return {"action": "take_lift", "rationale": f"loaded and the lift queue is {q}"}
        if q >= 3:
            return {"action": "take_stairs", "rationale": f"lift queue is {q}, stairs are faster"}
        return {"action": "continue", "rationale": "no strong reason to override the default route"}
    if exc.get("kind") == "OBSTACLE_DETECTED":
        w = int(ctx.get("wait_ticks") or 0)
        if w > 60 and loaded:
            return {"action": "wait_at_holding_point", "rationale": f"blocked {w} ticks while loaded; hold rather than thread past"}
        return {"action": "reroute", "rationale": f"blocked {w} ticks by {ctx.get('blocked_by')}; take another path"}
    return {"action": "continue", "rationale": f"unknown exception kind {exc.get('kind')}"}


def build_prompt(exc: dict, context: list[dict]) -> str:
    ctx = exc.get("ctx") or {}
    ttype = (ctx.get("task") or {}).get("type", "")
    return (
        f"You are the worker agent for warehouse robot {exc['robot_id']}. It hit exception {exc['kind']} at tick "
        f"{exc.get('tick')}.\nContext: {json.dumps(ctx)}\nBrain rules for {node_for(ctx)}: {json.dumps(context)}\n"
        f"SOP: {SOPS.get(ttype, 'n/a')}\nPick exactly ONE action from {ACTIONS}. Do not run commands or edit files; "
        f"you may call the twin-worker MCP tools get_playbook or report_issue if useful. Reply with ONLY one line of "
        f'JSON: {{"action": "<action>", "rationale": "<one sentence>"}}'
    )


def devin(exc: dict, context: list[dict]) -> dict:
    cmd = ["devin", "-p", "--model", MODEL, "--respect-workspace-trust", "false", "--", build_prompt(exc, context)]
    env = {**os.environ, "WORKER_ROBOT_ID": exc["robot_id"], "WORKER_SHIFT_ID": str(exc.get("shift_id") or "")}
    out = subprocess.run(cmd, cwd=HERE, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                         timeout=DEVIN_TIMEOUT)
    if out.returncode != 0:
        raise RuntimeError(f"devin exit {out.returncode}: {out.stderr.strip()[-300:]}")
    lines = [ln for ln in out.stdout.strip().splitlines() if ln.strip()]
    m = re.search(r"\{.*\}", lines[-1] if lines else "", re.S) or re.search(r"\{[^{}]*\"action\"[^{}]*\}", out.stdout, re.S)
    d = json.loads(m.group(0)) if m else {}
    if d.get("action") not in ACTIONS:
        raise ValueError(f"bad model answer: {out.stdout.strip()[-200:]}")
    return {"action": d["action"], "rationale": str(d.get("rationale", ""))[:300]}


def choose(exc: dict, backend: str, offline: bool = False) -> dict:
    context = [] if offline else brain_context(node_for(exc.get("ctx") or {}), reader=str(exc.get("robot_id") or "worker-driver"))
    if backend == "devin":
        try:
            return {**devin(exc, context), "by": f"devin:{MODEL}"}
        except Exception as e:
            log.warning("devin failed for %s, using rules: %s", exc["id"], e)
    return {**rules(exc), "by": "rules"}


def post(exc: dict, d: dict, dry: bool) -> None:
    print(f"{exc['id']} {exc['robot_id']} {exc['kind']} -> {d['action']} [{d['by']}] {d['rationale']}", flush=True)
    if dry:
        return
    body = {"id": exc["id"], "action": d["action"], "args": {}, "rationale": d["rationale"], "by": d["by"]}
    r = httpx.post(f"{SIM_URL}/worker/decisions", json=body, timeout=10)
    if r.status_code >= 400:
        log.warning("decision for %s rejected: %s %s", exc["id"], r.status_code, r.text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="handle one batch and exit")
    ap.add_argument("--fake", action="store_true", help="use a built-in exception; no network at all")
    ap.add_argument("--wait-ms", type=int, default=5000)
    a = ap.parse_args()
    if a.fake:
        post(FAKE_EXCEPTION, choose(FAKE_EXCEPTION, BACKEND, offline=True), dry=True)
        return 0
    log.info("backend=%s model=%s sim=%s", BACKEND, MODEL, SIM_URL)
    answered: set[str] = set()
    busy = threading.Lock()  # held while one devin call is in flight

    def slow_path(exc):
        try:
            post(exc, choose(exc, "devin"), dry=False)
        finally:
            busy.release()

    while True:
        try:
            r = httpx.get(f"{SIM_URL}/worker/exceptions", params={"wait": a.wait_ms}, timeout=a.wait_ms / 1000 + 10)
            pending = [e for e in r.json().get("exceptions", []) if e["id"] not in answered]
        except Exception as e:
            log.warning("mailbox unreachable (%s); retrying", e)
            time.sleep(2)
            continue
        for exc in pending:
            answered.add(exc["id"])
            if BACKEND == "devin" and busy.acquire(blocking=False):
                threading.Thread(target=slow_path, args=(exc,), daemon=True).start()
            else:
                post(exc, choose(exc, "rules"), dry=False)
        if a.once:
            return 0
        if len(answered) > 5000:
            answered.clear()


if __name__ == "__main__":
    sys.exit(main())
