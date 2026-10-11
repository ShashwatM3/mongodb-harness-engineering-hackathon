import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app';
import { loadConfig, type Config } from '../src/server/config';
import { createGateway, type Gateway } from '../src/server/gateway';
import { MockHarness } from '../src/server/harness/mock/mock-harness';
import { buildIncident } from '../src/server/harness/mock/scenario';
import { FactLookupSupervisor } from '../src/server/harness/mock/supervisor';

export const HARNESS_TOKEN = 'test-harness-token-0123456789';
export const TOOL_SECRET = 'test-tool-secret-0123456789';

export interface TestEnv {
  gw: Gateway;
  app: FastifyInstance;
  mock: MockHarness;
  close(): Promise<void>;
}

export async function setup(overrides: Partial<Record<keyof Config, unknown>> = {}): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: 'memory',
    MONGODB_DB: 'test',
    HARNESS_TOKEN,
    TOOL_SECRET,
    CALL_MODE: 'scripted',
    SUPERVISOR_SYNC_BUDGET_MS: 500,
    CALL_RETRY_DELAY_MS: 0,
    ANTHROPIC_API_KEY: '',
    ELEVENLABS_API_KEY: '',
    ELEVENLABS_AGENT_ID: '',
    ELEVENLABS_WEBHOOK_SECRET: 'whsec_test',
    ...overrides,
  });
  const mock = new MockHarness(new FactLookupSupervisor());
  const gw = await createGateway(config, { harness: mock });
  const app = await buildApp(gw);
  return {
    gw,
    app,
    mock,
    async close() {
      await app.close();
      await gw.stop();
    },
  };
}

let seq = 0;
export function incidentFor(env: TestEnv, scenario: string, id?: string) {
  const s = env.mock.scenarios.get(scenario)!;
  const n = `${scenario}-${Date.now().toString(36)}-${seq++}`;
  return buildIncident(s, { incident_id: id ?? `inc-${n}`, event_id: `evt-${n}` });
}

export async function postIncident(env: TestEnv, body: unknown, token = HARNESS_TOKEN) {
  return env.app.inject({ method: 'POST', url: '/v1/incidents', headers: { authorization: `Bearer ${token}` }, payload: body as object });
}

/** Creates an incident via the harness API, runs the call worker, and returns the active (scripted, answered) call. */
export async function triggerAndAnswer(env: TestEnv, scenario: string) {
  const inc = incidentFor(env, scenario);
  const res = await postIncident(env, inc);
  if (res.statusCode !== 201) throw new Error(`trigger failed ${res.statusCode} ${res.body}`);
  await env.gw.tick();
  const call = await env.gw.db.c.calls.findOne({ incident_id: inc.incident_id, active: true });
  if (!call) throw new Error('no active call');
  return { incident_id: inc.incident_id, call_id: call._id, conversation_id: call.conversation_id!, proposal_id: inc.proposal.proposal_id };
}

export type Ctx = Awaited<ReturnType<typeof triggerAndAnswer>>;

/** Plays the ElevenLabs agent: calls a webhook tool exactly as the provider would. */
export async function tool(env: TestEnv, ctx: Ctx, name: string, args: Record<string, unknown> = {}, secret = TOOL_SECRET) {
  const res = await env.app.inject({
    method: 'POST',
    url: `/v1/agent-tools/${name}`,
    headers: { authorization: `Bearer ${secret}` },
    payload: { incident_id: ctx.incident_id, call_id: ctx.call_id, conversation_id: ctx.conversation_id, ...args },
  });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function incidentState(env: TestEnv, id: string) {
  return (await env.gw.incidents.get(id)).state;
}

/** Runs the outbox until it is empty. */
export async function drain(env: TestEnv) {
  await env.gw.dispatcher.tick();
}
