// Versioned, runtime-validated contracts shared by the gateway server, the harness adapter and the dashboard.
// Every external payload is parsed with one of these schemas at the boundary.
import { z } from 'zod';

export const SCHEMA_VERSION = '1' as const;

const Id = z.string().min(1).max(200);
const IsoTime = z.string().datetime({ offset: true });

export const Severity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type Severity = z.infer<typeof Severity>;

/** How much a value can be trusted. Rendered as a badge in the UI and spoken by the agent. */
export const ValueKind = z.enum(['MEASURED', 'EXPECTED', 'ESTIMATE', 'HYPOTHESIS']);
export type ValueKind = z.infer<typeof ValueKind>;

export const Risk = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type Risk = z.infer<typeof Risk>;

export const Scalar = z.union([z.number(), z.boolean(), z.string()]);
export type Scalar = z.infer<typeof Scalar>;

export const EvidenceRef = z.object({
  id: Id,
  kind: ValueKind,
  summary: z.string().min(1).max(2000),
  source: z.string().min(1),
  timestamp: IsoTime,
  uri: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** A parameter the harness allows a human to change, with the bounds the harness will accept. */
export const ParamSpec = z.object({
  key: z.string().min(1).max(200),
  label: z.string().min(1),
  unit: z.string(),
  type: z.enum(['number', 'integer', 'boolean', 'enum']),
  min: z.number().optional(),
  max: z.number().optional(),
  enum_values: z.array(z.string()).optional(),
  current_value: Scalar,
  proposed_value: Scalar,
});
export type ParamSpec = z.infer<typeof ParamSpec>;

/** Allowlisted change operations. `request` is passed to the harness for interpretation and is never executed by the gateway. */
export const Change = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_param'), key: z.string().min(1), value: Scalar, unit: z.string().optional() }),
  z.object({ op: z.literal('request'), text: z.string().min(3).max(2000) }),
]);
export type Change = z.infer<typeof Change>;

/** A proposal revision as authored by the harness supervisor. */
export const ProposalContent = z.object({
  proposal_id: Id,
  revision: z.number().int().min(1),
  source_agent: z.string().min(1),
  summary: z.string().min(1).max(2000),
  changes: z.array(Change),
  editable_parameters: z.array(ParamSpec),
  affected_resources: z.array(z.string()).default([]),
  justification: z.string().min(1).max(4000),
  constraints: z.array(z.string()).default([]),
  risk: Risk,
  created_at: IsoTime,
});
export type ProposalContent = z.infer<typeof ProposalContent>;

export const IncidentInput = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  event_id: Id,
  incident_id: Id,
  task_id: Id,
  robot_id: Id,
  timestamp: IsoTime,
  severity: Severity,
  /** Open set: new categories are data, not code. */
  category: z.string().min(1).max(80),
  observed_behavior: z.string().min(1).max(4000),
  expected_behavior: z.string().min(1).max(4000),
  failure_summary: z.string().min(1).max(4000),
  root_cause_hypothesis: z.object({ text: z.string().min(1).max(4000), confidence: z.number().min(0).max(1).optional() }),
  evidence_refs: z.array(EvidenceRef).default([]),
  metrics_refs: z.array(z.string()).default([]),
  proposal: ProposalContent,
  responsible_supervisor: z.object({ id: Id, name: z.string().min(1), contact: z.string().optional() }),
  escalation: z.object({ reason: z.string().min(1), requires_authority: z.boolean().default(false) }),
  synthetic: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type IncidentInput = z.infer<typeof IncidentInput>;

// ---------- Gateway-owned state ----------

export const IncidentState = z.enum([
  'RECEIVED',
  'CALL_PENDING',
  'CALLING',
  'IN_CALL',
  'AWAITING_DECISION',
  'AWAITING_CONFIRMATION',
  'DEFERRED',
  'UNREACHED',
  'SUBMITTED',
  'EXECUTING',
  'RESOLVED',
  'EXECUTION_FAILED',
  'HARNESS_REJECTED',
  'CLOSED_REJECTED',
]);
export type IncidentState = z.infer<typeof IncidentState>;

export const RevisionStatus = z.enum(['PENDING_REVIEW', 'SUPERSEDED', 'APPROVED', 'REJECTED']);
export type RevisionStatus = z.infer<typeof RevisionStatus>;

export const RevisionSource = z.enum(['SUPERVISOR', 'HUMAN_VOICE', 'HUMAN_DASHBOARD']);
export type RevisionSource = z.infer<typeof RevisionSource>;

export const HeadState = z.enum(['UNDER_REVIEW', 'RECONCILING', 'DECIDED']);
export type HeadState = z.infer<typeof HeadState>;

