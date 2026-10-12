import type { ClientSession } from 'mongodb';
import type { IncidentInput, IncidentState } from '../../shared/schemas';
import { isDuplicateKey, type Database, type IncidentDoc } from '../db';
import { GatewayError, notFound } from './errors';
import type { Actor, EventLog } from './events';
import { canTransition, legalSourcesFor } from './state';

export const revisionDocId = (proposal_id: string, revision: number) => `${proposal_id}#${revision}`;

export class IncidentService {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
  ) {}

  /**
   * Persist a new incident and create its call job (state CALL_PENDING, next_call_at = now).
   * Idempotent on event_id: a redelivered trigger returns the existing incident and creates nothing.
   */
  async ingest(input: IncidentInput): Promise<{ incident_id: string; duplicate: boolean }> {
    const existing = await this.db.c.incidents.findOne({ event_id: input.event_id }, { projection: { _id: 1 } });
    if (existing) return { incident_id: existing._id, duplicate: true };
    if (input.proposal.revision !== 1) {
      throw new GatewayError('INVALID_PROPOSAL', 'A new incident must carry proposal revision 1.', 422);
    }
    const now = new Date();
    try {
      const audits = await this.db.txn(async (session) => {
        await this.db.c.incidents.insertOne(
          {
            _id: input.incident_id,
            event_id: input.event_id,
            incident: input,
            state: 'CALL_PENDING',
            proposal_id: input.proposal.proposal_id,
            call_attempts: 0,
            next_call_at: now,
            created_at: now,
            updated_at: now,
          },
          { session },
        );
        await this.db.c.proposal_heads.insertOne(
          {
            _id: input.proposal.proposal_id,
            incident_id: input.incident_id,
            latest_revision: 1,
            state: 'UNDER_REVIEW',
            decided_revision: null,
            decision: null,
            reconciling_since: null,
            version: 1,
          },
          { session },
        );
        await this.db.c.proposal_revisions.insertOne(
          {
            _id: revisionDocId(input.proposal.proposal_id, 1),
            incident_id: input.incident_id,
            proposal_id: input.proposal.proposal_id,
            revision: 1,
            based_on_revision: null,
            source: 'SUPERVISOR',
            requested_by: input.proposal.source_agent,
            request: null,
            status: 'PENDING_REVIEW',
            content: input.proposal,
            created_at: now,
          },
          { session },
        );
        return [
          await this.events.record(
            'incident.received',
            input.incident_id,
            'HARNESS',
            { event_id: input.event_id, category: input.category, severity: input.severity, robot_id: input.robot_id },
            session,
          ),
          await this.events.record('call.job_created', input.incident_id, 'SYSTEM', {}, session),
        ];
      });
      this.events.publish(...audits);
      return { incident_id: input.incident_id, duplicate: false };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const again = await this.db.c.incidents.findOne({ event_id: input.event_id }, { projection: { _id: 1 } });
      if (again) return { incident_id: again._id, duplicate: true };
      throw new GatewayError('INCIDENT_CONFLICT', 'An incident or proposal with this id already exists under a different event_id.', 409);
    }
  }

  async get(incident_id: string, session?: ClientSession): Promise<IncidentDoc> {
    const doc = await this.db.c.incidents.findOne({ _id: incident_id }, { session });
    if (!doc) throw notFound(`Incident ${incident_id}`);
    return doc;
  }

  /**
   * Compare-and-set state transition. Returns false (without writing) if the incident is not in a legal source state,
   * which makes concurrent transitions safe without locks.
   */
  async transition(
    incident_id: string,
    to: IncidentState,
    actor: Actor,
    data: Record<string, unknown> = {},
    session?: ClientSession,
    extra: Partial<IncidentDoc> = {},
  ) {
    const res = await this.db.c.incidents.findOneAndUpdate(
      { _id: incident_id, state: { $in: legalSourcesFor(to) } },
      { $set: { state: to, updated_at: new Date(), ...extra } },
      { session, returnDocument: 'before' },
    );
    if (!res) return null;
    return this.events.record('incident.state_changed', incident_id, actor, { from: res.state, to, ...data }, session);
  }

  /** Like `transition` but throws when the transition is illegal. */
  async mustTransition(incident_id: string, to: IncidentState, actor: Actor, data: Record<string, unknown>, session?: ClientSession) {
    const ev = await this.transition(incident_id, to, actor, data, session);
    if (ev) return ev;
    const cur = await this.get(incident_id, session);
    if (canTransition(cur.state, to)) return null;
    throw new GatewayError('ILLEGAL_STATE', `Incident is ${cur.state}; it cannot move to ${to}.`, 409, { state: cur.state });
  }

  async list() {
    const docs = await this.db.c.incidents.find({}).sort({ created_at: -1 }).limit(200).toArray();
    const ids = docs.map((d) => d._id);
    const [heads, calls] = await Promise.all([
      this.db.c.proposal_heads.find({ incident_id: { $in: ids } }).toArray(),
      this.db.c.calls.find({ incident_id: { $in: ids } }).sort({ created_at: -1 }).toArray(),
    ]);
    return docs.map((d) => {
      const head = heads.find((h) => h.incident_id === d._id);
      const call = calls.find((c) => c.incident_id === d._id);
      return {
        incident_id: d._id,
        state: d.state,
        severity: d.incident.severity,
        category: d.incident.category,
        robot_id: d.incident.robot_id,
        task_id: d.incident.task_id,
        failure_summary: d.incident.failure_summary,
        plain_summary: d.incident.plain_summary ?? d.incident.failure_summary,
        synthetic: d.incident.synthetic,
        latest_revision: head?.latest_revision ?? null,
        head_state: head?.state ?? null,
        call_status: call?.status ?? null,
        created_at: d.created_at.toISOString(),
        updated_at: d.updated_at.toISOString(),
      };
    });
  }

  /** Everything the dashboard detail page needs, in one read. */
  async aggregate(incident_id: string) {
    const doc = await this.get(incident_id);
    const [head, revisions, decisions, calls, queries, audit] = await Promise.all([
      this.db.c.proposal_heads.findOne({ _id: doc.proposal_id }),
      this.db.c.proposal_revisions.find({ proposal_id: doc.proposal_id }).sort({ revision: 1 }).toArray(),
      this.db.c.decisions.find({ incident_id }).sort({ created_at: 1 }).toArray(),
      this.db.c.calls.find({ incident_id }).sort({ created_at: 1 }).toArray(),
      this.db.c.supervisor_queries.find({ incident_id }).sort({ created_at: 1 }).toArray(),
      this.db.c.audit_events.find({ incident_id }).sort({ _id: 1 }).limit(500).toArray(),
    ]);
    return {
      incident_id,
      state: doc.state,
      incident: doc.incident,
      call_attempts: doc.call_attempts,
      next_call_at: doc.next_call_at,
      head,
      revisions,
      decisions,
      calls: calls.map(({ transcript, ...rest }) => ({ ...rest, transcript })),
      queries,
      audit: audit.map((a) => ({ id: a._id.toHexString(), type: a.type, actor: a.actor, data: a.data, at: a.at })),
    };
  }
}
