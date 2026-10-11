"""The supervisor: the harness. A Claude Agent SDK tool-calling loop over the toolbelt in tools.py, with no
built-in tools (no files, no bash), a default order it may deviate from, and every tool call streamed to the
dashboard's event bus. Runs on the Claude subscription login (CLAUDE_CODE_OAUTH_TOKEN / the CLI's login);
ANTHROPIC_API_KEY is removed from its environment so nothing bills per token by accident.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ResultMessage, TextBlock, ToolResultBlock, ToolUseBlock,
                              UserMessage, create_sdk_mcp_server, query, tool)

from . import tools as T
from .state import State, get_state

log = logging.getLogger("harness.supervisor")

SYSTEM_PROMPT = """You are the supervisor of a fleet of 20 HUM-1 warehouse robots (legged quadrupeds with one arm) in a two-floor
warehouse: zones A, B, C, D on the ground floor and zone M on a mezzanine reached by two freight lifts or the west stairs in
zone C. Task types are PICK, REPLENISH, TRANSPORT, RETURN. You are the harness: the one component that changes the robots'
rules, guardrails, context policies and tool grants. The robots' brain is a versioned hierarchical knowledge graph in
MongoDB Atlas; you change it only through the tools below, and only the gate decides what is promoted.

Each round, improve the brain by one promoted change if you can, honestly. The default order (you may deviate when the
situation calls for it):
  1. current_scores and get_trajectories: find the worst zone and its dominant failure type and time state.
  2. get_playbook on that zone's task node, and get_brain_context: what human habits apply, and what the brain already says.
  3. brain_context_markdown: what was already tried on this brain (section B) and what to try next (section C). Never
     repeat a candidate that section B shows was evaluated on this brain version.
  4. propose_edit: one or two setting edits, with a one-sentence hypothesis naming the habit or failure it addresses.
     It runs the deterministic twin on the training seeds and returns per-zone before/after numbers.
  5. run_gate on the gate run id. The gate rejects any change that makes a zone worse, demands a gain somewhere, checks
     held-out seeds you can never see, and returns needs_approval when a locked setting is touched.
  6. If needs_approval: call_robotics_lead with the gate run id. A human will approve or reject on a phone call; do not
     wait for it, finish the round and report that the change is pending approval.
  7. If passed: commit_brain_version with the gate run id. Then stop.
If a proposal is rejected, you may try at most two more candidates in the round (prefer a different lever group or a
different value from section C). Locked settings (class.HUM-1.max_speed, sim.PERC_STOP, sim.PERC_SLOW) are legitimate to
propose when the evidence points there; they simply route to the human.

