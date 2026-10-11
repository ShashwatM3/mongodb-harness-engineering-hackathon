import type {
  Change,
  DecisionKind,
  ExecutionEvent,
  IncidentInput,
  Metric,
  ProposalContent,
  ReviseResult,
  SubmitDecisionResult,
  SupervisorAnswer,
  Trajectory,
} from '../../shared/schemas';

/**
 * The only way the gateway talks to the robotics harness. Voice tools, dashboard and workers depend on this interface,
 * never on a concrete harness. See docs/HARNESS_CONTRACT.md for the HTTP form of each method.
 *
 * Everything returned here is evidence-bearing *data*. The gateway never treats returned text as instructions.
 */
export interface HarnessAdapter {
  readonly name: string;

  /** Arbitrary technical question for the supervisor agent. May take a long time; callers apply their own budget. */
  askSupervisor(incident: IncidentInput, question: string, query_id: string): Promise<SupervisorAnswer>;

  getTrajectory(incident: IncidentInput): Promise<Trajectory | null>;

  getMetrics(incident: IncidentInput, keys?: string[]): Promise<Metric[]>;

  /**
   * Ask the supervisor to reconcile a human modification into a new proposal revision. The harness validates the change
   * against its own constraints and either returns the new proposal content or refuses with a reason.
   */
  reviseProposal(
    incident: IncidentInput,
    base: ProposalContent,
    changes: Change[],
    rationale: string,
    requested_by: string,
  ): Promise<ReviseResult>;

  /** Deliver a human decision. Must be idempotent on `idempotency_key`. Only APPROVE may start an execution. */
  submitDecision(incident: IncidentInput, decision: HarnessDecision): Promise<SubmitDecisionResult>;

  getExecutionStatus(incident: IncidentInput, execution_id: string): Promise<ExecutionEvent | null>;
}

export interface HarnessDecision {
  decision_id: string;
  idempotency_key: string;
  incident_id: string;
  proposal_id: string;
  revision: number;
  decision: DecisionKind;
  proposal: ProposalContent;
  supervisor_id: string;
  identity_method: string;
  channel: string;
  reason: string | null;
  decided_at: string;
}

/** Sink for execution events. The real harness POSTs to /v1/harness/events; the mock calls this in-process. */
export type ExecutionEventSink = (e: ExecutionEvent) => Promise<void>;
