# Harness contract (v1)

This is what the robotics harness (supervisor/improver/gate) must expose to the intervention gateway. Each payload has a Zod schema in `src/shared/schemas.ts`, and that file is authoritative. The mock (`src/server/harness/mock/`) implements this contract, so you can diff your behaviour against it.

**Minimum for the demo:** (A) POST incidents to us; (F) accept decisions; (G) POST execution events back. Everything else can stay mocked: set `HARNESS_MODE=mock` and keep the mock scenarios.

## Direction 1: harness → gateway

Auth: `Authorization: Bearer <HARNESS_TOKEN>`.

### A. `POST /v1/incidents`: raise an incident that needs a human

- `201 {incident_id, duplicate:false}`: stored; the call job is created immediately.
- `200 {incident_id, duplicate:true}`: same `event_id` seen before. Nothing new is created, so it's safe to retry.
- `400 {error_code:"INVALID_PAYLOAD", issues}` · `401` · `409 INCIDENT_CONFLICT` (same `incident_id`/`proposal_id` under a different `event_id`).

```jsonc
{
  "schema_version": "1",
  "event_id": "evt-…",            // unique per delivery attempt group; the dedupe key
  "incident_id": "inc-…",         // stable id
  "task_id": "task:M:PICK:0412", "robot_id": "AMR-07",
  "timestamp": "2026-10-11T10:41:53-07:00",
  "severity": "LOW|MEDIUM|HIGH|CRITICAL",
  "category": "navigation.trajectory_deviation",   // open string; new categories need no gateway change
  "observed_behavior": "…", "expected_behavior": "…", "failure_summary": "…",
  "root_cause_hypothesis": { "text": "…", "confidence": 0.72 },
  "evidence_refs": [{ "id": "ev:A:sep", "kind": "MEASURED|EXPECTED|ESTIMATE|HYPOTHESIS", "summary": "…", "source": "…", "timestamp": "…", "uri": "optional" }],
  "metrics_refs": ["min_human_separation_m"],
  "proposal": {                                      // must be revision 1
    "proposal_id": "prop-…", "revision": 1, "source_agent": "harness-supervisor",
    "summary": "…", "justification": "…", "constraints": ["…"], "risk": "LOW|MEDIUM|HIGH",
    "affected_resources": ["zone:M"], "created_at": "…",
    "changes": [{ "op": "set_param", "key": "planner.lift_lobby.inflation_radius_m", "value": 0.65, "unit": "m" }],
    "editable_parameters": [{
      "key": "planner.lift_lobby.inflation_radius_m", "label": "Lift lobby inflation radius", "unit": "m",
      "type": "number|integer|boolean|enum", "min": 0.3, "max": 0.9, "enum_values": null,
      "current_value": 0.45, "proposed_value": 0.65
    }]
  },
  "responsible_supervisor": { "id": "sup-lead-01", "name": "Robotics Lead" },
  "escalation": { "reason": "why a human is needed", "requires_authority": true },
  "synthetic": false,
  "metadata": { }                                     // free-form; e.g. viewer_url for 3D trajectories
}
```

`editable_parameters` is the key generality mechanism. **You declare what a human may change and the bounds you will accept.** The gateway rejects anything else before it reaches you. Set `risk: "HIGH"` for changes that loosen safety envelopes: voice approval of a HIGH-risk change is held until the supervisor confirms it on the dashboard.

### G. `POST /v1/harness/events`: execution progress for an approved decision

```json
{ "execution_id": "exec-…", "decision_id": "dec_…", "incident_id": "inc-…", "seq": 3,
  "status": "RECEIVED|VALIDATING|ACCEPTED|QUEUED|EXECUTING|APPLIED|FAILED|CANCELLED|REJECTED_BY_HARNESS",
  "detail": "human-readable", "result_metrics": [Metric], "timestamp": "…" }
```

- `seq` must increase per execution. Lower or equal `seq` values are ignored (`{applied:false}`), and terminal statuses never regress.
- **Only `APPLIED` lets the gateway tell the human the change was applied.** Include `result_metrics` (the measured effect) when you can.
- Redelivery is safe.

## Direction 2: gateway → harness (`HARNESS_MODE=http`)