Be concrete and brief in your text: name the zone, the failure type, the habit, the setting and the measured delta. Your
final message is read aloud to engineers: two or three sentences, what you found, what you changed, what it did."""


def make_server(st: State):
    def text(obj: Any) -> dict:
        return {"content": [{"type": "text", "text": json.dumps(obj, default=str)}]}

    @tool("current_scores", "Per-zone scores of the latest brain (or a given version) on training seeds, plus the worst zone.", {"version": int})
    async def t_scores(a: dict) -> dict:
        return text(T.current_scores(st, a.get("version")))

    @tool("get_trajectories", "One training shift's per-zone result (score, late, dropped, time_split) and its failure episodes. Omit shift_id for the latest brain's first training shift; filter by zone.", {"shift_id": str, "zone": str, "limit": int})
    async def t_traj(a: dict) -> dict:
        return text(T.get_trajectories(st, a.get("shift_id"), zone=a.get("zone"), limit=int(a.get("limit") or 12)))

    @tool("get_signals", "Raindrop's categorized signals for one shift: gate, hard metrics, self-diagnostics.", {"shift_id": str})
    async def t_signals(a: dict) -> dict:
        return text(T.get_signals(st, a["shift_id"]))

    @tool("get_playbook", "Human habits (from filmed clips) that apply to a task node such as task:M:PICK, best evidence first.", {"task_node": str})
    async def t_playbook(a: dict) -> dict:
        return text(T.get_playbook(st, a["task_node"]))

    @tool("get_brain_context", "Every brain component that applies to a task node (walks task -> zone -> site), at the latest or a given version. Lights the node up on the dashboard.", {"task_node_id": str, "version": int})
    async def t_ctx(a: dict) -> dict:
        return text(T.get_brain_context(st, a["task_node_id"], a.get("version")))

    @tool("brain_context_markdown", "Sections A-C for the latest brain: current numbers, everything already evaluated on it, and untested settings in the order to try them.", {"version": int})
    async def t_md(a: dict) -> dict:
        return {"content": [{"type": "text", "text": T.brain_context_markdown(st, a.get("version"))}]}

    @tool("explain", "A component's evidence: habit and clip, failure episodes, gate run, held-out flag.", {"component_id": str})
    async def t_explain(a: dict) -> dict:
        return text(T.explain(st, a["component_id"]))

    @tool("propose_edit", "Propose and evaluate one candidate brain: edits is {target: value}; hypothesis is one sentence; habit_id when it comes from a playbook habit. Returns per-zone before/after, failures, and the gate_run_id.", {"edits": dict, "hypothesis": str, "habit_id": str})
    async def t_propose(a: dict) -> dict:
        edits = a["edits"]
        if isinstance(edits, str):
            edits = json.loads(edits)
        return text(T.propose_edit(st, edits, a.get("hypothesis") or "", habit_id=a.get("habit_id") or None, round_=st.loop_status.get("round", 0)))

    @tool("run_gate", "The gate's decision on an evaluated gate run: passed, rejected or needs_approval, with the reason. Runs the held-out check you cannot see.", {"gate_run_id": str})
    async def t_gate(a: dict) -> dict:
        return text(T.run_gate(st, a["gate_run_id"]))

    @tool("commit_brain_version", "Promote a passed gate run to brain version N+1.", {"gate_run_id": str, "hypothesis": str})
    async def t_commit(a: dict) -> dict:
        return text(T.commit_brain_version(st, a["gate_run_id"], a.get("hypothesis")))

    @tool("call_robotics_lead", "Place the approval call for a gate run that needs_approval. Optional summary (three sentences) and questions for the human.", {"gate_run_id": str, "summary": str, "questions": list})
    async def t_call(a: dict) -> dict:
        return text(T.call_robotics_lead(st, a["gate_run_id"], a.get("summary"), a.get("questions")))

    @tool("save_preference", "Save an instruction from the Robotics Lead as a brain component.", {"text": str, "by": str})
    async def t_pref(a: dict) -> dict:
        return text(T.save_preference(st, a["text"], a.get("by") or "Robotics Lead"))

    tools_ = [t_scores, t_traj, t_signals, t_playbook, t_ctx, t_md, t_explain, t_propose, t_gate, t_commit, t_call, t_pref]
    return create_sdk_mcp_server(name="harness", version="1.0.0", tools=tools_), [f"mcp__harness__{t.name}" for t in tools_]


async def run_round(st: State, round_no: int, prompt: str | None = None) -> dict:
    """One supervisor round. Streams transcript events; returns {text, tool_calls, promoted_to, pending_approval}."""
    server, allowed = make_server(st)
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    opts = ClaudeAgentOptions(
        system_prompt=SYSTEM_PROMPT, tools=[], allowed_tools=allowed, mcp_servers={"harness": server},
        permission_mode="bypassPermissions", max_turns=st.cfg.max_turns, model=st.cfg.model, env=env,
        setting_sources=[], include_partial_messages=False,
    )
    V = st.gate.latest_version()
    prompt = prompt or f"Round {round_no}. The current brain is v{V}. Improve it by one promoted change if the evidence supports one."
    st.bus.emit("round_start", round=round_no, version=V, prompt=prompt)
    summary = {"round": round_no, "base_version": V, "text": "", "tool_calls": [], "promoted_to": None, "pending_approval": None, "cost_usd": None}
    pending: dict[str, dict] = {}
    async for m in query(prompt=prompt, options=opts):
        if isinstance(m, AssistantMessage):
            for b in m.content:
                if isinstance(b, TextBlock) and b.text.strip():
                    summary["text"] = b.text
                    st.bus.emit("supervisor_text", round=round_no, text=b.text)
                elif isinstance(b, ToolUseBlock):
                    name = b.name.replace("mcp__harness__", "")
                    pending[b.id] = {"tool": name, "input": b.input}
                    st.bus.emit("tool_call", round=round_no, tool=name, input=b.input)
        elif isinstance(m, UserMessage) and isinstance(m.content, list):
            for b in m.content:
                if isinstance(b, ToolResultBlock):
                    call = pending.pop(b.tool_use_id, {"tool": "?", "input": {}})
                    raw = b.content if isinstance(b.content, str) else "".join(x.get("text", "") for x in (b.content or []) if isinstance(x, dict))
                    result = _parse(raw)
                    call["result"] = result
                    summary["tool_calls"].append(call)
                    if call["tool"] == "commit_brain_version" and isinstance(result, dict) and result.get("version"):
                        summary["promoted_to"] = result["version"]
                    if call["tool"] == "call_robotics_lead" and isinstance(result, dict):
                        summary["pending_approval"] = result.get("gate_run_id")
                    st.bus.emit("tool_result", round=round_no, tool=call["tool"], result=_brief(result))
        elif isinstance(m, ResultMessage):
            summary["cost_usd"] = m.total_cost_usd
            summary["turns"] = m.num_turns
    st.bus.emit("round_end", **{k: summary[k] for k in ("round", "base_version", "promoted_to", "pending_approval", "turns")}, text=summary["text"])
    return summary


def _parse(raw: str) -> Any:
    try:
        return json.loads(raw)
    except Exception:
        return raw


def _brief(result: Any) -> Any:
    s = json.dumps(result, default=str)
    return result if len(s) < 4000 else {"truncated": s[:4000]}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    st = get_state()
    out = asyncio.run(run_round(st, 1))
    print(json.dumps({k: v for k, v in out.items() if k != "tool_calls"}, indent=2, default=str))
    for c in out["tool_calls"]:
        print("-", c["tool"], json.dumps(c["input"], default=str)[:160])
