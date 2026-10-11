# Architecture

## 1. Boundaries and responsibilities

```
 Robotics harness (supervisor = domain intelligence)          ElevenLabs Agents (conversation only)
   │ POST /v1/incidents          ▲ HarnessAdapter calls         │ webhook tools ──► POST /v1/agent-tools/:tool
   │ POST /v1/harness/events     │ (ask, trajectory, metrics,   │ post-call     ──► POST /v1/webhooks/elevenlabs
   ▼                             │  revise, submitDecision)      ▲ voice (browser WebSocket session)
 ┌─────────────────────────── Gateway: one Fastify process (trusted coordinator) ─────────┐
 │ routes/      harness.ts · agent-tools.ts · api.ts (+SSE) · webhooks.ts · dev.ts         │
 │ domain/      IncidentService · ProposalEngine · DecisionService · DecisionDispatcher    │
 │              ExecutionTracker · SupervisorQueries · IdentityService · EventLog          │
 │ calls/       CallOrchestrator → CallProvider {Simulated | Scripted | Twilio(stub)}      │
 │ harness/     HarnessAdapter {MockHarness | HttpHarnessAdapter}                          │
 └──────────────────────────── MongoDB (Atlas) ──────────────────────────────────────────┘
                                         ▲ SSE /api/stream
 Dashboard (React): incidents · evidence · trajectory · metrics · proposal editor · decisions · softphone
```

| Component | Owns | Never does |
|---|---|---|
| Harness supervisor | Diagnosis, answers, authoring revisions, validating and executing changes | Gets told what to execute by voice text |
| ElevenLabs agent | Speech, turn-taking, choosing which generic tool to call | Holds state, decides, or invents facts |
| Gateway | Incident state, revisions, decisions, identity, audit, call lifecycle, delivery to the harness | Executes robot changes or interprets free-text config |
| Dashboard | Human inspection and edits through the same engine | Bypasses the engine |

## 2. Sequence (happy path, scenario A)

```
Harness        Gateway                         Dashboard/Softphone      ElevenLabs agent
  │ POST /v1/incidents ─► validate, dedupe(event_id), txn{incident, head, rev1, audit}
  │                     ► CallOrchestrator: insert call (1 active/incident) → provider.place → RINGING
  │                     ─── SSE call.ringing ─────────────► rings
  │                                                         Answer ─► POST /api/calls/:id/answer → signed_url + dyn vars
  │                                                         startSession(signedUrl, dynamicVariables) ───────► first message
  │                     ◄──────────────────────────────────────────────────────── verify_identity(code)
  │                     ◄──────────────────────────────────────────────────────── get_incident
  │ ◄ askSupervisor ─── ask_supervisor(question) ◄──────────────────────────────── (≤8 s or PENDING)
  │                     ◄──────────────────────────────────────────────────────── get_trajectory → SSE trajectory.focus
  │ ◄ reviseProposal ── revise_proposal(base=1, key, value, unit) → head RECONCILING → rev2 → SSE proposal.revised
  │                     ◄──────────────────────────────────────────────────────── submit_decision(rev 2, APPROVE, "I approve revision 2")
  │                       txn{head CAS DECIDED, rev2 APPROVED, decision(outbox PENDING), incident SUBMITTED}
  │ ◄ submitDecision(idempotency_key) ── DecisionDispatcher (lease, retry ≤3)
  │ POST /v1/harness/events seq 0..4 (RECEIVED…APPLIED) → ExecutionTracker → incident RESOLVED → SSE
  │                     ◄──────────────────────────────────────────────────────── get_execution_status → applied=true
```

## 3. API contracts

- Schemas: `src/shared/schemas.ts` (Zod, `schema_version: "1"`). Every external payload is parsed at the route edge.
- Harness ↔ gateway: `docs/HARNESS_CONTRACT.md`.
- Voice tools: `agent/agent-config.ts` defines the source of truth. Bodies always carry `incident_id` and `call_id` (dynamic variables) plus `conversation_id` (`system__conversation_id`). Business errors return `200 {ok:false, error_code, message}` so the agent can speak them; auth and binding failures return 401/403.
- Dashboard: `GET /api/incidents`, `GET /api/incidents/:id` (aggregate), `GET /api/incidents/:id/{trajectory,metrics}`, `POST /api/incidents/:id/{questions,revisions,decisions,call}`, `POST /api/decisions/:id/confirm`, `POST /api/calls/:id/{answer,decline,connected,end,transcript}`, `GET /api/stream` (SSE).

