# Hackathon runbook

This is the step-by-step for running the gateway against the team's real harness, with or without ElevenLabs. Everything here was exercised on the demo laptop (Node 24, cloudflared at `/opt/homebrew/bin/cloudflared`). The authoritative contract is `docs/HARNESS_CONTRACT.md` and the Zod schemas in `src/shared/schemas.ts`.

Four modes matter, and they are independent switches in `.env`:

| Switch | Values | What it changes |
|---|---|---|
| `HARNESS_MODE` | `mock` / `http` | Who answers questions, authors revisions and receives feedback: the in-process mock, or the real harness at `HARNESS_BASE_URL`. |
| `CALL_MODE` | `simulated` / `scripted` | `simulated` rings the dashboard softphone and waits for a human (or `simulate:agent`) to answer. `scripted` auto-answers the call instantly (used by the tests). |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` | set / empty | Set: answering in the browser starts a real voice session. Empty: answering shows "voice not configured" and the human decides on the dashboard. |
| `MONGODB_URI` | `memory` / Atlas URI | Nothing persists with `memory`. Use `.env.atlas.example` for Atlas. |

## (a) Run with the real harness (`HARNESS_MODE=http`)

`gateway/.env` is already written for this: `PORT=8787`, `HARNESS_MODE=http`, `HARNESS_BASE_URL=http://localhost:8000`, `HARNESS_TOKEN=dev-harness-token-change-me` (what the harness sends to us), `HARNESS_OUTBOUND_TOKEN=harness-outbound-dev-token-0001` (what we send to the harness), `CALL_MODE=simulated`, `MONGODB_URI=memory`.

1. Start the harness on port 8000 with routes B–F from section (d) below. It must accept `Authorization: Bearer harness-outbound-dev-token-0001` on those routes.
2. Start the gateway and dashboard:
   ```bash
   cd gateway
   npm install
   npm run dev          # gateway http://localhost:8787 (API), dashboard http://localhost:5173 (Vite, proxies /api, /v1, /dev)
   ```
   The log line `[gateway] harness=http calls=simulated elevenlabs=not configured` confirms the mode. Note that the "Simulate incident" dropdown disappears in http mode: scenarios only exist in the mock.
3. The harness raises an incident with `POST http://localhost:8787/v1/incidents` (route A, exact curl in section (c)). The dashboard rings on its own.
4. Give the human a deep link so the right incident opens with the ring UI already up: `http://localhost:5173/?incident=<incident_id>`. The page polls the list for up to 30 s if the incident is still in flight, then selects it. If the call is still ringing it opens straight into the call screen with the Answer button focused.
5. Decide on the call (voice) or on the right-hand panel (Approve / Reject / Not now, or "Change a value…" first). Feedback (route F) is delivered once and shows "✓ delivered" under "Sent to the supervisor".

For a durable run, copy `.env.atlas.example` over `.env`, fill in the Atlas URI, keep everything else, and run `npm run check:setup` to confirm transactions work.

## (b) Provision the ElevenLabs agent (once keys are present)

ElevenLabs calls the four webhook tools over the public internet, so the gateway needs an https URL. `npm run tunnel` now runs plain `cloudflared` from `PATH` (`/opt/homebrew/bin/cloudflared` here; the old script hard-coded `~/.local/bin/cloudflared`).

1. In `.env` set `ELEVENLABS_API_KEY=` (key with Agents read/write) and leave `ELEVENLABS_AGENT_ID` empty on the first run. `TOOL_SECRET` is already a random 48-hex value.
2. Start the gateway (`npm run dev`), then in a second terminal:
   ```bash
   npm run tunnel
   ```
   Copy the printed `https://<random>.trycloudflare.com` URL into `PUBLIC_BASE_URL` in `.env`. The provisioning script refuses anything that is not `https://`.
3. Provision (idempotent, safe to re-run):
   ```bash
   npm run provision:agent
   ```
   It creates/updates the workspace secret `intervention_gateway_tool_auth` (= `Bearer $TOOL_SECRET`), the four tools (`ask_supervisor`, `show_trajectory`, `change_plan`, `send_feedback`) pointing at `$PUBLIC_BASE_URL/v1/agent-tools/<name>`, and the agent "Robotics Intervention Gateway" from `agent/system-prompt.md`. On the first run it prints `ELEVENLABS_AGENT_ID=...`.
