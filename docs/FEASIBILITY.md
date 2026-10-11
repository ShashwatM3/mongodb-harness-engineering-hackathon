# Feasibility: voice intervention gateway

Assessed 2026-10-11 (hackathon day). Sources: current ElevenLabs docs, the installed `@elevenlabs/elevenlabs-js` 2.71 and `@elevenlabs/client` 1.27 type definitions and source code, Twilio trial docs, and executable local tests.

## Verdict: CONDITIONAL GO

The intervention loop is built and **locally verified end to end** (39 automated tests, plus a manual run against the live dev server). Nothing in the core loop depends on an unsupported provider feature. Three conditions remain:

1. **No live ElevenLabs conversation has been run yet.** We need an API key and an agent provisioned with `npm run provision:agent`. Until then every ElevenLabs row below is DOC- or SDK-verified, not LIVE-verified.
2. **Twilio/PSTN is out of scope by team decision.** The phone leg is simulated: the dashboard softphone rings, and answering it starts a real ElevenLabs voice session in the browser.
3. **The real harness API doesn't exist yet.** The mock harness implements the same contract (`docs/HARNESS_CONTRACT.md`).

Status legend: **DOC** = current docs state it · **SDK** = present in the official SDK's types or source (stronger than docs, but not a live call) · **LOCAL** = proven by an executable local test · **LIVE** = tested against the real provider · **UNVERIFIED** · **UNSUPPORTED**.

## Capability matrix

| # | Question | Status | Evidence / detail |
|---|---|---|---|
| 1 | Can the AI initiate a real outbound phone call after a trigger? | DOC (not used) | `POST /v1/convai/twilio/outbound-call` `{agent_id, agent_phone_number_id, to_number, conversation_initiation_client_data:{dynamic_variables}, telephony_call_config:{ringing_timeout_secs, twilio_machine_detection}}` → `{success, message, conversation_id?, callSid?}`. We simulate the PSTN leg instead (decision D1). The gateway initiating the call is **LOCAL**: `tests/e2e` Test 1. |
| 2 | How do we attach incident context? | DOC + SDK | `dynamic_variables` (string/number/bool only) in the prompt, first message and tool bodies. In tools, a body property with `dynamic_variable` is filled by the platform, not the LLM (SDK `LiteralJsonSchemaProperty.dynamicVariable`). We pass IDs and short strings; tools fetch everything else. |
| 3 | Can one agent handle many incident types? | LOCAL | One prompt with no domain content and ten generic tools. Test 2 runs categories A–E through the same tool surface. |
| 4 | Can the agent call our backend repeatedly in one conversation? | DOC | Webhook tools carry no per-conversation limit. LIVE confirmation is pending. |
| 5 | Can tools query another AI agent? | LOCAL | `ask_supervisor` → `HarnessAdapter.askSupervisor` → mock supervisor (Claude grounded in an evidence pack, or deterministic lookup). Test 3. |
| 6 | How are long queries handled? | SDK + LOCAL | Webhook tools have `response_timeout_secs` and `pre_tool_speech` (`auto`/`force`/`off`) in the SDK schema. We don't rely on `execution_mode: async`. `ask_supervisor` returns within an 8 s budget or replies `PENDING{query_id}`, and the agent polls `get_supervisor_answer`. Retries are deduped (Test 3b). The voice turn's `soft_timeout_config` speaks a filler line. |
| 7 | Can voice safely create revisions and decisions? | LOCAL | Typed `set_param` changes are validated against harness-declared bounds and units, and the harness reconciles them. Decisions bind to an exact revision with optimistic concurrency. Tests 6, 7, 9 and 13. |
| 8 | Transcripts, IDs, structured data? | DOC | Post-call webhook `post_call_transcription` carries `conversation_id`, `transcript`, `analysis.data_collection_results`, `metadata.termination_reason`, verified via `ElevenLabs-Signature`. We store it as **informational only**; decisions come solely from tool calls. |
| 9 | Real-time conversation events to the backend? | UNVERIFIED (public) | We found no public server-side live event stream for phone calls. The browser SDK gives `onMessage` / `onConnect` / `onDisconnect`, which our softphone forwards as display-only transcript. Authoritative state flows through tool calls, so we don't need the stream. |
| 10 | Can a dashboard stay in sync with a live call? | LOCAL | Every committed state change writes an audit event that is pushed over SSE, with replay from `Last-Event-ID`. Test 13 and the manual run. |
| 11 | Can the agent point the human to a trajectory visualization? | LOCAL | `get_trajectory` emits `trajectory.focus`. The dashboard selects the incident and highlights the segment, and the agent says "it's on your dashboard". |
| 12 | MCP for dynamic tool discovery? | Not needed | See the decision matrix in `docs/ARCHITECTURE.md` §7. The tool set *is* the stable contract; generality comes from generic tools and harness-declared parameters. |
| 13 | Pricing, trial and account limits | DOC (third-party in part) | Twilio trial: calls only to verified numbers, sign-up country only, trial preamble. Moot under D1. ElevenLabs Agents usage is billed per minute; hackathon credits apply. Concurrency limits weren't checked. One demo call at a time is fine. |
| 14 | ASR limits for exact values and approvals | Design | We confirm values back to the human. Units are never converted silently (`UNIT_MISMATCH`). A voice APPROVE/REJECT must name the decision **and** revision number (`confirmationMatches`; "yes" / "sounds good" are refused). HIGH-risk voice approvals are held for a dashboard second factor. |
| 15 | Unanswered, voicemail, hang-up | LOCAL (simulated) / DOC (Twilio) | Simulated: ring timeout → NO_ANSWER → one retry → UNREACHED (Test 11b). Hang-up before a decision → AWAITING_DECISION, nothing inferred (Test 11). On Twilio, voicemail does **not** emit `call_initiation_failure` (DOC), so AMD is required if PSTN is added. |
| 16 | Simultaneous voice and dashboard edits | LOCAL | `base_revision` compare-and-set plus a RECONCILING lock. The second writer gets `REVISION_CONFLICT`/`STALE_REVISION`, and concurrent approvals yield exactly one decision (Test 13b). |
| 17 | Special permissions or credentials | — | An ElevenLabs API key with ConvAI write access (agents, tools, secrets). The post-call webhook is configured in the ElevenLabs dashboard. MongoDB Atlas URI. Optional Anthropic key. |
| 18 | Simpler alternatives | Applied | Browser session instead of PSTN, SSE instead of WebSockets, a single process instead of microservices, webhook tools instead of MCP, MongoDB (already required) instead of Postgres. |

