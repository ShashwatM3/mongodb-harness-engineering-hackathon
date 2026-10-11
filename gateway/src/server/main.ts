import { buildApp } from './app';
import { loadConfig } from './config';
import { createGateway } from './gateway';

const config = loadConfig();
if (config.NODE_ENV === 'production' && (config.HARNESS_TOKEN.startsWith('dev-') || config.TOOL_SECRET.startsWith('dev-'))) {
  throw new Error('Refusing to start in production with default HARNESS_TOKEN / TOOL_SECRET.');
}
if (config.MONGODB_URI === 'memory') console.warn('[gateway] MONGODB_URI=memory: using a throwaway in-process replica set. Nothing persists across restarts.');

const gw = await createGateway(config);
const app = await buildApp(gw, { logger: true });
gw.startWorkers();
await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`[gateway] harness=${gw.harness.name} calls=${config.CALL_MODE} elevenlabs=${config.ELEVENLABS_AGENT_ID ? 'configured' : 'not configured'}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await app.close();
    await gw.stop();
    process.exit(0);
  });
}
