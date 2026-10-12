// Verifies live credentials before a demo: MongoDB (ping + transaction) and ElevenLabs (key + Agents access).
//   npm run check:setup
import { MongoClient } from 'mongodb';

const ok = (m: string) => console.log(`✓ ${m}`);
const bad = (m: string) => console.log(`✗ ${m}`);
let failed = false;

async function checkMongo() {
  const uri = process.env.MONGODB_URI ?? '';
  if (!uri || uri === 'memory') return bad('MONGODB_URI is not set (or is `memory`) — paste your Atlas connection string into .env');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'intervention-gateway-check' });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'intervention_gateway');
    await db.command({ ping: 1 });
    ok(`MongoDB reachable (db "${db.databaseName}")`);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await db.collection('_setup_check').insertOne({ at: new Date() }, { session });
      });
      await db.collection('_setup_check').drop().catch(() => {});
      ok('MongoDB transactions work (replica set)');
    } finally {
      await session.endSession();
    }
  } catch (err) {
    failed = true;
    const msg = (err as Error).message;
    bad(`MongoDB: ${msg}`);
    if (/whitelist|IP|timed out|ENOTFOUND|Server selection/i.test(msg)) console.log('  → In Atlas: Network Access → add your current IP (or 0.0.0.0/0 for the hackathon).');
    if (/auth/i.test(msg)) console.log('  → Check the database user/password in the URI (Atlas → Database Access).');
  } finally {
    await client.close();
  }
}

async function checkElevenLabs() {
  const key = process.env.ELEVENLABS_API_KEY ?? '';
  if (!key) return bad('ELEVENLABS_API_KEY is not set');
  const get = (path: string) => fetch(`https://api.elevenlabs.io${path}`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) });
  const agents = await get('/v1/convai/agents?page_size=5');
  if (agents.ok) {
    const body = (await agents.json()) as { agents?: Array<{ agent_id: string; name: string }> };
    ok(`ElevenLabs key works with Agents access (${body.agents?.length ?? 0} agent(s) visible)`);
  } else {
    failed = true;
    bad(`ElevenLabs Agents API → HTTP ${agents.status}: ${(await agents.text()).slice(0, 200)}`);
    console.log('  → The key needs "ElevenLabs Agents" read+write permission (Settings → API Keys → edit key).');
  }
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (agentId) {
    const r = await get(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
    if (r.ok) ok(`Signed URL can be minted for agent ${agentId}`);
    else {
      failed = true;
      bad(`Signed URL for ${agentId} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
  } else console.log('· ELEVENLABS_AGENT_ID not set yet (run npm run provision:agent)');
  const base = process.env.PUBLIC_BASE_URL ?? '';
  if (!base.startsWith('https://')) console.log('· PUBLIC_BASE_URL not set to an https tunnel yet');
  else {
    const h = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch((e) => e as Error);
    if (h instanceof Response && h.ok) ok(`Gateway reachable through tunnel ${base}`);
    else {
      failed = true;
      bad(`Gateway not reachable at ${base}/healthz (is the server + tunnel running?)`);
    }
  }
}

async function checkPhone() {
  if (process.env.CALL_MODE !== 'twilio') return console.log('· CALL_MODE is not twilio (calls ring the dashboard softphone)');
  const key = process.env.ELEVENLABS_API_KEY ?? '';
  const id = process.env.ELEVENLABS_PHONE_NUMBER_ID ?? '';
  if (!id) {
    failed = true;
    return bad('ELEVENLABS_PHONE_NUMBER_ID is not set (npm run phone:numbers)');
  }
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${encodeURIComponent(id)}`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) {
    failed = true;
    return bad(`Phone number ${id} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const n = (await r.json()) as { phone_number?: string; supports_outbound?: boolean };
  if (n.supports_outbound === false) {
    failed = true;
    bad(`Phone number ${n.phone_number} does not support outbound calls`);
  } else ok(`Phone number ${n.phone_number} is imported and can call out`);
  const allowed = (process.env.CALL_ALLOWED_NUMBERS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const target = (process.env.SUPERVISOR_PHONE ?? '').trim();
  if (!target || !allowed.includes(target)) {
    failed = true;
    bad('SUPERVISOR_PHONE must be set and listed in CALL_ALLOWED_NUMBERS (E.164, e.g. +14155550123)');
  } else ok(`Will call ${target.slice(0, -4).replace(/\d/g, '•')}${target.slice(-4)} (allow-listed)`);
}

await checkMongo();
await checkElevenLabs();
await checkPhone();
process.exit(failed ? 1 : 0);