Base URL `HARNESS_BASE_URL`; auth `Authorization: Bearer <HARNESS_OUTBOUND_TOKEN>`. Timeout `HARNESS_TIMEOUT_MS` (default 10 s; supervisor questions get 6×). Responses are schema-validated, and a malformed response counts as an error. A 404 means "not available" and is reported to the human as such.

| Method | Path | Body / query | Response |
|---|---|---|---|
| B | `POST /supervisor/questions` | `{incident_id, task_id, query_id, question}` | `SupervisorAnswer` |
| C | `GET /incidents/:incident_id/trajectory` | — | `Trajectory` or 404 |
| D | `GET /incidents/:incident_id/metrics?keys=a,b` | `keys` optional (substring match is fine) | `{metrics: Metric[]}` |
| E | `POST /proposals/:proposal_id/revisions` | `{incident_id, base_revision, changes: Change[], rationale, requested_by}` | `ReviseResult` |
| F | `POST /decisions` (header `Idempotency-Key`) | `HarnessDecision` | `SubmitDecisionResult` |
| — | `GET /executions/:execution_id` | — | latest `ExecutionEvent` or 404 |

### B. Supervisor question
```json
{ "status": "ANSWERED|INSUFFICIENT_EVIDENCE|UNAVAILABLE", "answer": "…", "evidence_refs": ["ev:…"],
  "confidence": 0.7, "limitations": "what is missing / caveats" }
```
- The question is arbitrary natural language from the human. Answer **only** from evidence, and label measured values vs hypotheses in the text.
- If you can't tell two causes apart, say so. If data is missing, return `INSUFFICIENT_EVIDENCE` with `limitations` saying what's missing and why.
- You may take as long as you need. The gateway answers the voice agent `PENDING` after 8 s and keeps waiting.

### C. Trajectory
`{task_id, robot_id, frame, units, planned:[{t,x,y}], actual:[{t,x,y}], deviations:[{t,x,y,magnitude_m,description,kind}], segments:[{id,label,t_start,t_end}], zones:[{label,x,y,w,h,kind:"area|person|robot|fixture"}], viewer_url?, source, synthetic}`. This is a 2D projection. For 3D/ROS data, also set `viewer_url` (in the trajectory or `incident.metadata`).

### D. Metric
`{key, label, value: number|string|boolean|null, unit, kind, timestamp, source, expected?, history?:[{label,value,timestamp}], note?}`. Use `value:null` with a `note` when a value wasn't recorded; never fill in an estimate silently.

### E. Revise
- The human's requested `changes` were already validated against your `editable_parameters` (type, bounds, unit).
- Reconcile them with your constraints and return either `{accepted:true, proposal: ProposalContent, note?}`, which becomes revision N+1 (the gateway pins `proposal_id`, `revision` and `created_at`), or `{accepted:false, reason}`, which is spoken to the human so they can try something else.
- `{op:"request", text}` is a free-text request. Interpret it or refuse it.
- **Never execute anything on revise.**

### F. Decision
```jsonc
{ "decision_id": "dec_…", "idempotency_key": "…", "incident_id": "…", "proposal_id": "…", "revision": 2,
  "decision": "APPROVE|REJECT|DEFER|REQUEST_MORE_INFORMATION",
  "proposal": ProposalContent /* the exact approved revision */, "supervisor_id": "sup-lead-01",
  "identity_method": "VOICE_PIN|DASHBOARD_SESSION", "channel": "VOICE|DASHBOARD", "reason": null, "decided_at": "…" }
```
Respond `{accepted, execution_id?, status?, reason?}`. The rules:

- **Dedupe on `Idempotency-Key`.** We may redeliver after a crash; the same key must not execute twice.
- Only `APPROVE` may start an execution. The other decisions are informational.
- Re-validate the approved change against your own safety envelope. Refuse with `accepted:false` (immediately) or emit a `REJECTED_BY_HARNESS` event (later).
- Then POST execution events (G).

## How this maps onto the team's brain design (CONTEXT/03)

- **Trigger:** when the gate passes an edit that needs authority it doesn't have (an envelope collision), POST an incident. Use `risk: "HIGH"` for envelope loosening, and list the envelope key in `editable_parameters` (see mock scenario E).
- **On APPROVE:** the harness writes the new envelope or brain version in Atlas and reports `APPLIED` with the gate's held-out score as `result_metrics`.
- **On REJECT/DEFER:** the improver records it as a preference memory.