## Browser-session path (what the demo actually uses)

- `GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=…` with the `xi-api-key` header returns `{signed_url}` (SDK source). The key stays server-side.
- The browser calls `Conversation.startSession({ signedUrl, connectionType: 'websocket', dynamicVariables, onConnect({conversationId}), onMessage, onDisconnect, onError })` (`@elevenlabs/client` types).
- Tools call our public HTTPS URL (ngrok) with `Authorization` taken from a workspace secret (`requestHeaders: { authorization: { secretId } }`, SDK `ConvAiSecretLocator`).
- Agent provisioning goes through the SDK: `conversationalAi.secrets.create/update`, `tools.create/update`, `agents.create/update` (`scripts/provision-agent.ts`). Type-checked against the SDK; **not yet run live**.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| The LLM skips a tool and improvises a fact | The prompt has hard rules, every tool result carries an `instruction`, the supervisor returns `INSUFFICIENT_EVIDENCE` explicitly, and no decision is accepted without the tool path. Remaining risk: speech is not machine-checked, so review transcripts. |
| The voice approval is spoken by the wrong person | Demo: a PIN verified server-side with a 3-strike lock. HIGH-risk changes need dashboard confirmation. Production: SSO dashboard signature or OTP for every physical change. |
| The PIN appears in the transcript or LLM context | Known demo limitation, documented. Production: a non-voice factor. |
| The tool URL changes (ngrok restart) | Re-run `npm run provision:agent`; it is idempotent. |
| `system__conversation_id` isn't sent in browser sessions | Binding falls back to `call_id`. The softphone also reports `conversationId` via `/api/calls/:id/connected`. |
| The post-call webhook isn't sent for web sessions | We don't depend on it; the softphone reports the hang-up. |
| Single process / in-process event bus | Fine for the demo. Scale-out path: Atlas change streams feeding SSE. |

## Smallest fully functional implementation (what was built)

Fastify, MongoDB (Atlas, or an in-memory replica set for development), a mock harness, ten ElevenLabs webhook tools, and a React dashboard with an SSE feed and a softphone. One `npm run dev`.
