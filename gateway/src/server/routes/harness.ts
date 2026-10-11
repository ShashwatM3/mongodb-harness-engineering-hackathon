import type { FastifyInstance } from 'fastify';
import { IncidentInput } from '../../shared/schemas';
import type { Gateway } from '../gateway';
import { requireBearer } from './common';

/** Harness → gateway. Authenticated with HARNESS_TOKEN. */
export function registerHarnessRoutes(app: FastifyInstance, gw: Gateway) {
  app.post('/v1/incidents', async (req, reply) => {
    if (!requireBearer(req, reply, gw.config.HARNESS_TOKEN)) return;
    const parsed = IncidentInput.safeParse(req.body);
    if (!parsed.success) {
      await gw.events.emit('incident.rejected_invalid', null, 'HARNESS', { issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) });
      throw parsed.error;
    }
    const r = await gw.incidents.ingest(parsed.data);
    if (!r.duplicate) void gw.tick();
    return reply.code(r.duplicate ? 200 : 201).send({ incident_id: r.incident_id, duplicate: r.duplicate });
  });
}