4. Put that id in `.env` and restart the gateway (the `tsx watch` dev server does not reload `.env`; stop and re-run `npm run dev`). `npm run check:setup` should now print "Signed URL can be minted".
5. Re-run `npm run provision:agent` every time the tunnel URL changes (every `npm run tunnel` restart gives a new one) or the prompt changes.
6. Optional: register the post-call webhook in the ElevenLabs dashboard at `$PUBLIC_BASE_URL/v1/webhooks/elevenlabs` and put its HMAC secret in `ELEVENLABS_WEBHOOK_SECRET`. It only enriches the call record.

Answering a call in the browser then asks for microphone permission and starts the voice session; the call screen shows the agent's speaking indicator and your mic level. Use a headset.

## (c) End-to-end without ElevenLabs

There are two ways. Pick by what you want to exercise.

### c1. `npm run simulate:agent` (recommended; requires `CALL_MODE=simulated`)

`scripts/simulate-agent.ts` plays the agent's side through the real tool endpoints: it answers the ringing call, posts transcript lines, calls `ask_supervisor`, `show_trajectory`, `change_plan` and `send_feedback`, then ends the call. The dashboard updates live, so you can watch the call screen while it runs.

Important: the script looks for a call in status `RINGING` and refuses otherwise ("No ringing call for this incident"). With `CALL_MODE=scripted` the gateway auto-answers, so the script never finds a ringing call. Keep `CALL_MODE=simulated` (the value in `.env`) for this path, and do not click Answer in the browser.

1. Gateway running (`npm run dev`), `.env` as written (`CALL_MODE=simulated`).
2. Raise an incident as the harness. Minimal valid body (every required field of `IncidentInput`; optional fields with defaults such as `evidence_refs`, `metrics_refs`, `constraints`, `affected_resources`, `synthetic`, `metadata` are omitted). Save it as `incident.json`:
   ```json
   {
     "schema_version": "1",
     "event_id": "evt-demo-0001",
     "incident_id": "inc-demo-0001",
     "task_id": "task:M:PICK:0412",
     "robot_id": "AMR-07",
     "timestamp": "2026-10-11T10:41:53-07:00",
     "severity": "HIGH",
     "category": "navigation.trajectory_deviation",
     "observed_behavior": "AMR-07 cut the corner in the lift lobby and passed 0.62 m from a worker.",
     "expected_behavior": "Keep at least 1.0 m clearance from people in the lift lobby.",
     "failure_summary": "Lift-lobby clearance violation: 0.62 m measured against a 1.0 m minimum.",
     "plain_summary": "Robot AMR-07 cut a corner in the lift area and came within 62 centimetres of a worker, when it should keep at least a metre away.",
     "root_cause_hypothesis": { "text": "Inflation radius in the lift lobby is too small for the corner geometry.", "confidence": 0.72 },
     "proposal": {
       "proposal_id": "prop-demo-0001",
       "revision": 1,
       "source_agent": "harness-supervisor",
       "risk": "LOW",
       "summary": "Set planner.lift_lobby.inflation_radius_m from 0.45 to 0.65.",
       "plain_summary": "Give the robot a wider safety margin in the lift area, 0.65 metres instead of 0.45, which adds about 2 seconds per trip.",
       "justification": "A larger inflation radius keeps the planned path further from the wall and from people at the corner.",
       "created_at": "2026-10-11T10:41:55-07:00",
       "changes": [{ "op": "set_param", "key": "planner.lift_lobby.inflation_radius_m", "value": 0.65, "unit": "m" }],
       "editable_parameters": [{
         "key": "planner.lift_lobby.inflation_radius_m", "label": "Lift lobby safety margin", "unit": "m", "type": "number",
         "min": 0.3, "max": 0.9, "current_value": 0.45, "proposed_value": 0.65
       }]
     },
     "responsible_supervisor": { "id": "sup-lead-01", "name": "Robotics Lead" },
     "escalation": { "reason": "Changing a safety envelope needs human authority.", "requires_authority": true }
   }
   ```
   ```bash
   curl -s -X POST http://localhost:8787/v1/incidents \
     -H "Authorization: Bearer dev-harness-token-change-me" \
     -H "content-type: application/json" \
     --data @incident.json
   # → 201 {"incident_id":"inc-demo-0001","duplicate":false}   (200 + duplicate:true on a retry with the same event_id)
   ```
   Field rules worth knowing: `timestamp` and `created_at` must be ISO-8601 with an offset; `plain_summary` is at most 400 characters; `category` is any string up to 80 characters; `editable_parameters[].type` is one of `number | integer | boolean | enum`. A 400 lists every failing path. In `HARNESS_MODE=mock` you can instead run `npm run trigger -- A` (scenarios A–E) and read the printed id.
