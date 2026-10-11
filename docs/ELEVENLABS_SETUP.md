# ElevenLabs setup

One agent, ten webhook tools, one workspace secret, provisioned from code. No Twilio: the "call" is a browser voice session started from the dashboard softphone.

## 1. Prerequisites

- ElevenLabs API key with Agents (ConvAI) read/write.
- A public HTTPS URL for the gateway so ElevenLabs can call the tools: `ngrok http 8787` (ngrok is installed on the dev laptop).
- `.env` (copy `.env.example`):
  ```
  ELEVENLABS_API_KEY=...
  PUBLIC_BASE_URL=https://<your-ngrok>.ngrok-free.app
  TOOL_SECRET=<openssl rand -hex 24>
  HARNESS_TOKEN=<openssl rand -hex 24>
  ELEVENLABS_AGENT_LLM=claude-sonnet-5-5   # any LLM id ElevenLabs supports
  ```

## 2. Provision (idempotent)

```bash
npm run provision:agent
```

What it does (`scripts/provision-agent.ts`, SDK `@elevenlabs/elevenlabs-js`):

1. Creates or updates the workspace secret `intervention_gateway_tool_auth` = `Bearer $TOOL_SECRET`.
2. Creates or updates the ten webhook tools from `agent/agent-config.ts`, matched by name. Each one:
   - is a `POST $PUBLIC_BASE_URL/v1/agent-tools/<name>`;
   - sends header `authorization` from the secret above;
   - has body properties `incident_id` ← `{{incident_id}}`, `call_id` ← `{{call_id}}` and `conversation_id` ← `{{system__conversation_id}}`, filled by the platform, not the LLM, plus the tool's own LLM-filled arguments;
   - uses `response_timeout_secs` 10–20 and `pre_tool_speech: force` on `ask_supervisor` and `revise_proposal`.
3. Creates or updates the agent "Robotics Intervention Gateway":
   - prompt from `agent/system-prompt.md`, plus the first message and dynamic-variable placeholders;
   - temperature 0.2, the built-in `end_call` tool, and a soft-timeout filler ("One moment, I am checking with the supervisor.").
4. Prints `ELEVENLABS_AGENT_ID`. Put it in `.env` and restart the gateway.

**Re-run it whenever the ngrok URL or the prompt changes.**

### Manual fallback (if the API call fails)

Do the same in the ElevenLabs dashboard:
- Agents → Create agent → paste `agent/system-prompt.md` and the first message from `agent/agent-config.ts`.
- Add the dynamic variables `incident_id, call_id, supervisor_name, robot_id, severity, category, one_line_summary`.
- Tools → Add webhook tool, ten times, with the names, descriptions and parameters from `agent/agent-config.ts`. Set `incident_id`/`call_id` as *Dynamic variable* values and `conversation_id` as `system__conversation_id`.
- Add header `authorization` as a Secret with value `Bearer <TOOL_SECRET>`.
- Enable the system tool *End call*.

## 3. Post-call webhook (optional, informational)

ElevenLabs dashboard → Agents platform settings → Webhooks → post-call → URL `$PUBLIC_BASE_URL/v1/webhooks/elevenlabs`. Copy the HMAC secret into `ELEVENLABS_WEBHOOK_SECRET`.

- We verify `ElevenLabs-Signature` (`t=…,v0=HMAC_SHA256(secret, "t.rawBody")`) and dedupe on `type:conversation_id`.
- The transcript, summary and termination reason are stored on the call.
- **It never records or changes a decision.** If the webhook secret is unset the endpoint returns 503; nothing else depends on it.

## 4. How a call runs

1. The harness POSTs an incident. The gateway places a call, and the dashboard softphone rings with a 45 s timeout and one retry.
2. **Answer** → `POST /api/calls/:id/answer`. The gateway mints a signed URL (`GET /v1/convai/conversation/get-signed-url?agent_id=…`) and returns the dynamic variables.
3. The browser runs `Conversation.startSession({ signedUrl, dynamicVariables, … })`. The microphone permission prompt appears.
4. The agent asks for the supervisor code (demo PIN in `SUPERVISOR_PINS`, default `sup-lead-01:2468`) and then uses the tools.
5. Hang-up, or the agent's `end_call` → `POST /api/calls/:id/end` → the incident returns to AWAITING_DECISION unless a decision was recorded.

## 5. Verify

- `curl -s localhost:8787/api/config` shows `"elevenlabs_configured": true`.
- In the dashboard, trigger scenario A, answer, and say "two four six eight", then "Why did the robot slow down?". The audit log should show `agent.tool_call ask_supervisor`.
- If tools fail with 401: the secret value must be exactly `Bearer <TOOL_SECRET>`. Re-run provisioning.
- If tools fail with 403 `CALL_BINDING`: the conversation used dynamic variables from a different call. Start a fresh call.

## 6. Adding Twilio later

Implement `ElevenLabsTwilioProvider.place()` (`src/server/calls/providers.ts`). It should call `POST /v1/convai/twilio/outbound-call` with the same dynamic variables and enable `twilio_machine_detection` (voicemail does not produce `call_initiation_failure`). Map the webhook's `call_initiation_failure` to `CallOrchestrator.decline`/`end`. On a Twilio trial, only verified numbers can be called.
