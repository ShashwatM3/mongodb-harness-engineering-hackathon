# Prompt for Aseel's coding agent: swap the softphone for a real phone call

## Context to give the agent

You're working on the `aseel-eleven-lab` branch of this repository. It already has a full, tested incident → proposal → decision system: a Fastify gateway, a React dashboard, MongoDB with real transactions, PIN-based identity verification, ten ElevenLabs webhook tools, and your own `docs/HARNESS_CONTRACT.md`. The phone leg is currently a browser softphone. The team has decided they want a real phone call instead, a real number ringing in the room, because that's the project's signature demo moment. Everything else on the branch stays as built; this task only swaps the transport for the voice leg.

**Hard constraint: do not guess ElevenLabs' API shape.** There is no spare budget to debug a wrong field name or endpoint against a live call. Every fact below was fetched from ElevenLabs' current documentation today, October 11, 2026. If the live ElevenLabs dashboard or API ever disagrees with something below, trust the live account and flag the discrepancy rather than forcing this doc's version.

## Step 1: set it up and prove it works by hand first, before writing any code

This catches a wrong Twilio SID, a wrong token, or an unverified number in one click, before anyone writes or runs code against it.

1. In Twilio, get either a purchased phone number (inbound + outbound) or, faster and free, a **verified caller ID** (outbound only, no number purchase needed, works fine on a trial account). If the Twilio account is a trial account, the destination number you'll be calling (the Robotics Lead's phone) also needs to be verified in Twilio's console first; trial accounts can only call verified numbers.
2. In the ElevenLabs dashboard, go to the **Phone Numbers** tab and import it: label, the phone number, the Twilio Account SID (or an API Key SID, which is the more secure option), and the matching Auth Token or API Key Secret. ElevenLabs auto-detects whether it supports inbound+outbound or outbound-only.
3. Assign the conversational agent to that number if it supports inbound; either way, use the **Outbound call** button on that number's row to send a real test call to a number you control, and confirm the agent's voice and tools work end to end. This still places a real call and uses minutes, so don't repeat it more than once or twice, but it's the fastest way to catch a configuration mistake before any code touches it.

## Step 2: wire the same call programmatically

Two endpoints matter, both under `https://api.elevenlabs.io`:

**Import a number from code** (only needed if you don't do it via the dashboard):
```
POST /v1/convai/phone-numbers
{
  "provider": "twilio",
  "label": "...",
  "phone_number": "+1...",
  "sid": "...",      // Twilio Account SID (starts "AC") or API Key SID (starts "SK")
  "token": "..."     // the matching Auth Token or API Key Secret
}
```
Response: `{ "phone_number_id": "..." }` — this is the `agent_phone_number_id` used below.

**Place the outbound call:**
```
POST /v1/convai/twilio/outbound-call
{
  "agent_id": "...",
  "agent_phone_number_id": "...",
  "to_number": "+1...",
  "conversation_initiation_client_data": {
    "dynamic_variables": { "...": "..." },
    "conversation_config_override": {
      "agent": { "first_message": "..." }
    }
  }
}
```

Prefer the official SDK over raw HTTP if the `elevenlabs` package is already a dependency:
- Python: `client.conversational_ai.twilio.outbound_call(agent_id=..., agent_phone_number_id=..., to_number=..., conversation_initiation_client_data={...})`
- JS/TS: `client.conversationalAi.twilio.outboundCall({ agentId, agentPhoneNumberId, toNumber, conversationInitiationClientData })`

Replace whatever in the branch currently triggers the browser softphone (almost certainly somewhere in the `POST /v1/incidents` path, or wherever that handler currently opens the softphone session) with this call instead. Pass the incident's summary, the specific questions, and the current zone scores through `conversation_initiation_client_data.dynamic_variables` so the agent's first spoken line can reference them directly, the same data it already has available for the softphone path today.

## Done when

A real phone rings when an incident is created, the agent speaks using the incident's real data, and all ten existing webhook tools still work exactly as they did over the softphone, since none of them change, only the transport underneath the voice does.

## Sources, fetched live today

- `https://elevenlabs.io/docs/api-reference/twilio/outbound-call`
- `https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration`
- `https://elevenlabs.io/docs/eleven-agents/api-reference/phone-numbers/create`
- `https://github.com/elevenlabs/skills/blob/main/agents/references/outbound-calls.md`
