import { SupervisorAnswer, type Channel } from '../../shared/schemas';
import type { Database, SupervisorQueryDoc } from '../db';
import type { HarnessAdapter } from '../harness/adapter';
import { GatewayError } from './errors';
import type { EventLog } from './events';
import type { IncidentService } from './incidents';
import { normalizeQuestion, withTimeout } from './util';

const DEDUPE_WINDOW_MS = 60_000;

/**
 * Forwards arbitrary questions to the harness supervisor. Answers within the sync budget are returned directly; slower
 * analyses return PENDING with a query_id and keep running server-side, so the agent can say "still checking" and poll
 * instead of improvising. A repeated question (e.g. a tool retry) within the dedupe window reuses the same query.
 */
export class SupervisorQueries {
  private readonly inflight = new Map<string, Promise<SupervisorAnswer>>();

  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly incidents: IncidentService,
    private readonly harness: HarnessAdapter,
    private readonly syncBudgetMs: number,
    private readonly hardTimeoutMs: number,
  ) {}

  async ask(incident_id: string, question: string, channel: Channel, call_id: string | null) {
    const inc = await this.incidents.get(incident_id);
    const normalized = normalizeQuestion(question);
    if (normalized.length < 3) throw new GatewayError('INVALID_ARGUMENTS', 'The question is empty.', 422);

    const recent = await this.db.c.supervisor_queries.findOne(
      { incident_id, normalized, call_id, created_at: { $gte: new Date(Date.now() - DEDUPE_WINDOW_MS) }, status: { $ne: 'UNAVAILABLE' } },
      { sort: { created_at: -1 } },
    );
    if (recent) return this.await(recent, this.syncBudgetMs);

    const doc: SupervisorQueryDoc = {
      _id: `q_${crypto.randomUUID()}`,
      incident_id,
      call_id,
      channel,
      question,
      normalized,
      status: 'PENDING',
      result: null,
      created_at: new Date(),
      answered_at: null,
    };
    await this.db.c.supervisor_queries.insertOne(doc);
    await this.events.emit('supervisor.question', incident_id, channel, { query_id: doc._id, question });

    const work = withTimeout(this.harness.askSupervisor(inc.incident, question, doc._id), this.hardTimeoutMs, 'supervisor')
      .then((raw) => SupervisorAnswer.parse(raw))
      .catch(
        (err): SupervisorAnswer => ({
          status: 'UNAVAILABLE',
          evidence_refs: [],
          limitations: `The supervisor did not return an answer (${(err as Error).message}).`,
        }),
      )
      .then(async (result) => {
        const status = result.status === 'PENDING' ? 'UNAVAILABLE' : result.status;
        const final = { ...result, status };
        await this.db.c.supervisor_queries.updateOne({ _id: doc._id }, { $set: { status, result: final, answered_at: new Date() } });
        await this.events.emit('supervisor.answer', incident_id, 'HARNESS', { query_id: doc._id, status, answer: final.answer ?? null });
        return final;
      })
      .finally(() => this.inflight.delete(doc._id));
    this.inflight.set(doc._id, work);
    return this.await(doc, this.syncBudgetMs);
  }

  async get(incident_id: string, query_id: string, waitMs = 2_000) {
    const doc = await this.db.c.supervisor_queries.findOne({ _id: query_id, incident_id });
    if (!doc) throw new GatewayError('NOT_FOUND', 'No such question for this incident.', 404);
    return this.await(doc, waitMs);
  }

  private async await(doc: SupervisorQueryDoc, budgetMs: number): Promise<{ query_id: string; question: string } & SupervisorAnswer> {
    if (doc.status !== 'PENDING' && doc.result) return { query_id: doc._id, question: doc.question, ...doc.result };
    const p = this.inflight.get(doc._id);
    if (p) {
      try {
        const r = await withTimeout(p, budgetMs, 'sync budget');
        return { query_id: doc._id, question: doc.question, ...r };
      } catch {
        /* budget exceeded: fall through to PENDING */
      }
    } else {
      // Lost in a restart: report honestly rather than waiting forever.
      const fresh = await this.db.c.supervisor_queries.findOne({ _id: doc._id });
      if (fresh?.result) return { query_id: doc._id, question: doc.question, ...fresh.result };
      return {
        query_id: doc._id,
        question: doc.question,
        status: 'UNAVAILABLE',
        evidence_refs: [],
        limitations: 'This question was interrupted by a gateway restart. Ask it again.',
      };
    }
    return {
      query_id: doc._id,
      question: doc.question,
      status: 'PENDING',
      evidence_refs: [],
      limitations: 'The supervisor is still analysing. Check back with get_supervisor_answer.',
    };
  }
}
