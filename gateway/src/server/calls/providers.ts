import type { CallDoc, IncidentDoc } from '../db';
import { GatewayError } from '../domain/errors';
import type { CallVariables } from './variables';

export interface PlaceCallResult {
  status: 'RINGING' | 'ANSWERED';
  /** Provider conversation id, when known at placement (real phone calls). */
  conversation_id?: string;
  provider_call_id?: string;
}

/** What a provider reports when polled about a call it placed. */
export type CallProgress =
  | { state: 'ringing' }
  | { state: 'in_call'; transcript: TranscriptLine[] }
  | { state: 'ended'; answered: boolean; reason: string; transcript: TranscriptLine[] };

export interface TranscriptLine {
  role: 'agent' | 'user';
  text: string;
}

/** Places the call. Providers know nothing about incidents beyond what they need to reach the human. */
export interface CallProvider {
  readonly name: string;
  place(call: CallDoc, incident: IncidentDoc, variables: () => Promise<CallVariables>): Promise<PlaceCallResult>;
  /** Providers whose call progress is not reported by a browser (real phone calls) are polled by the orchestrator. */
  poll?(call: CallDoc): Promise<CallProgress>;
}

/**
 * Simulated phone leg: the call "rings" the dashboard softphone (via the call.ringing event on SSE). When the human
 * answers, the browser starts a real ElevenLabs conversation with the same agent, variables and tools.
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

/** The subset of `ElevenLabsClient` this provider uses (injectable for tests). Field names per @elevenlabs/elevenlabs-js 2.71. */
type OutboundCallRequest = {
  agentId: string;
  agentPhoneNumberId: string;
  toNumber: string;
  conversationInitiationClientData?: { dynamicVariables?: Record<string, unknown> };
  telephonyCallConfig?: { ringingTimeoutSecs?: number };
};
export interface ElevenLabsTelephonyClient {
  conversationalAi: {
    /** POST /v1/convai/twilio/outbound-call — number imported via the native Twilio integration. */
    twilio: { outboundCall(req: OutboundCallRequest): Promise<{ success: boolean; message: string; conversationId?: string; callSid?: string }> };
    /** POST /v1/convai/sip-trunk/outbound-call — number imported "From SIP Trunk" (e.g. Telnyx, Plivo). */
    sipTrunk: { outboundCall(req: OutboundCallRequest): Promise<{ success: boolean; message: string; conversationId?: string; sipCallId?: string }> };
    conversations: {
      get(conversationId: string): Promise<{
        status: string;
        transcript: Array<{ role: string; message?: string }>;
        metadata?: { terminationReason?: string; callDurationSecs?: number };
      }>;
    };
  };
}

export interface TwilioCallSettings {
  /** Which ElevenLabs outbound endpoint matches how the number was imported. */
  route?: 'twilio' | 'sip';
  agentId: string;
  phoneNumberId: string;
  /** E.164 numbers the gateway may call. Anything else is refused, whatever the incident payload says. */
  allowedNumbers: string[];
  /** Used when the incident's supervisor has no allowed E.164 contact. */
  defaultNumber: string;
  ringingTimeoutSecs: number;
}

/**
 * Real phone call placed by ElevenLabs on a number imported into ElevenLabs — either through the native Twilio
 * integration (`route: 'twilio'`, POST /v1/convai/twilio/outbound-call) or a SIP trunk such as Telnyx
 * (`route: 'sip'`, POST /v1/convai/sip-trunk/outbound-call). Same request fields; progress by polling
 * GET /v1/convai/conversations/:id.
 */
export class ElevenLabsTwilioProvider implements CallProvider {
  readonly name: string;

  constructor(
    private readonly client: ElevenLabsTelephonyClient,
    private readonly settings: TwilioCallSettings,
  ) {
    if (!settings.agentId || !settings.phoneNumberId) throw new Error('CALL_MODE=twilio needs ELEVENLABS_AGENT_ID and ELEVENLABS_PHONE_NUMBER_ID');
    if (!settings.allowedNumbers.length) throw new Error('CALL_MODE=twilio needs CALL_ALLOWED_NUMBERS (E.164, comma-separated)');
    this.name = settings.route === 'sip' ? 'sip' : 'twilio';
  }

  destinationFor(incident: IncidentDoc): string {
    const contact = normalizeE164(incident.incident.responsible_supervisor.contact ?? '');
    const allowed = new Set(this.settings.allowedNumbers.map(normalizeE164));
    if (contact && allowed.has(contact)) return contact;
    const fallback = normalizeE164(this.settings.defaultNumber);
    if (fallback && allowed.has(fallback)) return fallback;
    throw new GatewayError('NUMBER_NOT_ALLOWED', 'No allowed phone number for this supervisor (check SUPERVISOR_PHONE and CALL_ALLOWED_NUMBERS).', 422);
  }

  async place(call: CallDoc, incident: IncidentDoc, variables: () => Promise<CallVariables>): Promise<PlaceCallResult> {
    const toNumber = this.destinationFor(incident);
    const req: OutboundCallRequest = {
      agentId: this.settings.agentId,
      agentPhoneNumberId: this.settings.phoneNumberId,
      toNumber,
      conversationInitiationClientData: { dynamicVariables: await variables() },
      telephonyCallConfig: { ringingTimeoutSecs: this.settings.ringingTimeoutSecs },
    };
    const ai = this.client.conversationalAi;
    const res = this.name === 'sip' ? await ai.sipTrunk.outboundCall(req) : await ai.twilio.outboundCall(req);
    if (!res.success) throw new GatewayError('PROVIDER_ERROR', `ElevenLabs could not place the call: ${res.message}`, 502);
    return { status: 'RINGING', conversation_id: res.conversationId, provider_call_id: 'callSid' in res ? res.callSid : (res as { sipCallId?: string }).sipCallId };
  }

  async poll(call: CallDoc): Promise<CallProgress> {
    if (!call.conversation_id) return { state: 'ringing' };
    const c = await this.client.conversationalAi.conversations.get(call.conversation_id);
    const transcript: TranscriptLine[] = (c.transcript ?? [])
      .filter((t) => t.message && t.message.trim())
      .map((t) => ({ role: t.role === 'user' ? 'user' : 'agent', text: t.message!.trim() }));
    const answered = transcript.some((t) => t.role === 'user');
    if (c.status === 'initiated') return { state: 'ringing' };
    if (c.status === 'in-progress') return { state: 'in_call', transcript };
    return { state: 'ended', answered, reason: c.metadata?.terminationReason || `call ${c.status}`, transcript };
  }
}

export function normalizeE164(n: string): string {
  const digits = n.replace(/[^\d+]/g, '');
  return /^\+\d{8,15}$/.test(digits) ? digits : '';
}
