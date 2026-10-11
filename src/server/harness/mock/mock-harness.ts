import type {
  Change,
  ExecutionEvent,
  ExecutionStatus,
  IncidentInput,
  Metric,
  ProposalContent,
  ReviseResult,
  SubmitDecisionResult,
  SupervisorAnswer,
  Trajectory,
} from '../../../shared/schemas';
import { sleep } from '../../domain/util';
import type { ExecutionEventSink, HarnessAdapter, HarnessDecision } from '../adapter';
import { loadScenarios, type Scenario, type ScenarioOutcome } from './scenario';
import type { SupervisorBrain } from './supervisor';

/**
 * In-process simulation of the robotics harness (supervisor + execution), driven entirely by scenario data. It honours
 * the same contract as the real harness: idempotent decision intake, harness-side validation, and asynchronous,
 * sequenced execution events. Nothing here is real robot data.
 */
export class MockHarness implements HarnessAdapter {
  readonly name = 'mock';
  readonly scenarios: Map<string, Scenario>;
  private readonly submissions = new Map<string, SubmitDecisionResult>();
  private readonly executions = new Map<string, ExecutionEvent>();
  private readonly outcomeOverrides = new Map<string, ScenarioOutcome>();
  /** Every decision delivered, in order — used by tests to assert exactly-once delivery. */
  readonly received: HarnessDecision[] = [];
  readonly questions: Array<{ incident_id: string; question: string }> = [];
  sink: ExecutionEventSink | null = null;

  constructor(
    private readonly brain: SupervisorBrain,
    private readonly stepMs: number,
    scenarios?: Map<string, Scenario>,
  ) {
    this.scenarios = scenarios ?? loadScenarios();
  }

  scenarioFor(incident: IncidentInput): Scenario {
    const name = incident.metadata?.mock_scenario;
    const s = typeof name === 'string' ? this.scenarios.get(name) : undefined;
    if (!s) throw new Error(`Mock harness has no scenario for incident ${incident.incident_id}`);
    return s;
  }

  setOutcome(incident_id: string, outcome: ScenarioOutcome) {
    this.outcomeOverrides.set(incident_id, outcome);
  }

  async askSupervisor(incident: IncidentInput, question: string): Promise<SupervisorAnswer> {
    const s = this.scenarioFor(incident);
    this.questions.push({ incident_id: incident.incident_id, question });
    if (s.supervisor.delay_ms) await sleep(s.supervisor.delay_ms);
    return this.brain.answer(s, question);
  }

  async getTrajectory(incident: IncidentInput): Promise<Trajectory | null> {
    const t = this.scenarioFor(incident).trajectory;
    return t ? { ...t, task_id: incident.task_id, robot_id: incident.robot_id } : null;
  }

  async getMetrics(incident: IncidentInput, keys?: string[]): Promise<Metric[]> {
    const all = this.scenarioFor(incident).metrics;
    if (!keys?.length) return all;
    const want = keys.map((k) => k.toLowerCase());
    return all.filter((m) => want.some((k) => m.key.toLowerCase().includes(k) || m.label.toLowerCase().includes(k)));
  }

  async reviseProposal(incident: IncidentInput, base: ProposalContent, changes: Change[], rationale: string, requested_by: string): Promise<ReviseResult> {
    const s = this.scenarioFor(incident);
    const free = changes.find((c) => c.op === 'request');
    if (free) {
      return {
        accepted: false,
        reason:
          'The supervisor cannot turn a free-text request into an executable change. Name one of the editable parameters and a value instead.',
      };
    }
    const params = base.editable_parameters.map((p) => ({ ...p }));
    for (const ch of changes) {
      if (ch.op !== 'set_param') continue;
      const p = params.find((x) => x.key === ch.key);
      if (!p) return { accepted: false, reason: `Parameter ${ch.key} is not editable.` };
      const v = Number(ch.value);
      for (const r of s.reconcile.refuse) {
        if (r.key === ch.key && ((r.op === 'gt' && v > r.value) || (r.op === 'lt' && v < r.value) || (r.op === 'eq' && v === r.value))) {
          return { accepted: false, reason: r.reason };
        }
      }
      p.proposed_value = ch.value;
    }
    const changed = params.filter((p) => p.proposed_value !== p.current_value);
    return {
      accepted: true,
      proposal: {
        ...base,
        source_agent: `${base.source_agent} (reconciled)`,
        summary: changed.map((p) => `Set ${p.label} to ${p.proposed_value} ${p.unit} (currently ${p.current_value} ${p.unit})`).join('; ') || base.summary,
        changes: changed.map((p) => ({ op: 'set_param' as const, key: p.key, value: p.proposed_value, unit: p.unit })),
        editable_parameters: params,
        justification: `${base.justification} Modified at the request of ${requested_by}: ${rationale}`,
      },
      note: 'Reconciled by the mock supervisor; harness-side limits checked.',
    };
  }

  async submitDecision(incident: IncidentInput, d: HarnessDecision): Promise<SubmitDecisionResult> {
    const prior = this.submissions.get(d.idempotency_key);
    if (prior) return prior; // idempotent intake
    this.received.push(d);
    let result: SubmitDecisionResult;
    if (d.decision !== 'APPROVE') {
      result = { accepted: true, reason: `${d.decision} recorded by supervisor; no execution.` };
    } else {
      const execution_id = `exec_${d.decision_id.slice(4, 16)}`;
      result = { accepted: true, execution_id, status: 'RECEIVED' };
      const outcome = this.outcomeOverrides.get(incident.incident_id) ?? this.scenarioFor(incident).execution.outcome;
      void this.runExecution(incident, d, execution_id, outcome);
    }
    this.submissions.set(d.idempotency_key, result);
    return result;
  }

  async getExecutionStatus(_incident: IncidentInput, execution_id: string): Promise<ExecutionEvent | null> {
    return this.executions.get(execution_id) ?? null;
  }

  private async runExecution(incident: IncidentInput, d: HarnessDecision, execution_id: string, outcome: ScenarioOutcome) {
    const s = this.scenarioFor(incident);
    const steps: Array<[ExecutionStatus, string]> =
      outcome === 'REJECTED_BY_HARNESS'
        ? [['RECEIVED', 'Decision received.'], ['VALIDATING', 'Checking change against safety envelope.'], ['REJECTED_BY_HARNESS', s.execution.detail]]
        : [
            ['RECEIVED', 'Decision received.'],
            ['VALIDATING', 'Checking change against safety envelope.'],
            ['ACCEPTED', 'Change passed harness validation.'],
            ['EXECUTING', `Applying revision ${d.revision} to ${incident.robot_id}.`],
            [outcome, s.execution.detail],
          ];
    for (const [i, [status, detail]] of steps.entries()) {
      await sleep(this.stepMs);
      const e: ExecutionEvent = {
        execution_id,
        decision_id: d.decision_id,
        incident_id: incident.incident_id,
        seq: i,
        status,
        detail,
        result_metrics: status === 'APPLIED' ? s.execution.result_metrics : undefined,
        timestamp: new Date().toISOString(),
      };
      this.executions.set(execution_id, e);
      try {
        await this.sink?.(e);
      } catch (err) {
        console.error('[mock-harness] execution event rejected by gateway', err);
      }
    }
  }
}
