import { ReviseResult, type Change, type Channel, type ParamSpec, type ReviseRequest } from '../../shared/schemas';
import type { Database, ProposalHeadDoc, ProposalRevisionDoc } from '../db';
import type { HarnessAdapter } from '../harness/adapter';
import { GatewayError, notFound } from './errors';
import type { EventLog } from './events';
import { type IncidentService, revisionDocId } from './incidents';
import { DECIDABLE_STATES } from './state';
import { withTimeout } from './util';

export interface Requester {
  channel: Channel;
  supervisor_id: string;
  call_id: string | null;
  conversation_id: string | null;
}

const UNIT_ALIASES: Record<string, string> = {
  meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  second: 's', seconds: 's', sec: 's', secs: 's',
  millisecond: 'ms', milliseconds: 'ms',
  newton: 'n', newtons: 'n',
  'meters per second': 'm/s', 'metres per second': 'm/s', mps: 'm/s',
  percent: '%', pct: '%',
  degree: 'deg', degrees: 'deg', '°': 'deg',
  count: '', items: '', robots: '',
};
const normUnit = (u: string) => {
  const s = u.trim().toLowerCase();
  return UNIT_ALIASES[s] ?? s;
};

/**
 * Validates human-requested changes against the parameters the harness declared editable. Returns normalized changes.
 * Units are never converted silently: a mismatched unit is refused so the human confirms the value in the declared unit.
 */
export function validateChanges(changes: Change[], specs: ParamSpec[]): Change[] {
  return changes.map((ch) => {
    if (ch.op === 'request') return ch;
    const spec = specs.find((s) => s.key === ch.key);
    if (!spec) {
      const allowed = specs.map((s) => `${s.label} (${s.key})`).join(', ') || 'none';
      throw new GatewayError('UNKNOWN_PARAMETER', `"${ch.key}" is not an editable parameter. Editable parameters: ${allowed}.`, 422);
    }
    if (ch.unit !== undefined && ch.unit.trim() !== '' && normUnit(ch.unit) !== normUnit(spec.unit)) {
      throw new GatewayError(
        'UNIT_MISMATCH',
        `${spec.label} is set in ${spec.unit || 'no unit'}, but the request used ${ch.unit}. Confirm the value in ${spec.unit || 'the declared unit'}.`,
        422,
      );
    }
    let value: number | boolean | string = ch.value;
    if (spec.type === 'number' || spec.type === 'integer') {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) throw new GatewayError('INVALID_VALUE', `${spec.label} needs a number, got "${String(ch.value)}".`, 422);
      if (spec.type === 'integer' && !Number.isInteger(n)) throw new GatewayError('INVALID_VALUE', `${spec.label} must be a whole number.`, 422);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        throw new GatewayError(
          'OUT_OF_BOUNDS',
          `${spec.label} must be between ${spec.min ?? '-∞'} and ${spec.max ?? '∞'} ${spec.unit}; ${n} ${spec.unit} is outside the harness limits.`,
          422,
        );
      }
      value = n;
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') {
        const s = String(value).toLowerCase();
        if (!['true', 'false'].includes(s)) throw new GatewayError('INVALID_VALUE', `${spec.label} must be true or false.`, 422);
        value = s === 'true';
      }
    } else if (spec.type === 'enum') {
      if (!spec.enum_values?.includes(String(value))) {
        throw new GatewayError('INVALID_VALUE', `${spec.label} must be one of: ${(spec.enum_values ?? []).join(', ')}.`, 422);
      }
      value = String(value);
    }
    if (value === spec.proposed_value) {
      throw new GatewayError('NO_EFFECT', `${spec.label} is already proposed at ${String(value)} ${spec.unit}.`, 422);
    }
    return { op: 'set_param', key: spec.key, value, unit: spec.unit };
  });
}

