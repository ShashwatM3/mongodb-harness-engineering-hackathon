// Offline fallback: plays the ElevenLabs agent against a ringing call so the loop can be shown without ElevenLabs.
// Uses exactly the same HTTP tool endpoints the real agent uses.
//   npm run simulate:agent -- <incident_id> [approve|reject|defer|hangup]
export {};
const base = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const secret = process.env.TOOL_SECRET || 'dev-tool-secret-change-me';
const [incidentId, ending = 'approve'] = process.argv.slice(2);
if (!incidentId) {
  console.error('usage: npm run simulate:agent -- <incident_id> [approve|reject|defer|hangup]');
  process.exit(1);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return res.json() as Promise<any>;
}

const agg = await json('GET', `/api/incidents/${incidentId}`);
const call = agg.calls.at(-1);
if (!call || call.status !== 'RINGING') throw new Error('No ringing call for this incident (trigger one first, and do not answer it in the browser).');
const session = await json('POST', `/api/calls/${call._id}/answer`);
const { answer_token, dynamic_variables: dv } = session;
const conversation_id = `sim-${call._id}`;
await json('POST', `/api/calls/${call._id}/connected`, { conversation_id, answer_token });

const line = (role: 'agent' | 'user', text: string) => {
  console.log(`${role === 'agent' ? '🤖' : '👤'} ${text}`);
  return json('POST', `/api/calls/${call._id}/transcript`, { answer_token, role, text });
};
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await json('POST', `/v1/agent-tools/${name}`, { incident_id: incidentId, call_id: call._id, conversation_id, ...args }, { authorization: `Bearer ${secret}` });
  console.log(`   🔧 ${name} → ${JSON.stringify(r).slice(0, 220)}`);
  await pause(800);
  return r;
};

await line('agent', `Hi ${dv.supervisor_name}, this is the fleet supervisor. ${dv.incident_brief} The proposed fix: ${dv.proposal_brief} Do you want to approve it, change it, or ask me anything?`);
await pause(1500);
await line('user', 'Why do you think that happened?');
const a = await tool('ask_supervisor', { question: 'Why do you think that happened?' });
await line('agent', a.answer ?? a.missing ?? 'The supervisor could not answer that.');
await line('user', 'Show me the path.');
await tool('show_trajectory');
if (ending === 'hangup') {
  await line('user', 'I have to go, call me later.');
  await json('POST', `/api/calls/${call._id}/end`, { answer_token, reason: 'hung up by human' });
  process.exit(0);
}

// Change the first setting the plan touches to halfway between current and proposed.
const ctx: string = dv.incident_context;
const m = ctx.match(/- (.+?) \[key ([^\]]+)\]: currently ([\d.]+) (\S*), plan ([\d.]+)/);
let revision = Number(dv.current_revision);
if (m && m[3] !== m[5]) {
  const mid = Math.round(((Number(m[3]) + Number(m[5])) / 2) * 100) / 100;
  await line('user', `Make the ${m[1].toLowerCase()} ${mid} ${m[4]} instead.`);
  const c = await tool('change_plan', { parameter_key: m[2], new_value: String(mid), unit: m[4], reason: 'Prefer a smaller change.' });
  if (c.changed) {
    revision = c.revision;
    await line('agent', `Done. ${c.new_plan} Do you approve?`);
  }
}
const decision = ({ approve: 'APPROVE', reject: 'REJECT', defer: 'DEFER' } as Record<string, string>)[ending] ?? 'APPROVE';
const feedback = decision === 'APPROVE' ? 'Approved. Watch the cycle time for the next shift and tell me if it gets worse.' : decision === 'REJECT' ? 'No — get me camera footage first.' : 'Not now, call me after the shift.';
await line('user', feedback);
const f = await tool('send_feedback', { revision, decision, feedback });
await line('agent', f.message ?? 'Sent.');
await json('POST', `/api/calls/${call._id}/end`, { answer_token, reason: 'agent ended call' });
console.log('📴 call ended');
