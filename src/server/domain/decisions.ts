import type { DecisionRequest, IncidentState } from '../../shared/schemas';
import { SubmitDecisionResult } from '../../shared/schemas';
import { isDuplicateKey, type Database, type DecisionDoc } from '../db';
import type { HarnessAdapter } from '../harness/adapter';
import { GatewayError, notFound } from './errors';
import type { EventLog } from './events';
import { type IncidentService, revisionDocId } from './incidents';
import { emptySubmission, type Requester } from './proposals';
import { DECIDABLE_STATES } from './state';
import { confirmationMatches, withTimeout } from './util';

export interface DecideInput extends DecisionRequest {
  /** Required for voice APPROVE/REJECT: the human's own words, which must name the decision and revision. */
  confirmation_utterance?: string;
}

const MAX_SUBMIT_ATTEMPTS = 3;
const LEASE_MS = 30_000;

export class DecisionService {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly incidents: IncidentService,
    private readonly onQueued: () => void,
  ) {}

  /**
   * Record a human decision against an exact proposal revision. Persisted before anything is reported or sent.
   * Stale, unknown, duplicate and conflicting decisions are refused; replays with the same idempotency key return the
   * original decision.
   */
  async decide(incident_id: string, input: DecideInput, who: Requester): Promise<{ decision: DecisionDoc; replayed: boolean }> {
    const prior = await this.db.c.decisions.findOne({ idempotency_key: input.idempotency_key });
    if (prior) return this.replay(prior, incident_id, input);

    const inc = await this.incidents.get(incident_id);
    const head = await this.db.c.proposal_heads.findOne({ _id: inc.proposal_id });
    if (!head) throw notFound('Proposal');

    if (input.revision > head.latest_revision) {
      throw new GatewayError('UNKNOWN_REVISION', `Revision ${input.revision} does not exist. The current revision is ${head.latest_revision}.`, 409, {
        latest_revision: head.latest_revision,
      });
    }
    if (input.revision < head.latest_revision) {
      throw new GatewayError(
        'STALE_REVISION',
        `Revision ${input.revision} is outdated; revision ${head.latest_revision} is current. Review revision ${head.latest_revision} before deciding.`,
        409,
        { latest_revision: head.latest_revision },
      );
    }
    if (head.state === 'DECIDED') {
      throw new GatewayError('ALREADY_DECIDED', `Revision ${head.decided_revision} was already ${head.decision === 'APPROVE' ? 'approved' : 'rejected'}.`, 409);
    }
    if (head.state === 'RECONCILING') {
      throw new GatewayError('RECONCILING', 'A modification is being reconciled with the supervisor; wait for the new revision.', 409);
    }
    if (!DECIDABLE_STATES.includes(inc.state)) {
      throw new GatewayError('ILLEGAL_STATE', `This incident is ${inc.state}; no decision can be recorded now.`, 409);
    }

    const rev = await this.db.c.proposal_revisions.findOne({ _id: revisionDocId(head._id, input.revision) });
    if (!rev) throw notFound('Proposal revision');

    const final = input.decision === 'APPROVE' || input.decision === 'REJECT';
    if (who.channel === 'VOICE' && final) {
      const u = input.confirmation_utterance ?? '';
      if (!confirmationMatches(u, input.decision as 'APPROVE' | 'REJECT', input.revision)) {
        throw new GatewayError(
          'CONFIRMATION_REQUIRED',
          `An explicit confirmation is required. Ask the supervisor to say "${input.decision === 'APPROVE' ? 'I approve' : 'I reject'} revision ${input.revision}".`,
          422,
        );
      }
    }

    // HIGH-risk approvals by voice are held until a second factor is given on the dashboard.
    const needsSecondFactor = input.decision === 'APPROVE' && who.channel === 'VOICE' && rev.content.risk === 'HIGH';
    const nextState: IncidentState | null =
      input.decision === 'APPROVE'
        ? needsSecondFactor
          ? 'AWAITING_CONFIRMATION'
          : 'SUBMITTED'
        : input.decision === 'REJECT'
          ? 'CLOSED_REJECTED'
          : input.decision === 'DEFER'
            ? 'DEFERRED'
            : null;

    const now = new Date();
    const doc: DecisionDoc = {
      _id: `dec_${crypto.randomUUID()}`,
      incident_id,
      proposal_id: head._id,
      revision: input.revision,
      decision: input.decision,
      final,
      supervisor_id: who.supervisor_id,
      identity_method: who.channel === 'VOICE' ? 'VOICE_PIN' : 'DASHBOARD_SESSION',
      confirmation: {
        status: needsSecondFactor ? 'PENDING_SECOND_FACTOR' : final ? 'CONFIRMED' : 'NOT_REQUIRED',
        utterance: input.confirmation_utterance ?? null,
        confirmed_at: needsSecondFactor ? null : now,
      },
      reason: input.reason ?? null,
      requested_modifications: null,
      channel: who.channel,
      call_id: who.call_id,
      conversation_id: who.conversation_id,
      idempotency_key: input.idempotency_key,
      submission: emptySubmission(needsSecondFactor ? 'HELD' : 'PENDING'),
      created_at: now,
    };

    try {
      const audits = await this.db.txn(async (session) => {
        // Compare-and-set on the head: the revision must still be the latest and still under review at commit time.
        const headUpdate = final
          ? { $set: { state: 'DECIDED' as const, decided_revision: input.revision, decision: input.decision }, $inc: { version: 1 } }
          : { $inc: { version: 1 } };
        const ok = await this.db.c.proposal_heads.findOneAndUpdate(
          { _id: head._id, latest_revision: input.revision, state: 'UNDER_REVIEW' },
          headUpdate,
          { session },
        );
        if (!ok) throw new GatewayError('STALE_REVISION', 'The proposal changed while the decision was being recorded. Review the latest revision.', 409);
        if (final) {
          await this.db.c.proposal_revisions.updateOne(
            { _id: rev._id },
            { $set: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' } },
            { session },
          );
        }
        await this.db.c.decisions.insertOne(doc, { session });
        const out = [];
        if (nextState) {
          const ev = await this.incidents.transition(incident_id, nextState, who.channel, { decision: input.decision, revision: input.revision }, session);
          if (!ev) throw new GatewayError('ILLEGAL_STATE', 'The incident changed state while the decision was being recorded.', 409);
          out.push(ev);
        }
        out.push(
          await this.events.record(
            'decision.recorded',
            incident_id,
            who.channel,
            { decision_id: doc._id, decision: input.decision, revision: input.revision, second_factor_pending: needsSecondFactor },
            session,
          ),
        );
        return out;
      });
      this.events.publish(...audits);
    } catch (err) {
      if (isDuplicateKey(err)) {
        const again = await this.db.c.decisions.findOne({ idempotency_key: input.idempotency_key });
        if (again) return this.replay(again, incident_id, input);
        throw new GatewayError('ALREADY_DECIDED', 'A final decision was already recorded for this proposal.', 409);
      }
      throw err;
    }
    if (doc.submission.state === 'PENDING') this.onQueued();
    return { decision: doc, replayed: false };
  }

  private replay(prior: DecisionDoc, incident_id: string, input: DecideInput) {
    if (prior.incident_id !== incident_id || prior.revision !== input.revision || prior.decision !== input.decision) {
      throw new GatewayError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different decision.', 409);
    }
    return { decision: prior, replayed: true };
  }

  /** Second factor for HIGH-risk voice approvals, given on the dashboard. */
  async confirm(decision_id: string, actorSupervisor: string) {
    const audits = await this.db.txn(async (session) => {
      const d = await this.db.c.decisions.findOneAndUpdate(
        { _id: decision_id, 'confirmation.status': 'PENDING_SECOND_FACTOR', 'submission.state': 'HELD' },
        {
          $set: {
            'confirmation.status': 'CONFIRMED',
            'confirmation.confirmed_at': new Date(),
            'submission.state': 'PENDING',
            'submission.next_attempt_at': new Date(),
          },
        },
        { session, returnDocument: 'after' },
      );
      if (!d) throw new GatewayError('NOT_CONFIRMABLE', 'This decision is not waiting for confirmation.', 409);
      const ev = await this.incidents.transition(d.incident_id, 'SUBMITTED', 'DASHBOARD', { decision_id }, session);
      if (!ev) throw new GatewayError('ILLEGAL_STATE', 'The incident is not awaiting confirmation.', 409);
      return [ev, await this.events.record('decision.confirmed', d.incident_id, 'DASHBOARD', { decision_id, by: actorSupervisor }, session)];
    });
    this.events.publish(...audits);
    this.onQueued();
  }
}

