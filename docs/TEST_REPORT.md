# Test report

Run 2026-10-11 12:12 PDT on WSL2 Ubuntu, Node 24.18, MongoDB 8.2.6 (mongodb-memory-server replica set). `npm test`: **39 passed, 0 failed** (2 files, ~8 s). Type check (`tsc --noEmit`, TS 7.0.2) is clean, and the dashboard production build succeeds.

## What the automated tests exercise

The tests run against real HTTP routes (Fastify `inject`), with the real MongoDB transactions and indexes and the real domain services. The test code plays the ElevenLabs agent, calling `/v1/agent-tools/*` exactly as the provider would (tool secret, dynamic-variable ids, conversation id). Calls use `ScriptedCallProvider` (auto-answer) or `SimulatedCallProvider` (ring timeout). The harness is `MockHarness` with the deterministic `FactLookupSupervisor`. **No ElevenLabs, Twilio, Anthropic or Atlas calls are made.**

| Brief test | Result | What is asserted |
|---|---|---|
| 1 Proactive trigger | PASS | 201 then 200 `duplicate:true` for the same `event_id`; three concurrent placement attempts produce exactly one call; 401 on a bad token; 400 on an invalid payload, with nothing stored |
| 2 Dynamic context | PASS | Categories A and B through the same tools return their own context; identity gate (`IDENTITY_REQUIRED`, 3-strike lock → 403); wrong tool secret → 401; a call bound to another incident → 403 |
| 3 Arbitrary question | PASS | The question text reaches `MockHarness.askSupervisor`, and the answer and evidence ids are returned. A slow supervisor gives `PENDING`; a retry reuses the same `query_id` (supervisor asked once); `get_supervisor_answer` returns the answer |
| 4 Trajectory | PASS | The right task's trajectory (deviation at 41.2 s, 0.48 m, MEASURED); `trajectory.focus` event emitted for the dashboard; `/api/incidents/:id/trajectory` serves the points; with no trajectory → `available:false` |
| 5 Metrics | PASS | Value 18.4, unit N, kind MEASURED, expected 25, timestamp, source; an unknown metric → `available:false` |
| 6 Modification | PASS | Revision 2 created via the harness, with no harness decision and no execution; a replay returns the same revision; out-of-bounds, unit mismatch, unknown parameter and harness refusal create no revision |
| 7 Approval | PASS | "yeah sure" and "I do not approve revision 1" are refused; the approval is persisted; before dispatch, `applied:false`; a retry is replayed; concurrent dispatch delivers exactly **one** APPROVE to the harness; RESOLVED only after harness events; HIGH-risk approval is held until dashboard confirmation |
| 8 Rejection | PASS | CLOSED_REJECTED; the harness receives only a REJECT notice; no executions; a later approval is refused |
| 9 Stale revision | PASS | Approving rev 1 when rev 2 exists → `STALE_REVISION` with `latest_revision:2`; rev 7 → `UNKNOWN_REVISION`; revise on a stale base → `REVISION_CONFLICT` |
| 10 Unknown information | PASS | Lidar question on scenario D → `INSUFFICIENT_EVIDENCE`, `answer:null`, the limitation explains the logs were not retained, and the instruction says "Do not guess" |
| 11 Interruption | PASS | Hang-up after a revision → AWAITING_DECISION, no final decision, nothing sent to the harness, tools for the ended call refused; unanswered → one retry → UNREACHED |
| 12 Execution outcome | PASS | Scenario A → RESOLVED (APPLIED); scenario B → EXECUTION_FAILED with the harness detail; a late lower-`seq` event can't regress APPLIED; harness refusal → HARNESS_REJECTED |
| 13 Voice/dashboard consistency | PASS | A dashboard revision is read by the voice tool; a voice revision appears in the dashboard aggregate with the correct statuses and sources; a stale dashboard approval → 409; simultaneous voice and dashboard approvals → exactly one final decision |
| 14 Concurrent incidents | PASS | Four incidents in parallel: decisions, executions and harness payloads stay tied to their own proposal; a cross-incident tool call → 403 |
| Post-call webhook | PASS | Bad signature → 401; valid → stored; redelivery → `duplicate:true`; a summary saying "approve" records **no** decision |
| Unit: confirmation, validation, state machine, signature | PASS (13) | See `tests/unit/guards.test.ts` |

## Manual verification against the running server

These checks used `npm run dev`-equivalent processes, `curl`, `scripts/trigger.ts`, `scripts/simulate-agent.ts`, and headless Chromium screenshots:

- Trigger → dedupe → the softphone rings (screenshot: incoming-call card with countdown, Answer/Decline).
- Full flow over real HTTP: answer → identity gate → verify → `ask_supervisor` → revise to rev 2 → stale approve refused → approve rev 2 → harness RECEIVED…APPLIED → RESOLVED. SSE carried every event type (13 distinct types observed).
- `simulate:agent` offline fallback on scenario A: RESOLVED with rev 1 SUPERSEDED, rev 2 APPROVED.
- A real browser session (yours) answered and hung up a ringing call. The gateway recorded `hung up by human` and returned the incident to AWAITING_DECISION with no decision.
- Dashboard rendered with **no console errors**. Found and fixed: the static server didn't serve rebuilt assets, which caused a blank page after a rebuild.

## NOT verified (gaps)

| Gap | Why | How to close |
|---|---|---|
| **Live ElevenLabs voice conversation** | No API key in this environment yet | Set the key, `ngrok http 8787`, `npm run provision:agent`, then run DEMO §2 and record the result here |
| `provision-agent.ts` against the real API | Same; only type-checked against SDK 2.71 | Run it; if the API rejects a field, use the manual fallback in ELEVENLABS_SETUP |
| `system__conversation_id` delivered in browser-session tool calls | Needs a live session | Check that `call.connected` / binding appears in the audit log; the `call_id` binding works regardless |
| Claude-grounded mock supervisor | No Anthropic key here; tests use the deterministic brain | Set `ANTHROPIC_API_KEY`, ask scenario A questions, and confirm the answers cite evidence ids |
| MongoDB Atlas | No URI yet; the same driver and transactions run on the in-memory replica set | Set `MONGODB_URI`, then restart and check that incidents survive the restart |
| Twilio / PSTN | Out of scope by decision | See ELEVENLABS_SETUP §6 |
| Real robotics harness | Not built yet | Implement `docs/HARNESS_CONTRACT.md`, then set `HARNESS_MODE=http` |
| Agent behaviour quality (does the LLM always use tools, read units, and ask for "I approve revision N"?) | Needs live conversations | Run the DEMO script several times; transcripts are stored on each call |
