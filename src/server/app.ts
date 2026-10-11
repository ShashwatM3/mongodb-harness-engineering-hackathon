import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Gateway } from './gateway';
import { registerAgentTools } from './routes/agent-tools';
import { registerApiRoutes } from './routes/api';
import { errorBody } from './routes/common';
import { registerDevRoutes } from './routes/dev';
import { registerHarnessRoutes } from './routes/harness';
import { registerWebhookRoutes } from './routes/webhooks';

export async function buildApp(gw: Gateway, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers["xi-api-key"]'] } : false,
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = errorBody(err);
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.code(status).send(body);
  });

  app.get('/healthz', async () => {
    await gw.db.db.command({ ping: 1 });
    return { ok: true, harness: gw.harness.name, call_mode: gw.config.CALL_MODE };
  });

  registerHarnessRoutes(app, gw);
  registerAgentTools(app, gw);
  registerApiRoutes(app, gw);
  registerWebhookRoutes(app, gw);
  registerDevRoutes(app, gw);

  const webDist = join(process.cwd(), 'dist', 'web');
  if (existsSync(webDist)) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/v1')) return reply.sendFile('index.html');
      return reply.code(404).send({ error_code: 'NOT_FOUND', message: 'Route not found.' });
    });
  }
  return app;
}