3. Play the agent (the script reads `PORT` and `TOOL_SECRET` from `.env`; `TOOL_SECRET` must match the gateway's):
   ```bash
   npm run simulate:agent -- inc-demo-0001 approve     # or reject | defer | hangup
   ```
   Expected tail: `send_feedback → {"ok":true,"sent":true,...}` then `📴 call ended`, and the incident shows Approved with "✓ delivered". With the real harness, `ask_supervisor` and `change_plan` hit routes B and E; with the mock and a hand-written incident id they return `UNAVAILABLE` / "could not be reached", which is expected (the mock only knows scenarios A–E).

### c2. `CALL_MODE=scripted` + manual tool calls

Use this when you want to script the loop yourself (for example from the harness repo's own tests). Set `CALL_MODE=scripted`, restart, POST the incident; the call is answered immediately with `conversation_id = scripted-<call_id>`. Read the `call_id` from `GET /api/incidents/<id>` (`calls[-1]._id`) and call the tools directly:

```bash
curl -s -X POST http://localhost:8787/v1/agent-tools/send_feedback \
  -H "Authorization: Bearer $TOOL_SECRET" -H "content-type: application/json" \
  -d '{"incident_id":"inc-demo-0001","call_id":"<call_id>","revision":1,"decision":"APPROVE","feedback":"Approved."}'
```

Business errors come back as `200 {ok:false, error_code, message}`; a wrong `call_id`/`incident_id` pair is a 403.

## (d) What the harness must expose (routes B–F)

Base URL `HARNESS_BASE_URL` (`http://localhost:8000`); every request carries `Authorization: Bearer <HARNESS_OUTBOUND_TOKEN>`. Responses are validated against the schemas named below; a 404 is read as "not available" rather than an error. Minimum for a demo is A (POST to us) and F.

| | Route | Request body | Response (schema) | Notes |
|---|---|---|---|---|
| B | `POST /supervisor/questions` | `{incident_id, task_id, query_id, question}` | `{status: "ANSWERED"\|"INSUFFICIENT_EVIDENCE"\|"UNAVAILABLE", answer?, evidence_refs: string[], confidence?, limitations?}` (`SupervisorAnswer`) | Free-text question from the human. Take as long as needed: after 8 s the agent tells the human it is still waiting. If data is missing return `INSUFFICIENT_EVIDENCE` with `limitations`. 404 → spoken as "no supervisor endpoint". |
| C | `GET /incidents/:id/trajectory` | — | `Trajectory` (`task_id, robot_id, planned[], actual[], deviations[], segments[], zones[], source`) or 404 | Drives "show me the path" on the dashboard. 404 makes the agent say there is no path. |
| D | `GET /incidents/:id/metrics?keys=a,b` | — | `{metrics: Metric[]}` (`key, label, value, unit, kind, timestamp, source, expected?, history?`) | Shown in "Technical details" and read into the agent's context. 404 → empty list. |
| E | `POST /proposals/:proposal_id/revisions` | `{incident_id, base_revision, changes: Change[], rationale, requested_by}` | `{accepted:true, proposal: ProposalContent}` with `revision = base_revision + 1` and a new `plain_summary`, or `{accepted:false, reason}` | Called when the human changes a value by voice or dashboard. The gateway has already checked bounds/units against `editable_parameters`. The refusal `reason` is spoken to the human. |
| F | `POST /feedback` (header `Idempotency-Key`) | `HumanFeedback`: `{feedback_id, idempotency_key, incident_id, proposal_id, revision, decision: APPROVE\|REJECT\|DEFER, feedback, proposal, supervisor_id, channel: VOICE\|DASHBOARD, decided_at}` | `{accepted: boolean, reason?}` (`FeedbackAck`) | The final output. Dedupe on `Idempotency-Key`: the gateway retries 3 times with backoff and may redeliver after a restart. `DEFER` means the incident stays open. |

Timeouts: `HARNESS_TIMEOUT_MS` (10 s) for C, D, E, F; six times that for B. The mock in `src/server/harness/mock/mock-harness.ts` implements the same five routes in-process and is the reference behaviour.

## Quick checks before the demo

```bash
npm run typecheck && npm test        # 27 tests, in-memory MongoDB, no network
npm run check:setup                  # Atlas + ElevenLabs credentials (only when set)
curl -s localhost:8787/api/config    # harness / call_mode / elevenlabs_configured as expected
```

If the dashboard shows "voice not configured" that is `ELEVENLABS_*` being empty, not an error. If a ringing call is lost after a page reload, reopen the deep link; the page rebuilds the ring from the incident's call record.