## 4. State machines (enforced in `domain/state.ts` by compare-and-set on `state`)

**Incident**

```
RECEIVED → CALL_PENDING → CALLING → IN_CALL → AWAITING_DECISION ⇄ (CALL_PENDING → CALLING → IN_CALL)
CALLING → CALL_PENDING (retry) | UNREACHED (retries exhausted)
{CALL_PENDING, CALLING, IN_CALL, AWAITING_DECISION, DEFERRED, UNREACHED} ──decision──►
      APPROVE (low/med risk, or dashboard) → SUBMITTED
      APPROVE (HIGH risk by voice)         → AWAITING_CONFIRMATION → (dashboard confirm) → SUBMITTED
      REJECT → CLOSED_REJECTED     DEFER → DEFERRED     REQUEST_MORE_INFORMATION → (no change)
SUBMITTED → EXECUTING → RESOLVED | EXECUTION_FAILED | HARNESS_REJECTED      (only harness events move these)
```
Terminal: RESOLVED, EXECUTION_FAILED, HARNESS_REJECTED, CLOSED_REJECTED. An ended call only ever moves IN_CALL → AWAITING_DECISION.

**Proposal**: the head (`proposal_heads`) is `UNDER_REVIEW ⇄ RECONCILING` (during harness reconciliation) `→ DECIDED`. Revisions (`proposal_revisions`, immutable content) go `PENDING_REVIEW → SUPERSEDED | APPROVED | REJECTED`.

**Call**: `QUEUED → RINGING → ANSWERED → ENDED`, or `RINGING → NO_ANSWER | DECLINED | FAILED`. The `active` flag plus a partial unique index allow one active call per incident.

**Execution**: harness-owned (`RECEIVED, VALIDATING, ACCEPTED, QUEUED, EXECUTING, APPLIED, FAILED, CANCELLED, REJECTED_BY_HARNESS`). Events apply only if `seq` exceeds the stored value, and terminal states never regress.

**Decision delivery (outbox)**: `NOT_REQUIRED | HELD → PENDING → SENDING (leased) → ACKED`, or `PENDING` again with backoff, or `FAILED` after 3 attempts.

## 5. Data model (MongoDB, db `intervention_gateway`)

| Collection | Key | Notes / indexes |
|---|---|---|
| `incidents` | `_id = incident_id` | immutable `incident` payload + mutable `state`, `call_attempts`, `next_call_at`; uniq `event_id` |
| `proposal_heads` | `_id = proposal_id` | `latest_revision`, `state`, `decided_revision`, `version`: the concurrency anchor |
| `proposal_revisions` | `${proposal_id}#${rev}` | uniq `(proposal_id, revision)`; `content` is authored by the harness |
| `decisions` | `dec_*` | uniq `idempotency_key`; **partial uniq `proposal_id` where `final`** (no double approval); embedded outbox `submission` |
| `calls` | `call_*` | **partial uniq `incident_id` where `active`**; uniq `conversation_id`; identity flag, PIN failures, transcript (display only), `post_call` |
| `executions` | `execution_id` | `status`, `seq`, `events[]`, `result_metrics` |
| `supervisor_queries` | `q_*` | question, status, result (used for PENDING and dedupe) |
| `audit_events` | ObjectId | append-only audit, and the SSE replay log |
| `supervisors` | supervisor id | scrypt PIN hash (demo identity factor) |
| `webhook_receipts` | `${type}:${conversation_id}` | dedupes post-call redelivery |

Multi-document changes (ingest, revise, decide, deliver, execution event) run in **transactions**, which need a replica set: Atlas has one, and tests and dev use `MongoMemoryReplSet`. Audit events are written inside the transaction and published to SSE after commit.

## 6. Authentication boundaries

