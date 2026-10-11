import { isDuplicateKey, type CallDoc, type Database } from '../db';
import { GatewayError, notFound } from '../domain/errors';
import type { EventLog } from '../domain/events';
import type { IncidentService } from '../domain/incidents';
import { CALLABLE_STATES } from '../domain/state';
import type { CallProvider } from './providers';

export interface CallPolicy {
  ringTimeoutMs: number;
  retryDelayMs: number;
  maxAttempts: number;
}

/**
 * Owns the call lifecycle. Guarantees: one active call per incident (partial unique index), bounded retries, and a call
 * that ends without a decision never implies one: the incident returns to AWAITING_DECISION.
 */
export class CallOrchestrator {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly incidents: IncidentService,
    private readonly provider: CallProvider,
    private readonly policy: CallPolicy,
  ) {}

  /** Periodic work: place due calls, expire unanswered rings. Safe to run concurrently with request handlers. */
  async tick(now = new Date()) {
    const due = await this.db.c.incidents.find({ state: 'CALL_PENDING', next_call_at: { $lte: now } }).project({ _id: 1 }).toArray();
    for (const d of due) await this.place(d._id).catch((err) => console.error('[calls] place failed', d._id, err));
    const expired = await this.db.c.calls.find({ status: 'RINGING', ring_deadline: { $lte: now } }).project({ _id: 1 }).toArray();
    for (const c of expired) await this.finishUnanswered(c._id, 'NO_ANSWER', 'ring timeout');
  }

  async place(incident_id: string): Promise<CallDoc | null> {
    const inc = await this.incidents.get(incident_id);
    if (inc.state !== 'CALL_PENDING') return null;
    if (inc.call_attempts >= this.policy.maxAttempts) {
      const ev = await this.incidents.transition(incident_id, 'UNREACHED', 'SYSTEM', { attempts: inc.call_attempts });
      if (ev) this.events.publish(ev);
      return null;
    }
    const now = new Date();
    const call: CallDoc = {
      _id: `call_${crypto.randomUUID()}`,
      incident_id,
      attempt: inc.call_attempts + 1,
      provider: this.provider.name,
      status: 'QUEUED',
      active: true,
      ring_deadline: null,
      conversation_id: null,
      identity_verified: false,
      answer_token: null,
      pin_failures: 0,
      end_reason: null,
      transcript: [],
      post_call: null,
      created_at: now,
      updated_at: now,
    };
    let audits;
    try {
      audits = await this.db.txn(async (session) => {
        await this.db.c.calls.insertOne(call, { session });
        const ev = await this.incidents.transition(incident_id, 'CALLING', 'SYSTEM', { call_id: call._id, attempt: call.attempt }, session, {
          call_attempts: call.attempt,
          next_call_at: null,
        });
        if (!ev) throw new GatewayError('ILLEGAL_STATE', 'Incident is no longer waiting for a call.', 409);
        return [ev];
      });
    } catch (err) {
      if (isDuplicateKey(err)) return null; // another worker already holds the active call
      if (err instanceof GatewayError && err.code === 'ILLEGAL_STATE') return null;
      throw err;
    }
    this.events.publish(...audits);

    try {
      const res = await this.provider.place(call, inc);
      if (res.status === 'RINGING') {
        const ring_deadline = new Date(Date.now() + this.policy.ringTimeoutMs);
        await this.db.c.calls.updateOne({ _id: call._id, status: 'QUEUED' }, { $set: { status: 'RINGING', ring_deadline, updated_at: new Date() } });
        await this.events.emit('call.ringing', incident_id, 'SYSTEM', {
          call_id: call._id,
          attempt: call.attempt,
          ring_deadline: ring_deadline.toISOString(),
          supervisor: inc.incident.responsible_supervisor.name,
          severity: inc.incident.severity,
          robot_id: inc.incident.robot_id,
          summary: inc.incident.failure_summary,
        });
      } else {
        await this.db.c.calls.updateOne({ _id: call._id }, { $set: { status: 'RINGING', updated_at: new Date() } });
        await this.answer(call._id);
        if (res.conversation_id) await this.connected(call._id, res.conversation_id);
      }
    } catch (err) {
      await this.finishUnanswered(call._id, 'FAILED', (err as Error).message);
    }
    return this.db.c.calls.findOne({ _id: call._id });
  }

  async answer(call_id: string, issueToken = false): Promise<CallDoc> {
    const call = await this.db.c.calls.findOneAndUpdate(
      { _id: call_id, status: 'RINGING' },
      { $set: { status: 'ANSWERED', ring_deadline: null, answer_token: issueToken ? crypto.randomUUID() : null, updated_at: new Date() } },
      { returnDocument: 'after' },
    );
    if (!call) {
      const cur = await this.db.c.calls.findOne({ _id: call_id });
      if (!cur) throw notFound('Call');
      throw new GatewayError('CALL_NOT_RINGING', `This call is ${cur.status}.`, 409);
    }
    const ev = await this.incidents.transition(call.incident_id, 'IN_CALL', 'SYSTEM', { call_id });
    if (ev) this.events.publish(ev);
    await this.events.emit('call.answered', call.incident_id, 'SYSTEM', { call_id });
    return call;
  }

  /** Binds the provider conversation id to the call (first binding wins; a different id later is rejected). */
  async connected(call_id: string, conversation_id: string): Promise<void> {
    const res = await this.db.c.calls.updateOne(
      { _id: call_id, status: 'ANSWERED', $or: [{ conversation_id: null }, { conversation_id }] },
      { $set: { conversation_id, updated_at: new Date() } },
    );
    if (res.matchedCount === 0) throw new GatewayError('CALL_BINDING', 'Call is not active or is bound to another conversation.', 409);
    await this.events.emit('call.connected', (await this.db.c.calls.findOne({ _id: call_id }))!.incident_id, 'SYSTEM', { call_id, conversation_id });
  }

  async decline(call_id: string) {
    await this.finishUnanswered(call_id, 'DECLINED', 'declined by human');
  }

  /**
   * End of an answered call (hang-up, drop, agent ended). If no decision was made the incident goes back to
   * AWAITING_DECISION; nothing is inferred from the call ending.
   */
  async end(call_id: string, reason: string): Promise<void> {
    const call = await this.db.c.calls.findOne({ _id: call_id });
    if (!call) throw notFound('Call');
    if (call.status === 'RINGING' || call.status === 'QUEUED') return this.finishUnanswered(call_id, 'DECLINED', reason);
    const updated = await this.db.c.calls.findOneAndUpdate(
      { _id: call_id, status: 'ANSWERED' },
      { $set: { status: 'ENDED', active: false, end_reason: reason, updated_at: new Date() } },
    );
    if (!updated) return; // already ended (idempotent)
    await this.events.emit('call.ended', call.incident_id, 'SYSTEM', { call_id, reason });
    const ev = await this.incidents.transition(call.incident_id, 'AWAITING_DECISION', 'SYSTEM', { call_id, reason: 'call ended without a final decision' });
    if (ev) this.events.publish(ev);
  }

  private async finishUnanswered(call_id: string, status: 'NO_ANSWER' | 'DECLINED' | 'FAILED', reason: string) {
    const call = await this.db.c.calls.findOneAndUpdate(
      { _id: call_id, status: { $in: ['QUEUED', 'RINGING'] } },
      { $set: { status, active: false, end_reason: reason, ring_deadline: null, updated_at: new Date() } },
    );
    if (!call) return;
    await this.events.emit(`call.${status.toLowerCase()}`, call.incident_id, 'SYSTEM', { call_id, reason });
    const inc = await this.incidents.get(call.incident_id);
    if (inc.state !== 'CALLING') return;
    const ev =
      inc.call_attempts < this.policy.maxAttempts
        ? await this.incidents.transition(call.incident_id, 'CALL_PENDING', 'SYSTEM', { retry_in_ms: this.policy.retryDelayMs }, undefined, {
            next_call_at: new Date(Date.now() + this.policy.retryDelayMs),
          })
        : await this.incidents.transition(call.incident_id, 'UNREACHED', 'SYSTEM', { attempts: inc.call_attempts });
    if (ev) this.events.publish(ev);
  }

  /** Human-requested redial from the dashboard: starts a fresh retry budget. */
  async redial(incident_id: string): Promise<void> {
    const inc = await this.incidents.get(incident_id);
    if (!CALLABLE_STATES.includes(inc.state)) throw new GatewayError('ILLEGAL_STATE', `Cannot call while the incident is ${inc.state}.`, 409);
    const active = await this.db.c.calls.findOne({ incident_id, active: true });
    if (active) throw new GatewayError('CALL_ACTIVE', 'A call for this incident is already in progress.', 409);
    const ev = await this.incidents.transition(incident_id, 'CALL_PENDING', 'DASHBOARD', { redial: true }, undefined, {
      call_attempts: 0,
      next_call_at: new Date(),
    });
    if (ev) this.events.publish(ev);
    await this.place(incident_id);
  }

  /** Rejects session-control requests from anyone but the party that answered (e.g. a second dashboard tab). */
  async assertAnsweredBy(call_id: string, token: string | undefined): Promise<void> {
    const call = await this.db.c.calls.findOne({ _id: call_id }, { projection: { answer_token: 1 } });
    if (!call) throw notFound('Call');
    if (call.answer_token && call.answer_token !== token) {
      throw new GatewayError('CALL_NOT_YOURS', 'This call was answered elsewhere; only the answering session can control it.', 409);
    }
  }

  async activeCallFor(call_id: string, incident_id: string): Promise<CallDoc> {
    const call = await this.db.c.calls.findOne({ _id: call_id, incident_id });
    if (!call) throw new GatewayError('CALL_BINDING', 'This call does not belong to this incident.', 403);
    if (call.status !== 'ANSWERED') throw new GatewayError('CALL_NOT_ACTIVE', `This call is ${call.status}.`, 409);
    return call;
  }
}
