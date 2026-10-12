import { EventEmitter } from 'node:events';
import type { ClientSession } from 'mongodb';
import { ObjectId, type AuditEventDoc, type Database } from '../db';

export type Actor = AuditEventDoc['actor'];

export interface PublishedEvent {
  id: string;
  type: string;
  incident_id: string | null;
  actor: Actor;
  data: Record<string, unknown>;
  at: string;
}

/**
 * Durable audit log + in-process fan-out. Every state change writes an audit event (inside the same transaction when there
 * is one) and is published to SSE subscribers only after the write commits. The audit collection doubles as the SSE replay
 * log (ObjectId order). Single-process assumption: multi-instance deployments would feed the bus from a change stream.
 */
export class EventLog {
  private readonly bus = new EventEmitter();

  constructor(private readonly db: Database) {
    this.bus.setMaxListeners(1000);
  }

  /** Writes the audit event. Pass the returned doc to `publish` after commit. */
  async record(
    type: string,
    incident_id: string | null,
    actor: Actor,
    data: Record<string, unknown> = {},
    session?: ClientSession,
  ): Promise<AuditEventDoc> {
    const doc: AuditEventDoc = { _id: new ObjectId(), type, incident_id, actor, data, at: new Date() };
    await this.db.c.audit_events.insertOne(doc, { session });
    return doc;
  }

  publish(...docs: AuditEventDoc[]): void {
    for (const d of docs) this.bus.emit('event', toPublished(d));
  }

  /** Record and publish immediately (non-transactional writes). */
  async emit(type: string, incident_id: string | null, actor: Actor, data: Record<string, unknown> = {}): Promise<void> {
    this.publish(await this.record(type, incident_id, actor, data));
  }

  /** Ephemeral UI signal that is not part of the audit trail (e.g. "highlight this trajectory segment"). */
  signal(type: string, incident_id: string | null, data: Record<string, unknown>): void {
    this.bus.emit('event', { id: '', type, incident_id, actor: 'SYSTEM', data, at: new Date().toISOString() } satisfies PublishedEvent);
  }

  subscribe(fn: (e: PublishedEvent) => void): () => void {
    this.bus.on('event', fn);
    return () => this.bus.off('event', fn);
  }

  async since(lastId: string | null, limit = 500): Promise<PublishedEvent[]> {
    if (!lastId || !ObjectId.isValid(lastId)) return [];
    const docs = await this.db.c.audit_events
      .find({ _id: { $gt: new ObjectId(lastId) } })
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    return docs.map(toPublished);
  }
}

export function toPublished(d: AuditEventDoc): PublishedEvent {
  return { id: d._id.toHexString(), type: d.type, incident_id: d.incident_id, actor: d.actor, data: d.data, at: d.at.toISOString() };
}
