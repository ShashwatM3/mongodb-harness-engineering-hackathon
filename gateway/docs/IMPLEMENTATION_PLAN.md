# Implementation plan and progress

The planning document is `plan.md` (repo root). This file tracks execution against it. Status as of 12:15 PDT.

## Vertical slice: done

- [x] Mock supervisor trigger → incident persisted (dedupe, validation, auth). *Test 1*
- [x] Call job → simulated call (ring, answer, decline, no-answer, retry, unreachable). *Tests 1, 11*
- [x] Question answered through the mock harness, with PENDING for long analyses. *Test 3*
- [x] Proposal modified → harness-reconciled revision. *Test 6*
- [x] Exact-revision approval → outbox → harness exactly once. *Tests 7, 13*
- [x] Harness execution events → incident RESOLVED/FAILED/REJECTED. *Test 12*
- [x] Dashboard live via SSE. *Manual, with screenshots*

## Components

| # | Component | Status | Where |
|---|---|---|---|
| 1 | Incident receiver | Done | `routes/harness.ts`, `domain/incidents.ts` |
| 2 | Outbound call orchestrator | Done (simulated; Twilio stub documented) | `calls/` |
| 3 | Voice agent configuration | Done, **not live-tested** | `agent/`, `scripts/provision-agent.ts` |
| 4 | Harness adapter (mock + HTTP) | Done; HTTP adapter untested against a real harness | `harness/` |
| 5 | Proposal and approval engine | Done | `domain/proposals.ts`, `domain/decisions.ts` |
| 6 | Evidence and metrics normalisation | Done (kind/unit/timestamp/source on every value) | `shared/schemas.ts` |
| 7 | Review dashboard | Done | `src/web/` |
| 8 | Real-time sync | Done (SSE + audit replay) | `domain/events.ts`, `routes/api.ts` |
| 9 | Persistence and audit | Done (MongoDB transactions, `audit_events`) | `db.ts` |
| 10 | Mock robotics harness (scenarios A–E) | Done | `harness/mock/` |

## Acceptance criteria

All 14 brief tests and the webhook test are automated and passing. See `docs/TEST_REPORT.md`.

## Remaining (needs credentials or teammates)

- [ ] **ElevenLabs key** → `npm run provision:agent` → live run of DEMO §2 → record it in TEST_REPORT. *(blocked on key)*
- [ ] **Atlas URI** → set `MONGODB_URI` → restart-survival check. *(blocked on URI)*
- [ ] **Anthropic key** (optional) → grounded supervisor answers.
- [ ] **Person B**: agree on HARNESS_CONTRACT A/F/G, or keep the mock for the demo.
- [ ] Rehearse DEMO twice; record the submission video.

## Deviations from plan.md

- D7: multi-document writes use **transactions** (replica set required) instead of single-document-only atomics. This is simpler to reason about, and Atlas supports it.
- The mock-supervisor default model is `claude-opus-5-5` (low effort), not Haiku. It's configurable through `MOCK_SUPERVISOR_MODEL`; the PENDING pattern absorbs the latency.
- The 14 acceptance tests live in one file (`tests/e2e/acceptance.test.ts`) instead of 14 files, so they share a single replica-set startup.
- Added `scripts/simulate-agent.ts` as a stage fallback if ElevenLabs is unavailable.

## v2: simplification (13:00, at the user's request)

- [x] Removed the identity code, execution tracking (events, RESOLVED/FAILED states) and the HIGH-risk second factor.
- [x] Removed the forced read-back: the human can approve, reject or postpone at any moment.
- [x] The final output is the human's **feedback** (decision + their words, exact revision), delivered once via the outbox (`FeedbackDispatcher` → `HarnessAdapter.submitFeedback`).
- [x] Plain-language `plain_summary` on incident and plan, supplied by the harness. The agent opens with the incident in 1–2 sentences and the plan in 1–2 sentences.
- [x] The full incident context goes into the session (`incident_context` dynamic variable), so follow-ups don't need tool calls. 4 tools instead of 10.
- [x] Background-voice settings: patient turns, interruption-ignore terms, no interruption during tools, ASR keywords, browser noise suppression, prompt rule.
- [x] Dashboard redesigned: one column, plain headline, fix card with Approve / Reject / Not now, feedback card, call transcript, technical details folded away.
- [x] Fixed: second-tab hang-up (server `answer_token`), the Vite proxy blanking the dev dashboard, and calls stuck when the voice session never connects.
- [ ] Live voice test of v2. **Blocked: the ElevenLabs account is out of credits** (`quota_exceeded`).
