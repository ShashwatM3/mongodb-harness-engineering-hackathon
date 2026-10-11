# Architecture

The gateway is a simple loop:

1. Get the human on the phone.
2. Tell them what happened and what's proposed, in plain words.
3. Answer their questions.
4. Let them change, approve, reject or postpone the plan.
5. Send their feedback back to the supervisor.

Executing the change is the harness's business, not the gateway's.

## 1. Boundaries

```
 Robotics harness (supervisor = domain intelligence)            ElevenLabs Agents (voice only)
   │ POST /v1/incidents            ▲ HarnessAdapter:              │ webhook tools → POST /v1/agent-tools/:tool
   ▼                               │ ask, trajectory, metrics,    │ post-call     → POST /v1/webhooks/elevenlabs
 ┌───────────── Gateway (one Fastify process) ───────┴────────────┼──────────────┐
 │ IncidentService · ProposalEngine · DecisionService (feedback) · FeedbackDispatcher (outbox)
 │ SupervisorQueries · briefing (opening + context) · CallOrchestrator · EventLog (audit + SSE)
 └──────────────────────────────── MongoDB Atlas ─────────────────────────────────────────┘
                                         ▲ SSE /api/stream
 Dashboard (React): incident list · plain summary · proposed fix + Approve/Reject/Not now · feedback sent · call transcript · softphone
```

**Who does what:**
- **Supervisor (harness):** diagnoses, answers, authors plan revisions, acts on feedback.
- **Voice agent:** talks and picks one of four generic tools. It never decides or invents.
- **Gateway:** owns incident state, revisions, feedback, call lifecycle and audit.
- **Dashboard:** uses the same engine as voice.

## 2. A call, start to finish

1. The harness POSTs an incident. The gateway stores it (deduped on `event_id`) and places a call: the dashboard softphone rings.
2. **Answer:** the gateway builds the session from whatever the harness sent (`domain/briefing.ts`), with no per-category code:
   - `incident_brief` and `proposal_brief`: the 1–2 sentence plain-language summaries (`plain_summary`, falling back to the technical summary);
   - `incident_context`: everything else as readable text (what happened, diagnosis and confidence, evidence, metrics, path deviations, the plan's settings with allowed ranges);
   - `current_revision`.
3. The agent's first message is fixed: *"Hi {name}, this is the fleet supervisor. {incident_brief} The proposed fix: {proposal_brief} Do you want to approve it, change it, or ask me anything?"*
4. Follow-up questions are answered from `incident_context` in 1–2 sentences. Anything else goes through `ask_supervisor`.
5. `show_trajectory` opens the path on the dashboard. `change_plan` sends a typed setting change to the supervisor and gets back revision N+1, or a refusal with a reason.
6. `send_feedback(revision, APPROVE|REJECT|DEFER, feedback)` records the decision plus the human's words against that exact revision. A transactional outbox then delivers it to the harness (`submitFeedback`) exactly once.
7. A hang-up without a decision → AWAITING_DECISION. Nothing is ever inferred from silence or a dropped call.

## 3. Voice tools (`agent/agent-config.ts`)

| Tool | Does |
|---|---|
| `ask_supervisor(question)` | Question → harness supervisor. Returns the answer, `INSUFFICIENT_EVIDENCE` (+ what's missing), or `PENDING` (re-ask later; deduped) |
| `show_trajectory(segment?)` | Pushes the path to the dashboard, or says there is none |
| `change_plan(parameter_key, new_value, unit?, reason?)` | Validated against harness-declared bounds and units, then reconciled by the harness into a new revision |
| `send_feedback(revision, decision, feedback?)` | Records and queues the feedback. A stale revision → `STALE_REVISION` with the new plan in words |

**Binding and auth:**
- Every call carries `incident_id`, `call_id` and `conversation_id`, filled by the platform from dynamic variables, not by the LLM. Mismatches → 403.
- Auth is a bearer secret held as an ElevenLabs workspace secret.
- Business errors are `200 {ok:false, error_code, message}`, so the agent can say them.

**Background voices** (ElevenLabs has no speaker-isolation setting):
- `turn_eagerness: patient`;
- `interruption_ignore_terms` for back-channel sounds;
- tools use `interruption_mode: disable_during_tool`;
- ASR keyword boost for decision words;
- browser echo cancellation and noise suppression;
- a prompt rule to ignore speech not directed at the agent;
- and, most effective, a headset.

## 4. State

**Incident:**
```
CALL_PENDING → CALLING → IN_CALL → AWAITING_DECISION ⇄ (call again)
CALLING → CALL_PENDING (one retry) | UNREACHED
any open state ──feedback──► APPROVED | REJECTED (terminal) | DEFERRED (open; can be called/decided again)
```

**Plan:** the head (`proposal_heads`) goes `UNDER_REVIEW ⇄ RECONCILING → DECIDED`. Revisions are immutable; their status is `PENDING_REVIEW → SUPERSEDED | APPROVED | REJECTED`.

**Call:** `QUEUED → RINGING → ANSWERED → ENDED`, or `RINGING → NO_ANSWER | DECLINED | FAILED`. One active call per incident (partial unique index). Answering issues an `answer_token`; only its holder can end or annotate the call. An answered call whose voice session never connects is ended after `CALL_CONNECT_TIMEOUT_MS`.

**Feedback delivery:** `PENDING → SENDING (lease) → ACKED`, or retried with backoff, or `FAILED` after 3 attempts. The idempotency key is sent to the harness.

## 5. Data (MongoDB, db `intervention_gateway`)

| Collection | What it holds |
|---|---|
| `incidents` | Immutable payload + state; uniq `event_id` |
| `proposal_heads` | Concurrency anchor (`latest_revision`, `state`) |
| `proposal_revisions` | Immutable plan versions |
| `decisions` | Feedback records (decision, words, revision, outbox state); uniq `idempotency_key`; one final decision per plan |
| `calls` | Call lifecycle, answer token, display-only transcript |
| `supervisor_queries` | Questions and answers |
| `audit_events` | Append-only log; also the SSE replay source |
| `webhook_receipts` | Post-call dedupe |

Multi-document writes use transactions (Atlas is a replica set).

## 6. Security, simplified for the demo

**Kept:**
- harness bearer token;
- tool secret plus call binding;
- webhook HMAC;
- signed URLs (the ElevenLabs key never reaches the browser);
- exact-revision feedback;
- the voice model can't create executable config (the harness authors every revision).

**Deliberately removed, at the user's request, for simplicity:**
- caller identity verification;
- second-factor confirmation for high-risk changes.

The person who answers the softphone is trusted. Before real robots: add SSO on the dashboard and an identity factor for voice.

## 7. Webhook tools vs MCP

Webhook tools were chosen: four generic HTTP routes, per-tool secret auth and simple tests. MCP's benefit, dynamic tool discovery, isn't needed, because the tool set is the stable contract and per-incident content is data. Revisit if the harness exposes its own MCP server.
