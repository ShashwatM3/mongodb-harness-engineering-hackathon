import type { Change, FeedbackAck, IncidentInput, Metric, ProposalContent, ReviseResult, SupervisorAnswer, Trajectory } from '../../../shared/schemas';
import { sleep } from '../../domain/util';
import type { HarnessAdapter, HumanFeedback } from '../adapter';
import { loadScenarios, type Scenario } from './scenario';
import type { SupervisorBrain } from './supervisor';

/**
 * In-process simulation of the robotics harness supervisor, driven entirely by scenario data. It honours the same
 * contract as the real harness: grounded answers, harness-side validation of revisions, idempotent feedback intake.
 * Nothing here is real robot data.
 */
export class MockHarness implements HarnessAdapter {
  readonly name = 'mock';
  readonly scenarios: Map<string, Scenario>;
  private readonly acks = new Map<string, FeedbackAck>();
  /** Every feedback record delivered, in order — used by tests to assert exactly-once delivery. */
  readonly received: HumanFeedback[] = [];
  readonly questions: Array<{ incident_id: string; question: string }> = [];
  /** Test hook: make the next N deliveries fail. */
  failNextDeliveries = 0;

  constructor(
    private readonly brain: SupervisorBrain,
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
    if (changes.some((c) => c.op === 'request')) {
      return { accepted: false, reason: 'I can only change one of the listed settings to a specific value. Which setting and what value?' };
    }
    const params = base.editable_parameters.map((p) => ({ ...p }));
    for (const ch of changes) {
      if (ch.op !== 'set_param') continue;
      const p = params.find((x) => x.key === ch.key);
      if (!p) return { accepted: false, reason: `${ch.key} is not something I can change.` };
      const v = Number(ch.value);
      for (const r of s.reconcile.refuse) {
        if (r.key === ch.key && ((r.op === 'gt' && v > r.value) || (r.op === 'lt' && v < r.value) || (r.op === 'eq' && v === r.value))) {
          return { accepted: false, reason: r.reason };
        }
      }
      p.proposed_value = ch.value;
    }
    const changed = params.filter((p) => p.proposed_value !== p.current_value);
    const plain = changed.map((p) => `${p.label} goes from ${p.current_value} to ${p.proposed_value} ${p.unit}`).join(', and ');
    return {
      accepted: true,
      proposal: {
        ...base,
        source_agent: `${base.source_agent} (reconciled)`,
        summary: changed.map((p) => `Set ${p.label} to ${p.proposed_value} ${p.unit} (currently ${p.current_value} ${p.unit})`).join('; ') || base.summary,
        plain_summary: plain ? `Updated plan: ${plain}.` : base.plain_summary,
        changes: changed.map((p) => ({ op: 'set_param' as const, key: p.key, value: p.proposed_value, unit: p.unit })),
        editable_parameters: params,
        justification: `${base.justification} Changed at the request of ${requested_by}: ${rationale}`,
      },
      note: 'Reconciled by the mock supervisor; harness-side limits checked.',
    };
  }

  async submitFeedback(_incident: IncidentInput, f: HumanFeedback): Promise<FeedbackAck> {
    const prior = this.acks.get(f.idempotency_key);
    if (prior) return prior; // idempotent intake
    if (this.failNextDeliveries > 0) {
      this.failNextDeliveries--;
      throw new Error('mock harness unavailable');
    }
    this.received.push(f);
    const ack = { accepted: true, reason: `Feedback (${f.decision.toLowerCase()}) received by the supervisor.` };
    this.acks.set(f.idempotency_key, ack);
    return ack;
  }
}
