"""KG Approval: the human-approval path for locked brain edits (doc 05, option 1).

Improvement rounds stay local next to the runner. When the gate gives a run the verdict needs_approval,
this agent loads the context, suspends for the Robotics Lead (Person C's call resumes it through the
REST resume API), then records the decision and promotes. The path is fixed, so there is no model call:
a planner node emits the tool calls and the stock ToolNode runs them through the platform.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Literal

from dotenv import load_dotenv
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import ToolNode
from agent_engine_sdk_langgraph import App

from agent_kg_approval.state import HelloWorldState
from agent_kg_approval.tools import register

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)-8s | %(message)s")
logger = logging.getLogger(__name__)
load_dotenv()

app = App(app_name="KG Approval")

register(app)

GATE_RUN_ID = re.compile(r"\bgr-[0-9a-f]{8,}\b")
CALL_REF = re.compile(r"\bcall:[\w-]+")


def _call(name: str, args: dict) -> AIMessage:
    # Stable ids keep the checkpointed plan identical when the platform replays it on resume.
    tid = f"{name}-{uuid.uuid5(uuid.NAMESPACE_URL, name + json.dumps(args, sort_keys=True)).hex[:12]}"
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": tid}])


def _last_tool_result(messages: list, name: str) -> dict | None:
    for m in reversed(messages):
        if isinstance(m, ToolMessage) and m.name == name:
            try:
                return json.loads(m.content if isinstance(m.content, str) else str(m.content))
            except json.JSONDecodeError:
                return {"error": str(m.content)}
    return None


def plan(state: HelloWorldState) -> dict:
    """approval_context → human_review → record_decision, then a plain-text reply."""
    messages = state["messages"]
    last = messages[-1] if messages else None
    if isinstance(last, HumanMessage) or last is None:
        text = last.content if last is not None and isinstance(last.content, str) else ""
        m = GATE_RUN_ID.search(text)
        return {"messages": [_call("approval_context", {"gate_run_id": m.group(0) if m else ""})]}
    if not isinstance(last, ToolMessage):
        return {"messages": [AIMessage(content="Nothing to do.")]}
    if last.name == "approval_context":
        ctx = _last_tool_result(messages, "approval_context") or {}
        if ctx.get("error"):
            return {"messages": [AIMessage(content=f"No approval needed: {ctx['error']}.")]}
        return {"messages": [_call("human_review", {"gate_run_id": ctx["gate_run_id"],
                                                    "context_json": json.dumps(ctx, sort_keys=True)})]}
    if last.name == "human_review":
        ctx = _last_tool_result(messages, "approval_context") or {}
        answer = _last_tool_result(messages, "human_review") or {}
        notes = answer.get("reviewer_notes") or ""
        ref = CALL_REF.search(notes)
        return {"messages": [_call("record_decision", {
            "gate_run_id": ctx["gate_run_id"], "decision": answer.get("decision", ""),
            "by": "Robotics Lead", "ref": ref.group(0) if ref else "agentengine:human_review",
            "notes": notes})]}
    if last.name == "record_decision":
        r = _last_tool_result(messages, "record_decision") or {}
        if r.get("error"):
            return {"messages": [AIMessage(content=f"Could not record the decision: {r['error']}")]}
        if r.get("promoted_to"):
            msg = f"Approved. Gate run {r['gate_run_id']} is promoted to brain v{r['promoted_to']}."
        else:
            msg = f"Recorded '{r.get('decision')}' for gate run {r.get('gate_run_id')}; brain unchanged."
        if r.get("preferences"):
            msg += f" Saved {len(r['preferences'])} preference(s) to the brain."
        return {"messages": [AIMessage(content=msg)]}
    return {"messages": [AIMessage(content="Nothing to do.")]}


@app.entrypoint
def build_agent() -> CompiledStateGraph:
    """Build the LangGraph agent."""
    logger.info("Building KG Approval graph")
    tools = app.get_tools()

    def should_continue(state: HelloWorldState) -> Literal["tools", "end"]:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else "end"

    builder = StateGraph(HelloWorldState)
    builder.add_node("planner", plan)
    builder.add_node("tools", ToolNode(tools))
    builder.add_edge(START, "planner")
    builder.add_conditional_edges("planner", should_continue, {"tools": "tools", "end": END})
    builder.add_edge("tools", "planner")
    return builder.compile(checkpointer=app.checkpointer())


def main() -> None:
    """Run the approval agent."""
    app.run()


if __name__ == "__main__":
    main()
