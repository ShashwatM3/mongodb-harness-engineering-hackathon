# Harness contract (v1)

These are the endpoints the robotics harness (supervisor, improver and gate) must expose to the intervention gateway, and the ones it calls on the gateway. Zod schemas in `src/shared/schemas.ts` are authoritative. The mock (`src/server/harness/mock/`) implements this contract, so you can compare your behaviour against it.

The gateway's job ends when the **human's feedback** reaches you. Applying the change, re-planning, or learning a preference is up to the harness. The gateway does not track execution.

**Minimum for a demo:**
- (A) POST incidents to the gateway;
- (E) accept feedback from it.

Everything else can stay mocked (`HARNESS_MODE=mock`).

## A. Harness → gateway: `POST /v1/incidents`

Auth: `Authorization: Bearer <HARNESS_TOKEN>`.

Responses:
- `201 {incident_id, duplicate:false}`: stored; the human is called immediately.
- `200 {incident_id, duplicate:true}`: the same `event_id` was seen before. Nothing new is created, so it's safe to retry.
- `400` (schema issues listed) · `401` · `409` (the id is already used under a different `event_id`).

```jsonc
{
  "schema_version": "1",
  "event_id": "evt-…",                 // dedupe key
  "incident_id": "inc-…",
  "task_id": "task:M:PICK:0412", "robot_id": "AMR-07",
  "timestamp": "2026-10-11T10:41:53-07:00",
  "severity": "LOW|MEDIUM|HIGH|CRITICAL",
  "category": "navigation.trajectory_deviation",          // open string
  "plain_summary": "Robot AMR-07 cut a corner in the lift area and came within 62 centimetres of a worker, when it should keep at least a metre away.",
  "observed_behavior": "…", "expected_behavior": "…", "failure_summary": "… (technical)",
  "root_cause_hypothesis": { "text": "…", "confidence": 0.72 },
  "evidence_refs": [{ "id": "ev:1", "kind": "MEASURED|EXPECTED|ESTIMATE|HYPOTHESIS", "summary": "…", "source": "…", "timestamp": "…" }],
  "metrics_refs": [],
  "proposal": {
    "proposal_id": "prop-…", "revision": 1, "source_agent": "harness-supervisor", "risk": "LOW|MEDIUM|HIGH",
    "plain_summary": "Give the robot a wider safety margin in the lift area, 0.65 metres instead of 0.45, which adds about 2 seconds per trip.",
    "summary": "… (technical)", "justification": "…", "constraints": [], "affected_resources": [], "created_at": "…",
    "changes": [{ "op": "set_param", "key": "planner.lift_lobby.inflation_radius_m", "value": 0.65, "unit": "m" }],
    "editable_parameters": [{ "key": "planner.lift_lobby.inflation_radius_m", "label": "Lift lobby safety margin", "unit": "m",
      "type": "number", "min": 0.3, "max": 0.9, "current_value": 0.45, "proposed_value": 0.65 }]
  },
  "responsible_supervisor": { "id": "sup-lead-01", "name": "Robotics Lead" },
  "escalation": { "reason": "why a human is needed", "requires_authority": true },
  "synthetic": false,
  "metadata": {}
}
```

**Two fields matter most:**
- **`plain_summary`** on the incident and on the proposal: one or two sentences a busy person understands on the phone. They are spoken first, word for word. If missing, the technical summary is used instead, which sounds worse.
- **`editable_parameters`**: what a human may change, and the bounds you will accept. The gateway rejects anything else before it reaches you.

## Gateway → harness (`HARNESS_MODE=http`)

Base URL `HARNESS_BASE_URL`; auth `Authorization: Bearer <HARNESS_OUTBOUND_TOKEN>`. Responses are schema-validated, and a 404 means "not available".

| | Method & path | Body | Response |
|---|---|---|---|
| B | `POST /supervisor/questions` | `{incident_id, task_id, query_id, question}` | `{status: ANSWERED\|INSUFFICIENT_EVIDENCE\|UNAVAILABLE, answer?, evidence_refs, confidence?, limitations?}` |
| C | `GET /incidents/:id/trajectory` | — | `Trajectory` (2D planned/actual, deviations, segments, zones) or 404 |
| D | `GET /incidents/:id/metrics?keys=a,b` | — | `{metrics: Metric[]}` |
| E | `POST /proposals/:proposal_id/revisions` | `{incident_id, base_revision, changes, rationale, requested_by}` | `{accepted:true, proposal}` (becomes revision N+1; include a new `plain_summary`) or `{accepted:false, reason}` (spoken to the human) |
| F | `POST /feedback` (header `Idempotency-Key`) | `HumanFeedback` (below) | `{accepted: boolean, reason?}` |

**B: supervisor questions.**
- Questions are arbitrary natural language. Answer only from evidence. If you can't tell causes apart, say so.
- If data is missing, return `INSUFFICIENT_EVIDENCE` and put what's missing in `limitations`.
- You may take as long as you need: after 8 s the gateway tells the human it's still working, and keeps waiting.

**F: human feedback.** This is the final output of the call.

```jsonc
{
  "feedback_id": "fb_…", "idempotency_key": "…",
  "incident_id": "inc-…", "proposal_id": "prop-…", "revision": 2,
  "decision": "APPROVE|REJECT|DEFER",
  "feedback": "Approved. Keep an eye on the trip times though.",   // the human's own words, may be null
  "proposal": { /* the exact revision decided on */ },
  "supervisor_id": "sup-lead-01", "channel": "VOICE|DASHBOARD", "decided_at": "…"
}
```

- **Dedupe on `Idempotency-Key`.** The gateway retries up to 3 times and may redeliver after a crash.
- `DEFER` means "not now". The incident stays open, and the human may decide later, by phone or on the dashboard.

## Mapping onto the team's brain design (CONTEXT/03)

| Harness event or step | What to do |
|---|---|
| The gate passes an edit that needs authority it doesn't have (an envelope collision) | POST an incident with `plain_summary`s, `risk: "HIGH"`, and the envelope key in `editable_parameters` (mock scenario E) |
| `APPROVE` feedback | The harness promotes the brain version or updates the envelope in Atlas |
| `REJECT` or `DEFER` feedback, plus its text | The improver stores it as a preference memory |
