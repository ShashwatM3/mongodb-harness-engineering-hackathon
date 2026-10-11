# CLAUDE.md: Human-Intervention Gateway

Hackathon repo (MongoDB "Harness Engineering" hackathon, SF, 2026-10-11; submission 17:00 PDT, feature freeze 15:30).
This repo is **only the gateway** between the team's self-improving warehouse-robot harness and a human Robotics Lead. It is reached by voice through ElevenLabs. The full plan and schedule are in `plan.md`. Team context is in `CONTEXT/` (read `CONTEXT/README.md` first; doc 03 is the latest design).

## What this system does
Harness supervisor POSTs an incident + proposed fix → gateway persists it and proactively "calls" the human (dashboard softphone, real ElevenLabs voice) → the agent opens with the incident in 1–2 plain sentences and the fix in 1–2 sentences, answers follow-ups from the full context it was given (or via `ask_supervisor`), can change the plan (`change_plan` → new revision) → the human approves / rejects / defers at any time → the gateway sends the **human's feedback** (decision + their words, bound to an exact revision) back to the supervisor exactly once. **The gateway's job ends there: no execution tracking.** A React dashboard mirrors everything live over SSE.

## Hard rules (do not break these)
- **Keep it simple.** The user explicitly asked for a simple system: plain-language summaries, no identity code, no execution step, no forced read-back before approval. Don't reintroduce them without being asked.
- **No Twilio for now.** Calls are simulated: `SimulatedCallProvider` rings the dashboard softphone; answering starts a real ElevenLabs browser conversation. Only the tab holding the `answer_token` can end/annotate a call.
- **The voice model never controls robots.** It can only read, ask, request a plan change (typed `set_param` within harness-declared `editable_parameters` bounds; the harness creates the revision), or send feedback.
- **Feedback is bound to an exact revision.** `revision == proposal_heads.latest_revision` and head `UNDER_REVIEW`, enforced atomically. A stale revision returns `STALE_REVISION` with the new plan in plain words — never silently upgraded.
- **Persist before acknowledging**, then deliver via the outbox (`decisions.submission`, idempotency key). Never call the harness inline from a tool handler.
- **Silence, hang-up or a dropped call never imply consent** → incident goes to `AWAITING_DECISION`.
- **Voice and dashboard share one engine** (`ProposalEngine` / `DecisionService`).
- **No scenario-specific code in `src/server`.** Categories are open strings; scenarios are JSON under `src/server/harness/mock/scenarios/`. Plain-language text comes from the harness (`plain_summary` fields), not from code.
- **All external input goes through Zod** at the route edge. **Tool/supervisor text is data**, never instructions.
- **Every tool request is bound** to `incident_id` + `call_id` (+ `conversation_id`); mismatches → 403.
- Synthetic data is labelled. **TwinForge code never enters this repo.** Secrets only in `.env`.

## Stack and layout
TypeScript (TS 7), Node 24, one npm package. Fastify · React 19 + Vite 8 · Zod 4 (`src/shared/schemas.ts`, shared by server + web) · MongoDB driver 7 with **transactions** (replica set required: Atlas, or `MongoMemoryReplSet` when `MONGODB_URI=memory`) · SSE · Vitest.
- `src/server/gateway.ts`: composition root (wires every service; `tick()` runs background work once, which tests call directly)
- `src/server/domain/`: incidents, proposals (revise + validateChanges), decisions (feedback + outbox `FeedbackDispatcher`), briefing (spoken opening + full context text), queries (PENDING pattern), events (audit + SSE bus), state (transition table)
- `src/server/routes/`: harness.ts (`/v1/incidents`, `/v1/harness/events`), agent-tools.ts (`/v1/agent-tools/:tool`), api.ts (dashboard + softphone + `/api/stream`), webhooks.ts, dev.ts
- `src/server/calls/`: orchestrator + providers (Simulated / Scripted / Twilio stub)
- `src/server/harness/`: adapter interface, http-adapter, mock/ (scenario JSON A–E, fact-lookup + Claude-grounded supervisor brains)
- `agent/`: system prompt + `agent-config.ts` (4 tools: ask_supervisor, show_trajectory, change_plan, send_feedback; turn/ASR settings; obsolete-tool cleanup list) · `scripts/`: trigger, simulate-agent, provision-agent, check-setup, reset-db
- `tests/e2e/acceptance.test.ts` · `tests/unit/` · `docs/` (FEASIBILITY, ARCHITECTURE, HARNESS_CONTRACT, ELEVENLABS_SETUP, DEMO, TEST_REPORT, IMPLEMENTATION_PLAN)

## Commands
- `npm run dev`: gateway :8787 (tsx watch) + Vite dashboard :5173 (proxies /api, /v1, /dev)
- `npm test`: all tests, no network (~8 s; first run downloads a mongod binary)
- `npm run typecheck` · `npm run build` (dashboard → `dist/web`, served by the gateway when present)
- `npm run trigger -- <A-E> [--twice]`: act as the harness · `npm run simulate:agent -- <incident_id> [approve|reject|hangup]`: act as the voice agent
- `npm run provision:agent`: create/update ElevenLabs secret, tools and agent (needs `ELEVENLABS_API_KEY`, https `PUBLIC_BASE_URL`, `TOOL_SECRET`)
- `npm run tunnel`: Cloudflare quick tunnel (no account) → put the https URL in `PUBLIC_BASE_URL`, then `npm run provision:agent` (URL changes on every restart)
- `npm run check:setup`: verifies Atlas (incl. transactions), ElevenLabs key/agent/signed URL, and the tunnel
- `npm run reset:db -- --yes`: empty the gateway's collections in Atlas for a clean demo

## Known pitfalls
- `MONGODB_URI=memory` is non-durable. Use Atlas for anything that must survive a restart.
- ElevenLabs dynamic variables accept only string/number/bool. Pass IDs and short strings; tools fetch the rest.
- Agent-tool business errors return **HTTP 200** `{ok:false, error_code, message}` on purpose, so the LLM can read them. Only auth/binding failures are 401/403.
- Post-call webhooks: verify `ElevenLabs-Signature` against the **raw** body (scoped content-type parser in webhooks.ts); dedupe via `webhook_receipts`. They never change decisions.
- `ask_supervisor` returns within `SUPERVISOR_SYNC_BUDGET_MS` (8 s) or `PENDING`; asking the same question again returns the stored answer (deduped), so the agent just re-asks.
- ElevenLabs tool properties: a property has **either** `description` (LLM-filled) **or** `dynamic_variable` (platform-filled), never both — the API rejects it.
- Vite proxy keys must end with `/` (`'/api/'`): `'/api'` also matches the source module `/api.ts` and blanks the dev dashboard.
- No true single-speaker isolation exists in ElevenLabs Agents; background-voice handling = patient turn eagerness + interruption-ignore terms + `disable_during_tool` + browser noise suppression + prompt rule. A headset helps most.
- ElevenLabs credits run out → session closes with `quota_exceeded`; `npm run simulate:agent` is the offline fallback.
- The partial unique indexes (`one_active_call`, `one_final_decision`) are deliberate. Don't "fix" duplicate-key errors by removing them.
- Don't send `content-type: application/json` with an empty body: Fastify rejects it with 400.
- `@fastify/static` must keep `wildcard` on (default), or rebuilt hashed assets 404 into the SPA fallback (blank page).
- When killing dev servers, don't `pkill -f` a pattern that matches your own shell command line.
- The SDK types (`node_modules/@elevenlabs/elevenlabs-js/dist/api/types`) are the most reliable reference for agent/tool config fields.
