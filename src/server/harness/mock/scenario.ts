import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ExecutionStatus, IncidentInput, Metric, ProposalContent, Trajectory, ValueKind } from '../../../shared/schemas';

/**
 * A mock scenario is pure data: the incident the supervisor would send, plus the evidence, telemetry, reconciliation
 * rules and execution outcome the mock harness uses to answer. All values are SYNTHETIC.
 */
export const Scenario = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  incident: IncidentInput.omit({ event_id: true, incident_id: true, timestamp: true, proposal: true }),
  proposal: ProposalContent.omit({ proposal_id: true, revision: true, created_at: true }),
  trajectory: Trajectory.nullable(),
  metrics: z.array(Metric),
  evidence: z.object({
    facts: z.array(z.object({ id: z.string(), kind: ValueKind, text: z.string(), tags: z.array(z.string()) })),
    unavailable: z.array(z.object({ topic: z.string(), tags: z.array(z.string()), reason: z.string() })).default([]),
    overall_confidence: z.number().min(0).max(1).optional(),
  }),
  supervisor: z.object({ delay_ms: z.number().int().min(0).default(0) }).default({ delay_ms: 0 }),
  reconcile: z
    .object({
      refuse: z.array(z.object({ key: z.string(), op: z.enum(['gt', 'lt', 'eq']), value: z.number(), reason: z.string() })).default([]),
    })
    .default({ refuse: [] }),
  execution: z.object({
    outcome: z.enum(['APPLIED', 'FAILED', 'REJECTED_BY_HARNESS']),
    detail: z.string(),
    result_metrics: z.array(Metric).default([]),
  }),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioOutcome = Scenario['execution']['outcome'];
export { ExecutionStatus };

const here = dirname(fileURLToPath(import.meta.url));
export const SCENARIO_DIR = join(here, 'scenarios');

export function loadScenarios(dir = SCENARIO_DIR): Map<string, Scenario> {
  const out = new Map<string, Scenario>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = Scenario.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!parsed.success) throw new Error(`Invalid scenario ${f}: ${parsed.error.message}`);
    out.set(parsed.data.name, parsed.data);
  }
  return out;
}

/** Builds the incident payload the (mock) supervisor POSTs to the gateway for a scenario. */
export function buildIncident(s: Scenario, ids: { incident_id: string; event_id: string }, now = new Date()): IncidentInput {
  return IncidentInput.parse({
    ...s.incident,
    schema_version: '1',
    event_id: ids.event_id,
    incident_id: ids.incident_id,
    timestamp: now.toISOString(),
    synthetic: true,
    metadata: { ...s.incident.metadata, mock_scenario: s.name },
    proposal: { ...s.proposal, proposal_id: `prop_${ids.incident_id}`, revision: 1, created_at: now.toISOString() },
  });
}
