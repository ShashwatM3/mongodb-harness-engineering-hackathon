import type { Change, IncidentInput, Metric, ParamSpec, ProposalContent, Trajectory } from '../shared/schemas';

export type { Change, Metric, ParamSpec, Trajectory };

export interface IncidentRow {
  incident_id: string;
  state: string;
  severity: string;
  category: string;
  robot_id: string;
  task_id: string;
  failure_summary: string;
  plain_summary: string;
  synthetic: boolean;
  latest_revision: number | null;
  head_state: string | null;
  call_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface Revision {
  _id: string;
  revision: number;
  status: string;
  source: string;
  requested_by: string;
  based_on_revision: number | null;
  request: { changes: Change[]; rationale: string } | null;
  content: ProposalContent;
  created_at: string;
}

export interface Decision {
  _id: string;
  revision: number;
  decision: 'APPROVE' | 'REJECT' | 'DEFER' | 'MODIFY';
  channel: string;
  feedback: string | null;
  submission: { state: string; attempts: number; last_error: string | null; harness_reason: string | null };
  created_at: string;
}

export interface Call {
  _id: string;
  provider?: string;
  attempt: number;
  status: string;
  conversation_id: string | null;
  end_reason: string | null;
  transcript: Array<{ role: string; text: string; at: string }>;
  post_call: Record<string, unknown> | null;
  created_at: string;
}

export interface Query {
  _id: string;
  channel: string;
  question: string;
  status: string;
  result: { answer?: string; limitations?: string; evidence_refs: string[]; confidence?: number } | null;
  created_at: string;
}

export interface Aggregate {
  incident_id: string;
  state: string;
  incident: IncidentInput;
  call_attempts: number;
  head: { latest_revision: number; state: string; decided_revision: number | null; decision: string | null } | null;
  revisions: Revision[];
  decisions: Decision[];
  calls: Call[];
  queries: Query[];
  audit: Array<{ id: string; type: string; actor: string; data: Record<string, unknown>; at: string }>;
}

export interface ServerEvent {
  id: string;
  type: string;
  incident_id: string | null;
  actor: string;
  data: Record<string, any>;
  at: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error_code ?? `HTTP_${res.status}`, json.message ?? res.statusText, json);
  return json as T;
}

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
