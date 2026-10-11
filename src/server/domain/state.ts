import type { IncidentState } from '../../shared/schemas';

/** Legal incident transitions. Anything not listed is rejected by `assertTransition`. */
export const INCIDENT_TRANSITIONS: Record<IncidentState, readonly IncidentState[]> = {
  RECEIVED: ['CALL_PENDING'],
  CALL_PENDING: ['CALLING', 'AWAITING_CONFIRMATION', 'SUBMITTED', 'CLOSED_REJECTED', 'DEFERRED'],
  CALLING: ['IN_CALL', 'CALL_PENDING', 'UNREACHED', 'AWAITING_CONFIRMATION', 'SUBMITTED', 'CLOSED_REJECTED', 'DEFERRED'],
  IN_CALL: ['AWAITING_DECISION', 'AWAITING_CONFIRMATION', 'SUBMITTED', 'CLOSED_REJECTED', 'DEFERRED'],
  AWAITING_DECISION: ['CALL_PENDING', 'CALLING', 'AWAITING_CONFIRMATION', 'SUBMITTED', 'CLOSED_REJECTED', 'DEFERRED'],
  AWAITING_CONFIRMATION: ['SUBMITTED', 'AWAITING_DECISION'],
  DEFERRED: ['CALL_PENDING', 'CALLING', 'AWAITING_CONFIRMATION', 'SUBMITTED', 'CLOSED_REJECTED'],
  UNREACHED: ['CALL_PENDING', 'CALLING', 'AWAITING_CONFIRMATION', 'SUBMITTED', 'CLOSED_REJECTED', 'DEFERRED'],
  SUBMITTED: ['EXECUTING', 'RESOLVED', 'EXECUTION_FAILED', 'HARNESS_REJECTED'],
  EXECUTING: ['RESOLVED', 'EXECUTION_FAILED', 'HARNESS_REJECTED'],
  RESOLVED: [],
  EXECUTION_FAILED: [],
  HARNESS_REJECTED: [],
  CLOSED_REJECTED: [],
};

/** States in which a human decision on the current proposal may be recorded. */
export const DECIDABLE_STATES: readonly IncidentState[] = [
  'CALL_PENDING',
  'CALLING',
  'IN_CALL',
  'AWAITING_DECISION',
  'DEFERRED',
  'UNREACHED',
];

/** States in which a call may be placed. */
export const CALLABLE_STATES: readonly IncidentState[] = ['CALL_PENDING', 'AWAITING_DECISION', 'DEFERRED', 'UNREACHED'];

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  return from === to || INCIDENT_TRANSITIONS[from].includes(to);
}

export function legalSourcesFor(to: IncidentState): IncidentState[] {
  return (Object.keys(INCIDENT_TRANSITIONS) as IncidentState[]).filter((from) => INCIDENT_TRANSITIONS[from].includes(to));
}
