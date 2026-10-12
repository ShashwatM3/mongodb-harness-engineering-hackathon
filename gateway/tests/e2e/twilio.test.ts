// Real-phone transport (ElevenLabs native Twilio integration) against a fake ElevenLabs client: verifies the exact
// outbound-call request, the number allowlist, and the polled call lifecycle. No call is placed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElevenLabsTwilioProvider, type ElevenLabsTelephonyClient } from '../../src/server/calls/providers';
import { incidentFor, incidentState, postIncident, setup, TOOL_SECRET, type TestEnv } from '../helpers';

const ALLOWED = '+14155550123';
const placed: Array<Parameters<ElevenLabsTelephonyClient['conversationalAi']['twilio']['outboundCall']>[0]> = [];
const conversations = new Map<string, { status: string; transcript: Array<{ role: string; message?: string }>; metadata?: { terminationReason?: string } }>();
let n = 0;
const fake: ElevenLabsTelephonyClient = {
  conversationalAi: {
    twilio: {
      async outboundCall(req) {
        placed.push(req);
        const id = `conv_fake_${++n}`;
        conversations.set(id, { status: 'initiated', transcript: [] });
        return { success: true, message: 'ok', conversationId: id, callSid: `CA${n}` };
      },
    },
    sipTrunk: {
      async outboundCall(req) {
        placed.push({ ...req, viaSip: true } as never);
        const id = `conv_fake_${++n}`;
        conversations.set(id, { status: 'initiated', transcript: [] });
        return { success: true, message: 'ok', conversationId: id, sipCallId: `sip_${n}` };
      },
    },
    conversations: {
      async get(id) {
        return conversations.get(id)!;
      },
    },
  },
};

let env: TestEnv;
beforeAll(async () => {
  env = await setup(
    { CALL_MODE: 'scripted', CALL_RETRY_DELAY_MS: 0 },
    { provider: new ElevenLabsTwilioProvider(fake, { agentId: 'agent_x', phoneNumberId: 'phnum_x', allowedNumbers: [ALLOWED], defaultNumber: ALLOWED, ringingTimeoutSecs: 30 }) },
  );
});
afterAll(async () => {
  await env?.close();
});

async function placeCall(scenario = 'A', contact?: string) {
  const inc = incidentFor(env, scenario);
  if (contact) inc.responsible_supervisor.contact = contact;
  await postIncident(env, inc);
  await env.gw.calls.place(inc.incident_id);
  const call = (await env.gw.db.c.calls.findOne({ incident_id: inc.incident_id }))!;
  return { inc, call };
}
const poll = async (call_id: string) => {
  const c = (await env.gw.db.c.calls.findOne({ _id: call_id }))!;
  const p = await env.gw.calls['provider'].poll!(c);
  await env.gw.calls.applyProgress(c, p);
  return (await env.gw.db.c.calls.findOne({ _id: call_id }))!;
};

