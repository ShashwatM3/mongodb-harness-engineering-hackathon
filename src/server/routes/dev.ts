import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../domain/errors';
import type { Gateway } from '../gateway';
import { buildIncident } from '../harness/mock/scenario';

/**
 * Development-only routes (disabled when NODE_ENV=production). They play the role of the mock supervisor sending an
 * incident through the same validated ingestion path the real harness uses.
 */
export function registerDevRoutes(app: FastifyInstance, gw: Gateway) {
  if (gw.config.NODE_ENV === 'production') return;

  app.post<{ Params: { name: string } }>('/dev/scenarios/:name/trigger', async (req, reply) => {
    if (!gw.mock) throw new GatewayError('NOT_AVAILABLE', 'Scenarios need HARNESS_MODE=mock.', 400);
    const s = gw.mock.scenarios.get(req.params.name);
    if (!s) throw new GatewayError('NOT_FOUND', `No scenario ${req.params.name}.`, 404);
    const suffix = crypto.randomUUID().slice(0, 8);
    const input = buildIncident(s, { incident_id: `inc-${s.name}-${suffix}`, event_id: `evt-${s.name}-${suffix}` });
    const r = await gw.incidents.ingest(input);
    void gw.tick();
    return reply.code(201).send({ ...r, scenario: s.name });
  });

  app.post<{ Params: { id: string } }>('/dev/mock/outcome', async (req) => {
    if (!gw.mock) throw new GatewayError('NOT_AVAILABLE', 'Needs HARNESS_MODE=mock.', 400);
    const { incident_id, outcome } = z.object({ incident_id: z.string(), outcome: z.enum(['APPLIED', 'FAILED', 'REJECTED_BY_HARNESS']) }).parse(req.body);
    gw.mock.setOutcome(incident_id, outcome);
    return { ok: true };
  });
}
