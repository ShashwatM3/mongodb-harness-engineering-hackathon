import type { CallDoc, IncidentDoc } from '../db';
import { GatewayError } from '../domain/errors';

export interface PlaceCallResult {
  status: 'RINGING' | 'ANSWERED';
  conversation_id?: string;
}

/** Places the "phone call". Providers know nothing about incidents beyond what they need to ring the human. */
export interface CallProvider {
  readonly name: string;
  place(call: CallDoc, incident: IncidentDoc): Promise<PlaceCallResult>;
}

/**
 * Simulated phone leg: the call "rings" the dashboard softphone (via the call.ringing audit event on SSE). When the human
 * answers, the browser starts a real ElevenLabs conversation with the same agent, dynamic variables and tools that a
 * telephone call would use.
 */
export class SimulatedCallProvider implements CallProvider {
  readonly name = 'simulated';
  async place(): Promise<PlaceCallResult> {
    return { status: 'RINGING' };
  }
}

/** Tests and offline demos: answers immediately; the caller then drives the agent-tool endpoints directly. */
export class ScriptedCallProvider implements CallProvider {
  readonly name = 'scripted';
  async place(call: CallDoc): Promise<PlaceCallResult> {
    return { status: 'ANSWERED', conversation_id: `scripted-${call._id}` };
  }
}

/**
 * Not implemented (the team chose to simulate the phone leg). DOC-VERIFIED endpoint for a future implementation:
 * POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call
 *   { agent_id, agent_phone_number_id, to_number,
 *     conversation_initiation_client_data: { dynamic_variables: {...} },
 *     telephony_call_config: { ringing_timeout_secs, twilio_machine_detection } }
 * → { success, message, conversation_id?, callSid? }. Unanswered calls arrive as a `call_initiation_failure` webhook.
 */
export class ElevenLabsTwilioProvider implements CallProvider {
  readonly name = 'elevenlabs-twilio';
  async place(): Promise<PlaceCallResult> {
    throw new GatewayError('NOT_IMPLEMENTED', 'Twilio calling is not enabled in this build; use CALL_MODE=simulated.', 501);
  }
}
