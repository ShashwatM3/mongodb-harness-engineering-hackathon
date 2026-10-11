import { FeedbackAck, type DecisionRequest, type IncidentState } from '../../shared/schemas';
import { isDuplicateKey, type Database, type DecisionDoc } from '../db';
import type { HarnessAdapter } from '../harness/adapter';
import { GatewayError, notFound } from './errors';
import type { EventLog } from './events';
import { type IncidentService, revisionDocId } from './incidents';
import { emptySubmission, type Requester } from './proposals';
import { DECIDABLE_STATES } from './state';
import { withTimeout } from './util';

const MAX_SUBMIT_ATTEMPTS = 3;
const LEASE_MS = 30_000;
const NEXT_STATE: Record<DecisionRequest['decision'], IncidentState> = { APPROVE: 'APPROVED', REJECT: 'REJECTED', DEFER: 'DEFERRED' };

export class DecisionService {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly incidents: IncidentService,
    private readonly onQueued: () => void,
  ) {}

  /**
   * Record the human's decision + feedback against an exact proposal revision, then queue it for delivery to the
   * supervisor. A stale revision is refused (the human must hear the latest one); a retry with the same idempotency key
   * returns the original record.
   */
  async decide(incident_id: string, input: DecisionRequest, who: Requester): Promise<{ decision: DecisionDoc; replayed: boolean }> {
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
      const latest = await this.db.c.proposal_revisions.findOne({ _id: revisionDocId(head._id, head.latest_revision) });
      throw new GatewayError(
        'STALE_REVISION',
        `The plan changed since revision ${input.revision}. It is now: ${latest?.content.plain_summary ?? latest?.content.summary ?? ''} Check with the human before deciding.`,
        409,
        { latest_revision: head.latest_revision },
      );
    }
    if (head.state === 'DECIDED') throw new GatewayError('ALREADY_DECIDED', `This plan was already ${head.decision === 'APPROVE' ? 'approved' : 'rejected'}.`, 409);
    if (head.state === 'RECONCILING') throw new GatewayError('RECONCILING', 'A change is still being worked out with the supervisor. Try again in a moment.', 409);
    if (!DECIDABLE_STATES.includes(inc.state)) throw new GatewayError('ILLEGAL_STATE', `This incident is already ${inc.state.toLowerCase()}.`, 409);

    const final = input.decision !== 'DEFER';
    const now = new Date();
    const doc: DecisionDoc = {
      _id: `fb_${crypto.randomUUID()}`,
      incident_id,
      proposal_id: head._id,
      revision: input.revision,
      decision: input.decision,
      final,
      supervisor_id: who.supervisor_id,
      feedback: input.feedback?.trim() || null,
      requested_modifications: null,
      channel: who.channel,
      call_id: who.call_id,
      conversation_id: who.conversation_id,
      idempotency_key: input.idempotency_key,
      submission: emptySubmission('PENDING'),
      created_at: now,
    };

    try {
      const audits = await this.db.txn(async (session) => {
        // Compare-and-set: the revision must still be the latest and under review at commit time.
        const ok = await this.db.c.proposal_heads.findOneAndUpdate(
          { _id: head._id, latest_revision: input.revision, state: 'UNDER_REVIEW' },
          final ? { $set: { state: 'DECIDED' as const, decided_revision: input.revision, decision: input.decision }, $inc: { version: 1 } } : { $inc: { version: 1 } },
          { session },
        );
        if (!ok) throw new GatewayError('STALE_REVISION', 'The plan changed while the decision was being recorded. Check the latest version.', 409);
        if (final) {
          await this.db.c.proposal_revisions.updateOne({ _id: revisionDocId(head._id, input.revision) }, { $set: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' } }, { session });
        }
        await this.db.c.decisions.insertOne(doc, { session });
        const ev = await this.incidents.transition(incident_id, NEXT_STATE[input.decision], who.channel, { decision: input.decision, revision: input.revision }, session);
        if (!ev) throw new GatewayError('ILLEGAL_STATE', 'The incident changed state while the decision was being recorded.', 409);
        return [
          ev,
          await this.events.record('feedback.recorded', incident_id, who.channel, { feedback_id: doc._id, decision: input.decision, revision: input.revision, feedback: doc.feedback }, session),
        ];
      });
      this.events.publish(...audits);
    } catch (err) {
      if (isDuplicateKey(err)) {
        const again = await this.db.c.decisions.findOne({ idempotency_key: input.idempotency_key });
        if (again) return this.replay(again, incident_id, input);
        throw new GatewayError('ALREADY_DECIDED', 'A final decision was already recorded for this plan.', 409);
      }
      throw err;
    }
    this.onQueued();
    return { decision: doc, replayed: false };
  }

  private replay(prior: DecisionDoc, incident_id: string, input: DecisionRequest) {
    if (prior.incident_id !== incident_id || prior.revision !== input.revision || prior.decision !== input.decision) {
      throw new GatewayError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different decision.', 409);
    }
    return { decision: prior, replayed: true };
  }
}

/**
 * Transactional outbox: delivers each feedback record to the supervisor exactly once (lease + idempotency key + bounded
 * retries). The harness must dedupe on the key, so a crash after send cannot duplicate feedback.
 */
export class FeedbackDispatcher {
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
    try {
      const ack = FeedbackAck.parse(
        await withTimeout(
          this.harness.submitFeedback(inc.incident, {
            feedback_id: d._id,
            idempotency_key: d.idempotency_key,
            incident_id: d.incident_id,
            proposal_id: d.proposal_id,
            revision: d.revision,
            decision: d.decision,
            proposal: rev.content,
            feedback: d.feedback,
            supervisor_id: d.supervisor_id,
            channel: d.channel,
            decided_at: d.created_at.toISOString(),
          }),
          this.timeoutMs,
          'harness submitFeedback',
        ),
      );
      await this.db.c.decisions.updateOne(
        { _id: d._id },
        { $set: { 'submission.state': 'ACKED', 'submission.harness_reason': ack.reason ?? null, 'submission.lease_until': null, 'submission.last_error': null } },
      );
      await this.events.emit('feedback.delivered', d.incident_id, 'HARNESS', { feedback_id: d._id, decision: d.decision, accepted: ack.accepted, reason: ack.reason ?? null });
    } catch (err) {
      const msg = (err as Error).message;
      const giveUp = d.submission.attempts >= MAX_SUBMIT_ATTEMPTS;
      await this.db.c.decisions.updateOne(
        { _id: d._id, 'submission.state': 'SENDING' },
        {
          $set: {
            'submission.state': giveUp ? 'FAILED' : 'PENDING',
            'submission.last_error': msg,
            'submission.next_attempt_at': giveUp ? null : new Date(Date.now() + 1000 * 4 ** (d.submission.attempts - 1)),
            'submission.lease_until': null,
          },
        },
      );
      await this.events.emit(giveUp ? 'feedback.delivery_failed' : 'feedback.delivery_retry', d.incident_id, 'SYSTEM', { feedback_id: d._id, attempts: d.submission.attempts, error: msg });
    }
  }
}