| Caller | Mechanism | Demo simplification |
|---|---|---|
| Harness → gateway | `Authorization: Bearer HARNESS_TOKEN` | Shared secret; production should use mTLS or signed requests |
| ElevenLabs tools → gateway | Bearer `TOOL_SECRET` from an ElevenLabs workspace secret, **plus** the incident/call/conversation binding check | — |
| ElevenLabs webhook → gateway | `ElevenLabs-Signature` HMAC-SHA256 over `t.rawBody`, 30 min tolerance | — |
| Human on the phone | 4–8 digit PIN, server-side flag, 3-strike lock; HIGH risk also needs dashboard confirmation | PIN passes through ASR, the LLM and the transcript |
| Dashboard | Optional `DASHBOARD_TOKEN`; actions are attributed to the responsible supervisor | No SSO |
| Gateway → harness | `Bearer HARNESS_OUTBOUND_TOKEN`, `Idempotency-Key` header on decisions | — |
| Browser → ElevenLabs | Short-lived signed URL minted server-side | API key never reaches the browser |

## 7. Webhook tools vs MCP (decision)

| Criterion | Webhook tools (chosen) | MCP server |
|---|---|---|
| Implementation time | Routes we need anyway; tested with `inject` | Extra server, transport and ElevenLabs MCP registration |
| Flexibility | Generic tools; per-incident content is data | Dynamic discovery we don't need |
| Latency | One HTTP hop | Similar, plus session handshake |
| Auth | Per-tool secret header (SDK-verified) | Server-level; per-call binding is still ours |
| Dynamic discovery | Not needed: the contract is the tool list | Main benefit |
| Ops complexity | Low | Higher |
| Provider restrictions | None found | MCP tool approval and timeout semantics differ (changelog) |
| Extensibility | Add a route plus a `TOOLS` entry | Better if the harness itself exposes MCP tools later |

## 8. Failure recovery

| Failure | Behaviour |
|---|---|
| Duplicate trigger | uniq `event_id` → 200 `{duplicate:true}`, no new call (Test 1) |
| Invalid or unauthorized trigger | 400 with issues (audited) / 401 (Test 1) |
| Concurrent call placement | partial uniq index → second insert is a no-op (Test 1) |
| No answer / declined / provider error | one retry after `CALL_RETRY_DELAY_MS`, then UNREACHED (Test 11b) |
| Hang-up or drop before a decision | AWAITING_DECISION; tools for that call are refused (Test 11) |
| Slow supervisor | PENDING + poll; hard timeout reports UNAVAILABLE (Test 3b) |
| Supervisor down | `UNAVAILABLE` with a speakable limitation |
| Malformed tool args | `{ok:false, INVALID_ARGUMENTS}` |
| Tool retry after success | revise: replay returns the same revision; decide: same idempotency key returns the original (Tests 6, 7) |
| Voice/dashboard conflict | `REVISION_CONFLICT` / `STALE_REVISION` (Tests 9, 13) |
| Double approval | partial uniq index + head CAS (Test 13b) |
| Harness refuses a revision | no revision created; reason spoken (Test 6b) |
| Harness refuses or fails an approved change | HARNESS_REJECTED / EXECUTION_FAILED (Test 12) |
| Gateway crash mid-delivery | lease expiry → redelivery with the same idempotency key; the harness must dedupe |
| Gateway crash mid-reconciliation | RECONCILING lock released after 2× harness timeout |
| Reordered or late execution events | `seq` guard; terminal states never regress (Test 12) |
| Webhook redelivery | `webhook_receipts` (post-call test) |
| Untrusted tool text | prompt rule; gateway never executes text; revisions only come from the harness |

## 9. Key trade-offs

- **Simulated phone leg** (team decision): keeps real voice, AI-initiated calls and live tools; drops PSTN-specific risk (Twilio trial limits, AMD).
- **MongoDB instead of Postgres**: Atlas is mandatory for hackathon finalists and already holds the team's brain. Transactions plus partial unique indexes give the same guarantees we would have used Postgres for.
- **Transactions instead of single-document-only writes** (changed from plan D7): simpler correctness for multi-collection decisions; costs a replica set in tests.
- **Re-read on event instead of pushing diffs over SSE**: the dashboard always shows authoritative state, at the cost of a few extra GETs.
- **Ten generic tools**: the agent never needs domain knowledge; harness-declared `editable_parameters` make new incident categories pure data.
