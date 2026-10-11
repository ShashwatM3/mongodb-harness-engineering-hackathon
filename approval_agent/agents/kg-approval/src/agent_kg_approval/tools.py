"""Tool definitions for KG Approval.

Every KG call goes through @app.tool so the Orchestration Engine audits it and replays it on resume.
"""

from __future__ import annotations

import json

from agent_engine_sdk_langgraph import App
from langgraph.types import interrupt

from agent_kg_approval import kg_calls

DECISIONS = ["approve", "reject"]

REVIEW_RESPONSE_SCHEMA = {
    "type": "object",
    "required": ["decision"],
    "properties": {
        "decision": {"type": "string", "title": "Decision", "enum": DECISIONS,
                     "description": "Approve or reject the locked edit."},
        "reviewer_notes": {"type": "string", "title": "Reviewer notes",
                           "description": "Optional. 'call:<id>' links the phone call; each "
                                          "'preference: ...' line is saved to the brain."},
    },
    "additionalProperties": False,
}


def register(app: App) -> None:
    @app.tool()
    def approval_context(gate_run_id: str = "") -> str:
        """Load what the Robotics Lead needs to decide on a locked edit: the edit, its measured effect
        from the gate run, current per-zone scores, and the episodes and habit clip behind it.
        An empty gate_run_id picks the newest gate run waiting for approval."""
        return json.dumps(kg_calls.approval_context(gate_run_id), default=str)

    @app.tool()
    def human_review(gate_run_id: str, context_json: str) -> str:
        """Suspend until the Robotics Lead approves or rejects the locked edit (phone call or UI)."""
        ctx = json.loads(context_json)
        answer = interrupt(
            {
                "action": "approve_locked_edit",
                "task_id": f"APPROVE-{gate_run_id}",
                "gate_run_id": gate_run_id,
                "summary": ctx.get("summary"),
                "locked_edits": ctx.get("locked_edits"),
                "measured_effect": ctx.get("measured_effect"),
                "current_scores": ctx.get("current_scores"),
                "evidence": ctx.get("evidence"),
                "message": "Approve or reject this change to a locked setting.",
                "allowed_decisions": DECISIONS,
                "response_schema": REVIEW_RESPONSE_SCHEMA,
            }
        )
        if isinstance(answer, str):
            answer = {"decision": answer}
        if not isinstance(answer, dict):
            raise TypeError("human review resume value must be an object")
        return json.dumps({"decision": str(answer.get("decision", "")).lower(),
                           "reviewer_notes": answer.get("reviewer_notes") or ""})

    @app.tool()
    def record_decision(gate_run_id: str, decision: str, by: str = "Robotics Lead", ref: str = "",
                        notes: str = "") -> str:
        """Record the human decision in the KG (record_approval for each locked edit), promote the
        gate run to a new brain version when approved, and save any 'preference:' lines."""
        return json.dumps(kg_calls.record_decision(gate_run_id, decision, by=by, ref=ref, notes=notes),
                          default=str)
