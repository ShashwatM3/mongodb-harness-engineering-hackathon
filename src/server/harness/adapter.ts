import type {
  Change,
  DecisionKind,
  FeedbackAck,
  IncidentInput,
  Metric,
  ProposalContent,
  ReviseResult,
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

  /**
   * Deliver the human's feedback on an exact proposal revision. This is the end of the gateway's job: what the harness
   * does with it (apply, re-plan, learn a preference) is the harness's business. Must be idempotent on `idempotency_key`.
   */
  submitFeedback(incident: IncidentInput, feedback: HumanFeedback): Promise<FeedbackAck>;
}

export interface HumanFeedback {
  feedback_id: string;
  idempotency_key: string;
  incident_id: string;
  proposal_id: string;
  revision: number;
  decision: DecisionKind;
  /** The exact proposal revision the human decided on. */
  proposal: ProposalContent;
  /** The human's own words. */
  feedback: string | null;
  supervisor_id: string;
  channel: string;
  decided_at: string;
}