describe('real phone call via ElevenLabs + Twilio', () => {
  it('sends the documented outbound-call request with the same opening and context as the softphone', async () => {
    const { inc, call } = await placeCall('A');
    const req = placed.at(-1)!;
    expect(req).toMatchObject({ agentId: 'agent_x', agentPhoneNumberId: 'phnum_x', toNumber: ALLOWED, telephonyCallConfig: { ringingTimeoutSecs: 30 } });
    const dv = req.conversationInitiationClientData!.dynamicVariables!;
    expect(dv).toMatchObject({ incident_id: inc.incident_id, call_id: call._id, current_revision: 1, supervisor_name: 'Robotics Lead' });
    expect(String(dv.incident_brief)).toMatch(/62 centimetres/);
    expect(String(dv.proposal_brief)).toMatch(/0\.65 metres instead of 0\.45/);
    expect(String(dv.incident_context)).toContain('CURRENT PLAN — revision 1');
    expect(call).toMatchObject({ status: 'RINGING', provider: 'twilio', conversation_id: req && call.conversation_id });
    expect(call.conversation_id).toMatch(/^conv_fake_/);
  });

  it('never dials a number outside the allowlist', async () => {
    const { call } = await placeCall('C', '+19995550000'); // contact not allowed → falls back to the allowed default
    expect(placed.at(-1)!.toNumber).toBe(ALLOWED);
    expect(call.status).toBe('RINGING');
    const strict = new ElevenLabsTwilioProvider(fake, { agentId: 'a', phoneNumberId: 'p', allowedNumbers: [ALLOWED], defaultNumber: '+19995550000', ringingTimeoutSecs: 30 });
    const inc = { incident: { responsible_supervisor: { id: 's', name: 'n', contact: '+19995550000' } } } as never;
    expect(() => strict.destinationFor(inc)).toThrow(/No allowed phone number/);
  });

  it('answered → live transcript → tools work → hang-up returns the incident to awaiting a decision', async () => {
    const { inc, call } = await placeCall('A');
    const conv = conversations.get(call.conversation_id!)!;
    conv.status = 'in-progress';
    conv.transcript = [{ role: 'agent', message: 'Hi Robotics Lead…' }, { role: 'user', message: 'Why did that happen?' }];
    const live = await poll(call._id);
    expect(live.status).toBe('ANSWERED');
    expect(live.transcript.map((t) => t.role)).toEqual(['agent', 'user']);
    expect(await incidentState(env, inc.incident_id)).toBe('IN_CALL');

    const r = await env.app.inject({
      method: 'POST',
      url: '/v1/agent-tools/show_trajectory',
      headers: { authorization: `Bearer ${TOOL_SECRET}` },
      payload: { incident_id: inc.incident_id, call_id: call._id, conversation_id: call.conversation_id },
    });
    expect(r.json()).toMatchObject({ ok: true, shown: true });

    conv.status = 'done';
    conv.metadata = { terminationReason: 'Call ended by remote party' };
    const ended = await poll(call._id);
    expect(ended).toMatchObject({ status: 'ENDED', end_reason: 'Call ended by remote party' });
    expect(await incidentState(env, inc.incident_id)).toBe('AWAITING_DECISION');
  });

  it('a tool call during "ringing" proves the call was answered (poll lag)', async () => {
    const { inc, call } = await placeCall('B');
    const r = await env.app.inject({
      method: 'POST',
      url: '/v1/agent-tools/show_trajectory',
      headers: { authorization: `Bearer ${TOOL_SECRET}` },
      payload: { incident_id: inc.incident_id, call_id: call._id, conversation_id: call.conversation_id },
    });
    expect(r.json().ok).toBe(true);
    expect((await env.gw.db.c.calls.findOne({ _id: call._id }))!.status).toBe('ANSWERED');
  });

  it('a number imported "From SIP Trunk" (e.g. Telnyx) uses the SIP outbound endpoint with the same request', async () => {
    const sip = new ElevenLabsTwilioProvider(fake, { route: 'sip', agentId: 'agent_x', phoneNumberId: 'phnum_sip', allowedNumbers: [ALLOWED], defaultNumber: ALLOWED, ringingTimeoutSecs: 30 });
    expect(sip.name).toBe('sip');
    const inc = incidentFor(env, 'C');
    const call = { _id: 'call_sip_test', conversation_id: null } as never;
    const res = await sip.place(call, { _id: inc.incident_id, incident: inc } as never, async () => ({ incident_id: inc.incident_id }));
    const req = placed.at(-1) as unknown as Record<string, unknown>;
    expect(req).toMatchObject({ viaSip: true, agentId: 'agent_x', agentPhoneNumberId: 'phnum_sip', toNumber: ALLOWED });
    expect(res).toMatchObject({ status: 'RINGING', provider_call_id: expect.stringMatching(/^sip_/) });
  });

  it('unanswered (no human speech) → no answer → one retry', async () => {
    const { inc, call } = await placeCall('C');
    conversations.get(call.conversation_id!)!.status = 'failed';
    const done = await poll(call._id);
    expect(done.status).toBe('NO_ANSWER');
    expect(await incidentState(env, inc.incident_id)).toBe('CALL_PENDING');
  });
});
