import { TERMINAL_EXECUTION, type ExecutionEvent, type ExecutionStatus, type IncidentState } from '../../shared/schemas';
import type { Database } from '../db';
import { GatewayError } from './errors';
import type { EventLog } from './events';
import type { IncidentService } from './incidents';

const INCIDENT_STATE_FOR: Partial<Record<ExecutionStatus, IncidentState>> = {
  VALIDATING: 'EXECUTING',
  ACCEPTED: 'EXECUTING',
  QUEUED: 'EXECUTING',
  EXECUTING: 'EXECUTING',
  APPLIED: 'RESOLVED',
  FAILED: 'EXECUTION_FAILED',
  CANCELLED: 'EXECUTION_FAILED',
  REJECTED_BY_HARNESS: 'HARNESS_REJECTED',
};

export class ExecutionTracker {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly incidents: IncidentService,
  ) {}

  /**
   * Apply a harness execution event. Events are ordered by `seq`: stale or duplicate events are ignored, and a terminal
   * status never regresses. Only these events can move an incident to RESOLVED.
   */
  async ingest(e: ExecutionEvent): Promise<{ applied: boolean; reason?: string }> {
    const decision = await this.db.c.decisions.findOne({ _id: e.decision_id });
    if (!decision || decision.decision !== 'APPROVE') {
      throw new GatewayError('UNKNOWN_DECISION', `No approved decision ${e.decision_id}.`, 404);
    }
    if (decision.incident_id !== e.incident_id) {
      throw new GatewayError('INCIDENT_MISMATCH', 'Execution event does not belong to this incident.', 409);
    }
    const existing = await this.db.c.executions.findOne({ _id: e.execution_id });
    if (existing && existing.decision_id !== e.decision_id) {
      throw new GatewayError('INCIDENT_MISMATCH', 'Execution id is bound to a different decision.', 409);
    }
    if (!existing) {
      await this.db.c.executions.updateOne(
        { _id: e.execution_id },
        {
          $setOnInsert: {
            decision_id: e.decision_id,
            incident_id: e.incident_id,
            status: 'RECEIVED',
            seq: -1,
            detail: null,
            result_metrics: null,
            events: [],
            updated_at: new Date(),
          },
        },
        { upsert: true },
      );
    }

    const audits = await this.db.txn(async (session) => {
      const updated = await this.db.c.executions.findOneAndUpdate(
        { _id: e.execution_id, seq: { $lt: e.seq }, status: { $nin: [...TERMINAL_EXECUTION] } },
        {
          $set: { status: e.status, seq: e.seq, detail: e.detail ?? null, updated_at: new Date(), ...(e.result_metrics ? { result_metrics: e.result_metrics } : {}) },
          $push: { events: e },
        },
        { session, returnDocument: 'after' },
      );
      if (!updated) return null;
      const out = [
        await this.events.record(
          'execution.updated',
          e.incident_id,
          'HARNESS',
          { execution_id: e.execution_id, status: e.status, seq: e.seq, detail: e.detail ?? null },
          session,
        ),
      ];
      const target = INCIDENT_STATE_FOR[e.status];
      if (target) {
        const ev = await this.incidents.transition(e.incident_id, target, 'HARNESS', { execution_id: e.execution_id }, session);
        if (ev) out.push(ev);
      }
      return out;
    });
    if (!audits) return { applied: false, reason: 'stale, duplicate or after a terminal status' };
    this.events.publish(...audits);
    return { applied: true };
  }
}