/**
 * Transactional outbox for harness submissions. A decision is claimed with a lease, sent with its idempotency key, and
 * retried with bounded backoff. The harness must dedupe on the key, so a crash after send cannot double-execute.
 */
export class DecisionDispatcher {
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly incidents: IncidentService,
    private readonly harness: HarnessAdapter,
    private readonly timeoutMs: number,
  ) {}

  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      for (;;) {
        const claimed = await this.db.c.decisions.findOneAndUpdate(
          {
            $or: [
              { 'submission.state': 'PENDING', 'submission.next_attempt_at': { $lte: now } },
              { 'submission.state': 'SENDING', 'submission.lease_until': { $lte: now } },
            ],
          },
          { $set: { 'submission.state': 'SENDING', 'submission.lease_until': new Date(now.getTime() + LEASE_MS) }, $inc: { 'submission.attempts': 1 } },
          { returnDocument: 'after', sort: { created_at: 1 } },
        );
        if (!claimed) break;
        await this.deliver(claimed);
        sent++;
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  private async deliver(d: DecisionDoc) {
    const inc = await this.incidents.get(d.incident_id);
    const rev = await this.db.c.proposal_revisions.findOne({ _id: revisionDocId(d.proposal_id, d.revision) });
    if (!rev) throw notFound('Proposal revision');
    let result: SubmitDecisionResult;
    try {
      result = SubmitDecisionResult.parse(
        await withTimeout(
          this.harness.submitDecision(inc.incident, {
            decision_id: d._id,
            idempotency_key: d.idempotency_key,
            incident_id: d.incident_id,
            proposal_id: d.proposal_id,
            revision: d.revision,
            decision: d.decision,
            proposal: rev.content,
            supervisor_id: d.supervisor_id,
            identity_method: d.identity_method,
            channel: d.channel,
            reason: d.reason,
            decided_at: d.created_at.toISOString(),
          }),
          this.timeoutMs,
          'harness submitDecision',
        ),
      );
    } catch (err) {
      const msg = (err as Error).message;
      const giveUp = d.submission.attempts >= MAX_SUBMIT_ATTEMPTS;
      const backoff = 1000 * 4 ** (d.submission.attempts - 1);
      await this.db.c.decisions.updateOne(
        { _id: d._id, 'submission.state': 'SENDING' },
        {
          $set: {
            'submission.state': giveUp ? 'FAILED' : 'PENDING',
            'submission.last_error': msg,
            'submission.next_attempt_at': giveUp ? null : new Date(Date.now() + backoff),
            'submission.lease_until': null,
          },
        },
      );
      await this.events.emit(giveUp ? 'decision.delivery_failed' : 'decision.delivery_retry', d.incident_id, 'SYSTEM', {
        decision_id: d._id,
        attempts: d.submission.attempts,
        error: msg,
      });
      return;
    }

    const audits = await this.db.txn(async (session) => {
      await this.db.c.decisions.updateOne(
        { _id: d._id },
        {
          $set: {
            'submission.state': 'ACKED',
            'submission.execution_id': result.execution_id ?? null,
            'submission.harness_reason': result.reason ?? null,
            'submission.lease_until': null,
            'submission.last_error': null,
          },
        },
        { session },
      );
      const out = [
        await this.events.record(
          'decision.delivered',
          d.incident_id,
          'HARNESS',
          { decision_id: d._id, decision: d.decision, accepted: result.accepted, execution_id: result.execution_id ?? null, reason: result.reason ?? null },
          session,
        ),
      ];
      if (d.decision === 'APPROVE') {
        if (!result.accepted) {
          const ev = await this.incidents.transition(d.incident_id, 'HARNESS_REJECTED', 'HARNESS', { reason: result.reason ?? 'refused at intake' }, session);
          if (ev) out.push(ev);
        } else if (result.execution_id) {
          await this.db.c.executions.updateOne(
            { _id: result.execution_id },
            {
              $setOnInsert: {
                decision_id: d._id,
                incident_id: d.incident_id,
                status: result.status ?? 'RECEIVED',
                seq: -1,
                detail: null,
                result_metrics: null,
                events: [],
                updated_at: new Date(),
              },
            },
            { upsert: true, session },
          );
        }
      }
      return out;
    });
    this.events.publish(...audits);
  }
}
