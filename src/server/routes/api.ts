import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DecisionRequest, ReviseRequest } from '../../shared/schemas';
import { GatewayError } from '../domain/errors';
import type { Requester } from '../domain/proposals';
import type { Gateway } from '../gateway';
import { bearer, safeEqual } from './common';

/**
 * Dashboard API. Demo simplification: dashboard actions are attributed to the incident's responsible supervisor
 * (DASHBOARD_SESSION). Set DASHBOARD_TOKEN to require a bearer token; production needs real SSO.
 */
export function registerApiRoutes(app: FastifyInstance, gw: Gateway) {
  const authed = (req: FastifyRequest, reply: FastifyReply) => {
    const t = gw.config.DASHBOARD_TOKEN;
    if (!t) return true;
    const q = (req.query as Record<string, string | undefined>)?.token ?? '';
    if (safeEqual(bearer(req), t) || safeEqual(q, t)) return true;
    void reply.code(401).send({ error_code: 'UNAUTHORIZED', message: 'Dashboard token required.' });
    return false;
  };
  const dashboardRequester = async (incident_id: string): Promise<Requester> => {
    const inc = await gw.incidents.get(incident_id);
    return { channel: 'DASHBOARD', supervisor_id: inc.incident.responsible_supervisor.id, call_id: null, conversation_id: null };
  };

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && !authed(req, reply)) return reply;
  });

  app.get('/api/config', async () => ({
    harness: gw.harness.name,
    call_mode: gw.config.CALL_MODE,
    elevenlabs_configured: Boolean(gw.config.ELEVENLABS_API_KEY && gw.config.ELEVENLABS_AGENT_ID),
    scenarios: gw.mock ? [...gw.mock.scenarios.values()].map((s) => ({ name: s.name, title: s.title, description: s.description })) : [],
  }));

  app.get('/api/incidents', async () => gw.incidents.list());
  app.get<{ Params: { id: string } }>('/api/incidents/:id', async (req) => gw.incidents.aggregate(req.params.id));

  app.get<{ Params: { id: string } }>('/api/incidents/:id/trajectory', async (req) => {
    const inc = await gw.incidents.get(req.params.id);
    return { trajectory: await gw.harness.getTrajectory(inc.incident) };
  });
  app.get<{ Params: { id: string } }>('/api/incidents/:id/metrics', async (req) => {
    const inc = await gw.incidents.get(req.params.id);
    return { metrics: await gw.harness.getMetrics(inc.incident) };
  });
  app.post<{ Params: { id: string } }>('/api/incidents/:id/questions', async (req) => {
    const { question } = z.object({ question: z.string().min(3).max(1000) }).parse(req.body);
    return gw.queries.ask(req.params.id, question, 'DASHBOARD', null);
  });
  app.post<{ Params: { id: string } }>('/api/incidents/:id/revisions', async (req) => {
    const body = ReviseRequest.parse(req.body);
    return gw.proposals.revise(req.params.id, body, await dashboardRequester(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/incidents/:id/decisions', async (req) => {
    const body = DecisionRequest.parse(req.body);
    return gw.decisions.decide(req.params.id, body, await dashboardRequester(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/api/decisions/:id/confirm', async (req) => {
    const d = await gw.db.c.decisions.findOne({ _id: req.params.id });
    if (!d) throw new GatewayError('NOT_FOUND', 'Decision not found.', 404);
    const who = await dashboardRequester(d.incident_id);
    await gw.decisions.confirm(req.params.id, who.supervisor_id);
    return { confirmed: true };
  });
  app.post<{ Params: { id: string } }>('/api/incidents/:id/call', async (req) => {
    await gw.calls.redial(req.params.id);
    return { queued: true };
  });

  // ---- simulated phone leg (softphone in the dashboard) ----
  app.post<{ Params: { id: string } }>('/api/calls/:id/answer', async (req) => {
    const call = await gw.calls.answer(req.params.id, true);
    return { ...(await sessionFor(gw, call._id)), answer_token: call.answer_token };
  });
  app.post<{ Params: { id: string } }>('/api/calls/:id/decline', async (req) => {
    await gw.calls.decline(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/calls/:id/connected', async (req) => {
    const { conversation_id, answer_token } = z.object({ conversation_id: z.string().min(1).max(200), answer_token: z.string().optional() }).parse(req.body);
    await gw.calls.assertAnsweredBy(req.params.id, answer_token);
    await gw.calls.connected(req.params.id, conversation_id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/calls/:id/end', async (req) => {
    const { reason, answer_token } = z.object({ reason: z.string().max(200).default('hung up'), answer_token: z.string().optional() }).parse(req.body ?? {});
    await gw.calls.assertAnsweredBy(req.params.id, answer_token);
    await gw.calls.end(req.params.id, reason);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/calls/:id/transcript', async (req) => {
    // Display-only, NON-authoritative: decisions come exclusively from tool calls.
    const { role, text, answer_token } = z.object({ role: z.string().max(20), text: z.string().max(4000), answer_token: z.string().optional() }).parse(req.body);
    await gw.calls.assertAnsweredBy(req.params.id, answer_token);
    await gw.db.c.calls.updateOne({ _id: req.params.id }, { $push: { transcript: { role, text, at: new Date() } } });
    const call = await gw.db.c.calls.findOne({ _id: req.params.id }, { projection: { incident_id: 1 } });
    if (call) gw.events.signal('call.transcript', call.incident_id, { call_id: req.params.id, role, text });
    return { ok: true };
  });

  // ---- live state (SSE) ----
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (e: { id: string; type: string }) => res.write(`${e.id ? `id: ${e.id}\n` : ''}data: ${JSON.stringify(e)}\n\n`);
    const unsubscribe = gw.events.subscribe(send);
    const last = (req.headers['last-event-id'] as string | undefined) ?? null;
    void gw.events.since(last).then((missed) => missed.forEach(send));
    res.write(': connected\n\n');
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      unsubscribe();
    });
  });
}

async function sessionFor(gw: Gateway, call_id: string) {
  const call = await gw.db.c.calls.findOne({ _id: call_id });
  if (!call) throw new GatewayError('NOT_FOUND', 'Call not found.', 404);
  const inc = await gw.incidents.get(call.incident_id);
  const dynamic_variables = {
    incident_id: inc._id,
    call_id: call._id,
    supervisor_name: inc.incident.responsible_supervisor.name,
    robot_id: inc.incident.robot_id,
    severity: inc.incident.severity,
    category: inc.incident.category,
    one_line_summary: inc.incident.failure_summary.slice(0, 300),
  };
  const { ELEVENLABS_API_KEY: key, ELEVENLABS_AGENT_ID: agent } = gw.config;
  if (!key || !agent) return { mode: 'unconfigured' as const, call_id, dynamic_variables };
  // Private agent: the browser gets a short-lived signed URL; the API key never leaves the server.
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agent)}`, {
    headers: { 'xi-api-key': key },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    await gw.events.emit('call.provider_error', inc._id, 'ELEVENLABS', { status: res.status, detail });
    throw new GatewayError('PROVIDER_ERROR', `ElevenLabs refused the session (HTTP ${res.status}).`, 502);
  }
  const { signed_url } = (await res.json()) as { signed_url: string };
  return { mode: 'elevenlabs' as const, call_id, signed_url, dynamic_variables };
}