export const DecisionKind = z.enum(['APPROVE', 'REJECT', 'MODIFY', 'DEFER', 'REQUEST_MORE_INFORMATION']);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const Channel = z.enum(['VOICE', 'DASHBOARD']);
export type Channel = z.infer<typeof Channel>;

export const SubmissionState = z.enum(['NOT_REQUIRED', 'HELD', 'PENDING', 'SENDING', 'ACKED', 'FAILED']);
export type SubmissionState = z.infer<typeof SubmissionState>;

export const ExecutionStatus = z.enum([
  'RECEIVED',
  'VALIDATING',
  'ACCEPTED',
  'REJECTED_BY_HARNESS',
  'QUEUED',
  'EXECUTING',
  'APPLIED',
  'FAILED',
  'CANCELLED',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;
export const TERMINAL_EXECUTION: ReadonlySet<ExecutionStatus> = new Set(['APPLIED', 'FAILED', 'CANCELLED', 'REJECTED_BY_HARNESS']);

export const CallStatus = z.enum(['QUEUED', 'RINGING', 'ANSWERED', 'ENDED', 'NO_ANSWER', 'DECLINED', 'FAILED']);
export type CallStatus = z.infer<typeof CallStatus>;

// ---------- Harness data (evidence, telemetry) ----------

export const Metric = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: Scalar.nullable(),
  unit: z.string(),
  kind: ValueKind,
  timestamp: IsoTime,
  source: z.string().min(1),
  expected: Scalar.optional(),
  history: z.array(z.object({ label: z.string(), value: z.number(), timestamp: IsoTime })).optional(),
  note: z.string().optional(),
});
export type Metric = z.infer<typeof Metric>;

const Point = z.object({ t: z.number(), x: z.number(), y: z.number() });
export const Trajectory = z.object({
  task_id: Id,
  robot_id: Id,
  frame: z.string().default('map_2d'),
  units: z.string().default('m'),
  planned: z.array(Point),
  actual: z.array(Point),
  deviations: z.array(
    z.object({ t: z.number(), x: z.number(), y: z.number(), magnitude_m: z.number(), description: z.string(), kind: ValueKind }),
  ),
  segments: z.array(z.object({ id: z.string(), label: z.string(), t_start: z.number(), t_end: z.number() })).default([]),
  zones: z
    .array(z.object({ label: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), kind: z.string().default('area') }))
    .default([]),
  viewer_url: z.string().optional(),
  source: z.string(),
  synthetic: z.boolean().default(false),
});
export type Trajectory = z.infer<typeof Trajectory>;

export const SupervisorAnswerStatus = z.enum(['ANSWERED', 'INSUFFICIENT_EVIDENCE', 'PENDING', 'UNAVAILABLE']);
export const SupervisorAnswer = z.object({
  status: SupervisorAnswerStatus,
  answer: z.string().optional(),
  evidence_refs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
  limitations: z.string().optional(),
});
export type SupervisorAnswer = z.infer<typeof SupervisorAnswer>;

export const ReviseResult = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), proposal: ProposalContent, note: z.string().optional() }),
  z.object({ accepted: z.literal(false), reason: z.string().min(1) }),
]);
export type ReviseResult = z.infer<typeof ReviseResult>;

export const SubmitDecisionResult = z.object({
  accepted: z.boolean(),
  execution_id: z.string().optional(),
  status: ExecutionStatus.optional(),
  reason: z.string().optional(),
});
export type SubmitDecisionResult = z.infer<typeof SubmitDecisionResult>;

/** Execution event posted by the harness (or emitted by the mock). `seq` is monotonic per execution. */
export const ExecutionEvent = z.object({
  execution_id: Id,
  decision_id: Id,
  incident_id: Id,
  seq: z.number().int().min(0),
  status: ExecutionStatus,
  detail: z.string().max(4000).optional(),
  result_metrics: z.array(Metric).optional(),
  timestamp: IsoTime,
});
export type ExecutionEvent = z.infer<typeof ExecutionEvent>;

// ---------- Dashboard request bodies ----------

export const ReviseRequest = z.object({
  base_revision: z.number().int().min(1),
  changes: z.array(Change).min(1).max(20),
  rationale: z.string().min(1).max(2000),
});
export type ReviseRequest = z.infer<typeof ReviseRequest>;

export const DecisionRequest = z.object({
  revision: z.number().int().min(1),
  decision: z.enum(['APPROVE', 'REJECT', 'DEFER', 'REQUEST_MORE_INFORMATION']),
  reason: z.string().max(2000).optional(),
  idempotency_key: z.string().min(8).max(200),
});
export type DecisionRequest = z.infer<typeof DecisionRequest>;