export class ProposalEngine {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly incidents: IncidentService,
    private readonly harness: HarnessAdapter,
    private readonly harnessTimeoutMs: number,
  ) {}

  async current(incident_id: string): Promise<{ head: ProposalHeadDoc; revision: ProposalRevisionDoc }> {
    const inc = await this.incidents.get(incident_id);
    const head = await this.db.c.proposal_heads.findOne({ _id: inc.proposal_id });
    if (!head) throw notFound('Proposal');
    const revision = await this.db.c.proposal_revisions.findOne({ _id: revisionDocId(head._id, head.latest_revision) });
    if (!revision) throw notFound('Proposal revision');
    return { head, revision };
  }

  /**
   * Request a modification. The harness reconciles it into revision N+1 or refuses. No execution is triggered.
   * Concurrency: base_revision must equal the latest revision, and the head is locked (RECONCILING) during reconciliation.
   */
  async revise(incident_id: string, req: ReviseRequest, who: Requester) {
    const inc = await this.incidents.get(incident_id);
    if (!DECIDABLE_STATES.includes(inc.state)) {
      throw new GatewayError('ILLEGAL_STATE', `This incident is ${inc.state}; its proposal can no longer be modified.`, 409);
    }
    const { head, revision: latest } = await this.current(incident_id);

    if (req.base_revision !== head.latest_revision) {
      // A retried request that already succeeded is answered with the revision it created.
      const replay = await this.db.c.proposal_revisions.findOne({ _id: revisionDocId(head._id, req.base_revision + 1) });
      if (replay?.request && JSON.stringify(replay.request.changes) === JSON.stringify(normalizeForCompare(req.changes))) {
        return { accepted: true as const, replayed: true, revision: replay };
      }
      throw new GatewayError(
        'REVISION_CONFLICT',
        `Revision ${req.base_revision} is no longer current; revision ${head.latest_revision} is. Review revision ${head.latest_revision} first.`,
        409,
        { latest_revision: head.latest_revision },
      );
    }
    if (head.state === 'RECONCILING') {
      throw new GatewayError('RECONCILING', 'Another modification is being reconciled with the supervisor. Try again in a moment.', 409);
    }
    if (head.state === 'DECIDED') throw new GatewayError('ALREADY_DECIDED', `This proposal was already ${head.decision}.`, 409);

    const changes = validateChanges(req.changes, latest.content.editable_parameters);

    const locked = await this.db.c.proposal_heads.findOneAndUpdate(
      { _id: head._id, latest_revision: req.base_revision, state: 'UNDER_REVIEW' },
      { $set: { state: 'RECONCILING', reconciling_since: new Date() }, $inc: { version: 1 } },
    );
    if (!locked) {
      throw new GatewayError('REVISION_CONFLICT', 'The proposal changed while this modification was being submitted. Review the latest revision.', 409);
    }
    const actor = who.channel === 'VOICE' ? 'VOICE' : 'DASHBOARD';
    await this.events.emit('proposal.revision_requested', incident_id, actor, {
      base_revision: req.base_revision,
      changes,
      rationale: req.rationale,
    });

    let result: ReviseResult;
    try {
      const raw = await withTimeout(
        this.harness.reviseProposal(inc.incident, latest.content, changes, req.rationale, who.supervisor_id),
        this.harnessTimeoutMs,
        'harness reviseProposal',
      );
      result = ReviseResult.parse(raw);
    } catch (err) {
      result = { accepted: false, reason: `The supervisor could not be reached to reconcile the change (${(err as Error).message}).` };
    }

    if (!result.accepted) {
      await this.db.c.proposal_heads.updateOne({ _id: head._id, state: 'RECONCILING' }, { $set: { state: 'UNDER_REVIEW', reconciling_since: null } });
      await this.events.emit('proposal.revision_refused', incident_id, 'HARNESS', { base_revision: req.base_revision, reason: result.reason });
      return { accepted: false as const, reason: result.reason, latest_revision: req.base_revision };
    }

    const next = req.base_revision + 1;
    const now = new Date();
    const proposal = result.proposal;
    const doc: ProposalRevisionDoc = {
      _id: revisionDocId(head._id, next),
      incident_id,
      proposal_id: head._id,
      revision: next,
      based_on_revision: req.base_revision,
      source: who.channel === 'VOICE' ? 'HUMAN_VOICE' : 'HUMAN_DASHBOARD',
      requested_by: who.supervisor_id,
      request: { changes: normalizeForCompare(changes), rationale: req.rationale },
      status: 'PENDING_REVIEW',
      // The harness authors the content; identity fields are pinned by the gateway so a harness bug cannot cross-wire.
      content: { ...proposal, proposal_id: head._id, revision: next, created_at: now.toISOString() },
      created_at: now,
    };
    const audit = await this.db.txn(async (session) => {
      const moved = await this.db.c.proposal_heads.findOneAndUpdate(
        { _id: head._id, state: 'RECONCILING', latest_revision: req.base_revision },
        { $set: { state: 'UNDER_REVIEW', latest_revision: next, reconciling_since: null }, $inc: { version: 1 } },
        { session },
      );
      if (!moved) throw new GatewayError('REVISION_CONFLICT', 'The proposal head moved during reconciliation.', 409);
      await this.db.c.proposal_revisions.insertOne(doc, { session });
      await this.db.c.proposal_revisions.updateOne(
        { _id: revisionDocId(head._id, req.base_revision) },
        { $set: { status: 'SUPERSEDED' } },
        { session },
      );
      await this.db.c.decisions.insertOne(
        {
          _id: `dec_${crypto.randomUUID()}`,
          incident_id,
          proposal_id: head._id,
          revision: req.base_revision,
          decision: 'MODIFY',
          final: false,
          supervisor_id: who.supervisor_id,
          identity_method: who.channel === 'VOICE' ? 'VOICE_PIN' : 'DASHBOARD_SESSION',
          confirmation: { status: 'NOT_REQUIRED', utterance: null, confirmed_at: null },
          reason: req.rationale,
          requested_modifications: changes,
          channel: who.channel,
          call_id: who.call_id,
          conversation_id: who.conversation_id,
          idempotency_key: `modify:${head._id}:${req.base_revision}`,
          submission: emptySubmission('NOT_REQUIRED'),
          created_at: now,
        },
        { session },
      );
      return this.events.record(
        'proposal.revised',
        incident_id,
        actor,
        { revision: next, based_on_revision: req.base_revision, summary: proposal.summary, note: result.note ?? null },
        session,
      );
    });
    this.events.publish(audit);
    return { accepted: true as const, replayed: false, revision: doc };
  }

  /** Clears RECONCILING locks left behind by a crash mid-reconciliation. */
  async releaseStaleLocks(olderThanMs: number) {
    await this.db.c.proposal_heads.updateMany(
      { state: 'RECONCILING', reconciling_since: { $lt: new Date(Date.now() - olderThanMs) } },
      { $set: { state: 'UNDER_REVIEW', reconciling_since: null } },
    );
  }
}

function normalizeForCompare(changes: Change[]): Change[] {
  return changes.map((c) => (c.op === 'set_param' ? { op: 'set_param', key: c.key, value: Number.isFinite(Number(c.value)) && typeof c.value !== 'boolean' ? Number(c.value) : c.value } : { op: 'request', text: c.text.trim() }));
}

export function emptySubmission(state: 'NOT_REQUIRED' | 'HELD' | 'PENDING') {
  return {
    state,
    attempts: 0,
    next_attempt_at: state === 'PENDING' ? new Date() : null,
    lease_until: null,
    last_error: null,
    execution_id: null,
    harness_reason: null,
  };
}
