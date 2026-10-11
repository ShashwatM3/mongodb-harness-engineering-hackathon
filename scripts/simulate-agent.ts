// Offline fallback: plays the ElevenLabs agent's tool calls against the most recent ringing/answered call, so the full
// loop can be shown on the dashboard without ElevenLabs. Uses exactly the same HTTP tool endpoints the real agent uses.
//   npm run simulate:agent -- <incident_id> [approve|reject|hangup]
const base = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const secret = process.env.TOOL_SECRET || 'dev-tool-secret-change-me';
const pin = (process.env.SUPERVISOR_PINS || 'sup-lead-01:2468').split(',')[0].split(':')[1];
const [incidentId, ending = 'approve'] = process.argv.slice(2);
if (!incidentId) {
  console.error('usage: npm run simulate:agent -- <incident_id> [approve|reject|hangup]');
  process.exit(1);
}
export {};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return res.json() as Promise<any>;
}

const agg = await json('GET', `/api/incidents/${incidentId}`);
const call = agg.calls.at(-1);
if (!call) throw new Error('No call for this incident yet');
let answer_token: string | undefined;
if (call.status === 'RINGING') {
  console.log('☎  answering', call._id);
  answer_token = (await json('POST', `/api/calls/${call._id}/answer`)).answer_token;
}
const conversation_id = `sim-${call._id}`;
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await json('POST', `/v1/agent-tools/${name}`, { incident_id: incidentId, call_id: call._id, conversation_id, ...args }, { authorization: `Bearer ${secret}` });
  console.log(`\n🤖 ${name}(${JSON.stringify(args)})\n   → ${JSON.stringify(r).slice(0, 400)}`);
  await json('POST', `/api/calls/${call._id}/transcript`, { answer_token, role: 'agent', text: `[tool ${name}] ${r.message ?? r.answer ?? r.summary ?? r.status ?? (r.ok ? 'ok' : r.error_code)}` });
  await pause(1200);
  return r;
};
const say = async (text: string) => {
  console.log(`\n👤 ${text}`);
  await json('POST', `/api/calls/${call._id}/transcript`, { answer_token, role: 'user', text });
  await pause(800);
};

await say(`My code is ${pin.split('').join(' ')}`);
await tool('verify_identity', { code: pin });
await tool('get_incident');
await say('What exactly went wrong, and why do you think it happened?');
await tool('ask_supervisor', { question: 'What exactly went wrong, and why do you think it happened?' });
await say('Show me the trajectory.');
await tool('get_trajectory');
await tool('get_metrics');
const p = await tool('get_proposal');
let rev = p.revision as number;
const param = p.editable_parameters?.find((x: any) => x.proposed !== x.current) ?? p.editable_parameters?.[0];
if (param && typeof param.proposed === 'number' && typeof param.current === 'number' && ending !== 'hangup') {
  const mid = Math.round(((param.proposed + param.current) / 2) * 100) / 100;
  await say(`Make the ${param.label} ${mid} ${param.unit} instead.`);
  const r = await tool('revise_proposal', { base_revision: rev, parameter_key: param.key, new_value: String(mid), unit: param.unit, rationale: 'Supervisor prefers a smaller change.' });
  if (r.accepted) rev = r.new_revision;
}
if (ending === 'hangup') {
  await say('I need to go — call me later.');
  await json('POST', `/api/calls/${call._id}/end`, { answer_token, reason: 'hung up by human' });
  console.log('\n📴 hung up without a decision');
  process.exit(0);
}
const verb = ending === 'reject' ? 'reject' : 'approve';
await say(`I ${verb} revision ${rev}.`);
await tool('submit_decision', { revision: rev, decision: verb === 'approve' ? 'APPROVE' : 'REJECT', confirmation_utterance: `I ${verb} revision ${rev}.` });
for (let i = 0; i < 8 && verb === 'approve'; i++) {
  const s = await tool('get_execution_status');
  if (['APPLIED', 'FAILED', 'REJECTED_BY_HARNESS', 'CANCELLED'].includes(s.execution_status)) break;
  await pause(1500);
}
await json('POST', `/api/calls/${call._id}/end`, { answer_token, reason: 'agent ended call' });
console.log('\n📴 call ended');
