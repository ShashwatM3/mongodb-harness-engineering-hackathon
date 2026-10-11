import { z } from 'zod';
import {
  ExecutionEvent,
  Metric,
  ReviseResult,
  SubmitDecisionResult,
  SupervisorAnswer,
  Trajectory,
  type Change,
  type IncidentInput,
  type ProposalContent,
} from '../../shared/schemas';
import type { HarnessAdapter, HarnessDecision } from './adapter';

/**
 * Real harness adapter. Speaks the HTTP contract in docs/HARNESS_CONTRACT.md. Every response is schema-validated; a
 * malformed response is an error, never silently accepted.
 */
export class HttpHarnessAdapter implements HarnessAdapter {
  readonly name = 'http';

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {
    if (!baseUrl) throw new Error('HARNESS_BASE_URL is required when HARNESS_MODE=http');
  }

  private async call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = this.timeoutMs): Promise<T | null> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`harness ${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return schema.parse(await res.json());
  }

  async askSupervisor(incident: IncidentInput, question: string, query_id: string): Promise<SupervisorAnswer> {
    // The supervisor may take long; the gateway applies its own sync budget and keeps this request running.
    const r = await this.call(SupervisorAnswer, 'POST', '/supervisor/questions', { incident_id: incident.incident_id, task_id: incident.task_id, query_id, question }, {}, this.timeoutMs * 6);
    return r ?? { status: 'UNAVAILABLE', evidence_refs: [], limitations: 'The harness has no supervisor endpoint for this incident.' };
  }

  async getTrajectory(incident: IncidentInput): Promise<Trajectory | null> {
    return this.call(Trajectory, 'GET', `/incidents/${encodeURIComponent(incident.incident_id)}/trajectory`);
  }

  async getMetrics(incident: IncidentInput, keys?: string[]): Promise<Metric[]> {
    const qs = keys?.length ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
    return (await this.call(z.object({ metrics: z.array(Metric) }), 'GET', `/incidents/${encodeURIComponent(incident.incident_id)}/metrics${qs}`))?.metrics ?? [];
  }

  async reviseProposal(incident: IncidentInput, base: ProposalContent, changes: Change[], rationale: string, requested_by: string): Promise<ReviseResult> {
    const r = await this.call(ReviseResult, 'POST', `/proposals/${encodeURIComponent(base.proposal_id)}/revisions`, {
      incident_id: incident.incident_id,
      base_revision: base.revision,
      changes,
      rationale,
      requested_by,
    });
    if (!r) throw new Error('harness has no revision endpoint for this proposal');
    return r;
  }

  async submitDecision(_incident: IncidentInput, d: HarnessDecision): Promise<SubmitDecisionResult> {
    const r = await this.call(SubmitDecisionResult, 'POST', '/decisions', d, { 'idempotency-key': d.idempotency_key });
    if (!r) throw new Error('harness has no decisions endpoint');
    return r;
  }

  async getExecutionStatus(_incident: IncidentInput, execution_id: string): Promise<ExecutionEvent | null> {
    return this.call(ExecutionEvent, 'GET', `/executions/${encodeURIComponent(execution_id)}`);
  }
}
