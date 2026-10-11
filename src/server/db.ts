import { MongoClient, type ClientSession, type Collection, type Db, ObjectId } from 'mongodb';
import type {
  CallStatus,
  Change,
  Channel,
  DecisionKind,
  ExecutionEvent,
  ExecutionStatus,
  HeadState,
  IncidentInput,
  IncidentState,
  ProposalContent,
  RevisionSource,
  RevisionStatus,
  SubmissionState,
  SupervisorAnswer,
} from '../shared/schemas';

export interface IncidentDoc {
  _id: string; // incident_id
  event_id: string;
  /** Immutable payload exactly as received from the harness. */
  incident: IncidentInput;
  state: IncidentState;
  proposal_id: string;
  call_attempts: number;
  next_call_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProposalHeadDoc {
  _id: string; // proposal_id
  incident_id: string;
  latest_revision: number;
  state: HeadState;
  decided_revision: number | null;
  decision: DecisionKind | null;
  reconciling_since: Date | null;
  version: number;
}

export interface ProposalRevisionDoc {
  _id: string; // `${proposal_id}#${revision}`
  incident_id: string;
  proposal_id: string;
  revision: number;
  based_on_revision: number | null;
  source: RevisionSource;
  requested_by: string;
  request: { changes: Change[]; rationale: string } | null;
  status: RevisionStatus;
  content: ProposalContent;
  created_at: Date;
}

export interface DecisionDoc {
  _id: string; // decision_id
  incident_id: string;
  proposal_id: string;
  revision: number;
  decision: DecisionKind;
  /** APPROVE and REJECT are final for a proposal: guarded by a partial unique index. */
  final: boolean;
  supervisor_id: string;
  identity_method: 'VOICE_PIN' | 'DASHBOARD_SESSION';
  confirmation: { status: 'CONFIRMED' | 'PENDING_SECOND_FACTOR' | 'NOT_REQUIRED'; utterance: string | null; confirmed_at: Date | null };
  reason: string | null;
  requested_modifications: Change[] | null;
  channel: Channel;
  call_id: string | null;
  conversation_id: string | null;
  idempotency_key: string;
  submission: {
    state: SubmissionState;
    attempts: number;
    next_attempt_at: Date | null;
    lease_until: Date | null;
    last_error: string | null;
    execution_id: string | null;
    harness_reason: string | null;
  };
  created_at: Date;
}

export interface CallDoc {
  _id: string; // call_id
  incident_id: string;
  attempt: number;
  provider: string;
  status: CallStatus;
  /** true while QUEUED/RINGING/ANSWERED — a partial unique index allows one active call per incident. */
  active: boolean;
  ring_deadline: Date | null;
  conversation_id: string | null;
  identity_verified: boolean;
  /** Issued to whoever answered the simulated call; only its holder may end it or bind/annotate the session. */
  answer_token: string | null;
  pin_failures: number;
  end_reason: string | null;
  transcript: Array<{ role: string; text: string; at: Date }>;
  post_call: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface ExecutionDoc {
  _id: string; // execution_id
  decision_id: string;
  incident_id: string;
  status: ExecutionStatus;
  seq: number;
  detail: string | null;
  result_metrics: ExecutionEvent['result_metrics'] | null;
  events: ExecutionEvent[];
  updated_at: Date;
}

export interface SupervisorQueryDoc {
  _id: string;
  incident_id: string;
  call_id: string | null;
  channel: Channel;
  question: string;
  normalized: string;
  status: SupervisorAnswer['status'];
  result: SupervisorAnswer | null;
  created_at: Date;
  answered_at: Date | null;
}

export interface AuditEventDoc {
  _id: ObjectId;
  type: string;
  incident_id: string | null;
  actor: 'HARNESS' | 'VOICE' | 'DASHBOARD' | 'SYSTEM' | 'ELEVENLABS';
  data: Record<string, unknown>;
  at: Date;
}

export interface SupervisorDoc {
  _id: string;
  pin_hash: string;
  pin_salt: string;
}

export interface WebhookReceiptDoc {
  _id: string;
  received_at: Date;
}

export interface Collections {
  incidents: Collection<IncidentDoc>;
  proposal_heads: Collection<ProposalHeadDoc>;
  proposal_revisions: Collection<ProposalRevisionDoc>;
  decisions: Collection<DecisionDoc>;
  calls: Collection<CallDoc>;
  executions: Collection<ExecutionDoc>;
  supervisor_queries: Collection<SupervisorQueryDoc>;
  audit_events: Collection<AuditEventDoc>;
  supervisors: Collection<SupervisorDoc>;
  webhook_receipts: Collection<WebhookReceiptDoc>;
}

export interface Database {
  client: MongoClient;
  db: Db;
  c: Collections;
  /** Runs fn inside a transaction with automatic retry of transient errors. */
  txn<T>(fn: (session: ClientSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function connectDatabase(uri: string, dbName: string): Promise<Database> {
  let stopMemory: (() => Promise<unknown>) | null = null;
  if (uri === 'memory') {
    // Dev convenience only: a throwaway replica set (transactions need one). Nothing persists across restarts.
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = rs.getUri();
    stopMemory = () => rs.stop();
  }
  const client = await MongoClient.connect(uri, { appName: 'intervention-gateway' });
  const db = client.db(dbName);
  const c: Collections = {
    incidents: db.collection('incidents'),
    proposal_heads: db.collection('proposal_heads'),
    proposal_revisions: db.collection('proposal_revisions'),
    decisions: db.collection('decisions'),
    calls: db.collection('calls'),
    executions: db.collection('executions'),
    supervisor_queries: db.collection('supervisor_queries'),
    audit_events: db.collection('audit_events'),
    supervisors: db.collection('supervisors'),
    webhook_receipts: db.collection('webhook_receipts'),
  };
  await ensureIndexes(c);
  return {
    client,
    db,
    c,
    async txn(fn) {
      const session = client.startSession();
      try {
        return await session.withTransaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } finally {
        await session.endSession();
      }
    },
    async close() {
      await client.close();
      if (stopMemory) await stopMemory();
    },
  };
}

async function ensureIndexes(c: Collections): Promise<void> {
  await Promise.all([
    c.incidents.createIndex({ event_id: 1 }, { unique: true }),
    c.incidents.createIndex({ state: 1, next_call_at: 1 }),
    c.proposal_revisions.createIndex({ proposal_id: 1, revision: 1 }, { unique: true }),
    c.decisions.createIndex({ idempotency_key: 1 }, { unique: true }),
    // At most one final (APPROVE/REJECT) decision per proposal: blocks double approval structurally.
    c.decisions.createIndex({ proposal_id: 1 }, { unique: true, partialFilterExpression: { final: true }, name: 'one_final_decision' }),
    c.decisions.createIndex({ 'submission.state': 1, 'submission.next_attempt_at': 1 }),
    // At most one active call per incident: blocks simultaneous duplicate calls structurally.
    c.calls.createIndex({ incident_id: 1 }, { unique: true, partialFilterExpression: { active: true }, name: 'one_active_call' }),
    c.calls.createIndex({ conversation_id: 1 }, { unique: true, partialFilterExpression: { conversation_id: { $type: 'string' } } }),
    c.calls.createIndex({ status: 1, ring_deadline: 1 }),
    c.executions.createIndex({ decision_id: 1 }),
    c.supervisor_queries.createIndex({ incident_id: 1, normalized: 1, created_at: -1 }),
    c.audit_events.createIndex({ incident_id: 1, _id: 1 }),
  ]);
}

export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export { ObjectId };
