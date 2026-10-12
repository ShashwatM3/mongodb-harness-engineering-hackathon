import type { IncidentState } from '../../shared/schemas';

/**
 * Legal incident transitions. The gateway's job ends when the human's feedback is recorded and delivered to the
 * supervisor: APPROVED and REJECTED are terminal. Executing the change is the harness's business.
 */
export const INCIDENT_TRANSITIONS: Record<IncidentState, readonly IncidentState[]> = {
  CALL_PENDING: ['CALLING', 'APPROVED', 'REJECTED', 'DEFERRED'],
  CALLING: ['IN_CALL', 'CALL_PENDING', 'UNREACHED', 'APPROVED', 'REJECTED', 'DEFERRED'],
  IN_CALL: ['AWAITING_DECISION', 'APPROVED', 'REJECTED', 'DEFERRED'],
  AWAITING_DECISION: ['CALL_PENDING', 'CALLING', 'APPROVED', 'REJECTED', 'DEFERRED'],
  UNREACHED: ['CALL_PENDING', 'CALLING', 'APPROVED', 'REJECTED', 'DEFERRED'],
  DEFERRED: ['CALL_PENDING', 'CALLING', 'IN_CALL', 'AWAITING_DECISION', 'APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
};

/** States in which a human decision on the current proposal may be recorded. */
export const DECIDABLE_STATES: readonly IncidentState[] = ['CALL_PENDING', 'CALLING', 'IN_CALL', 'AWAITING_DECISION', 'UNREACHED', 'DEFERRED'];

/** States in which a call may be placed. */
export const CALLABLE_STATES: readonly IncidentState[] = ['CALL_PENDING', 'AWAITING_DECISION', 'DEFERRED', 'UNREACHED'];

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  return from === to || INCIDENT_TRANSITIONS[from].includes(to);
}

export function legalSourcesFor(to: IncidentState): IncidentState[] {
  return (Object.keys(INCIDENT_TRANSITIONS) as IncidentState[]).filter((from) => INCIDENT_TRANSITIONS[from].includes(to));
}
