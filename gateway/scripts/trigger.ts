// Plays the robotics supervisor: POSTs a synthetic scenario incident to the gateway's real harness endpoint.
//   npm run trigger -- A            (scenarios A–E, see src/server/harness/mock/scenarios)
//   npm run trigger -- A --twice    (redelivers the same event to show dedupe)
import { buildIncident, loadScenarios } from '../src/server/harness/mock/scenario';

const [name = 'A', ...flags] = process.argv.slice(2);
const base = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const token = process.env.HARNESS_TOKEN || 'dev-harness-token-change-me';

const s = loadScenarios().get(name);
if (!s) {
  console.error(`Unknown scenario ${name}. Available: ${[...loadScenarios().keys()].join(', ')}`);
  process.exit(1);
}
const suffix = Math.random().toString(36).slice(2, 8);
const incident = buildIncident(s, { incident_id: `inc-${name}-${suffix}`, event_id: `evt-${name}-${suffix}` });

for (let i = 0; i < (flags.includes('--twice') ? 2 : 1); i++) {
  const res = await fetch(`${base}/v1/incidents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(incident),
  });
  console.log(`POST /v1/incidents → ${res.status}`, await res.text());
}
