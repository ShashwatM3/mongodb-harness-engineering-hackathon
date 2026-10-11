import { describe, expect, it } from 'vitest';
import { validateChanges } from '../../src/server/domain/proposals';
import { canTransition, INCIDENT_TRANSITIONS } from '../../src/server/domain/state';
import { confirmationMatches } from '../../src/server/domain/util';
import { signElevenLabs, verifyElevenLabsSignature } from '../../src/server/routes/webhooks';
import { GatewayError } from '../../src/server/domain/errors';
import type { ParamSpec } from '../../src/shared/schemas';

describe('confirmationMatches', () => {
  it.each([
    ['I approve revision 2', 'APPROVE', 2, true],
    ['yes, approve revision two', 'APPROVE', 2, true],
    ['I approve revision 1', 'APPROVE', 2, false],
    ['yes', 'APPROVE', 2, false],
    ['sounds good, go ahead', 'APPROVE', 2, false],
    ["I don't approve revision 2", 'APPROVE', 2, false],
    ['reject revision 3', 'REJECT', 3, true],
    ['approve revision 3', 'REJECT', 3, false],
  ] as const)('%s → %s rev %d = %s', (u, d, r, expected) => {
    expect(confirmationMatches(u, d, r)).toBe(expected);
  });
});

describe('validateChanges', () => {
  const specs: ParamSpec[] = [
    { key: 'r', label: 'Radius', unit: 'm', type: 'number', min: 0.3, max: 0.9, current_value: 0.45, proposed_value: 0.65 },
    { key: 'n', label: 'Batch', unit: 'robots', type: 'integer', min: 1, max: 4, current_value: 1, proposed_value: 2 },
  ];
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'OK';
    } catch (e) {
      return (e as GatewayError).code;
    }
  };
  it('accepts in-bounds values and normalises strings and unit aliases', () => {
    expect(validateChanges([{ op: 'set_param', key: 'r', value: '0.6', unit: 'metres' }], specs)).toEqual([{ op: 'set_param', key: 'r', value: 0.6, unit: 'm' }]);
  });
  it('refuses unknown, out-of-bounds, wrong-unit, non-integer and no-op changes', () => {
    expect(code(() => validateChanges([{ op: 'set_param', key: 'x', value: 1 }], specs))).toBe('UNKNOWN_PARAMETER');
    expect(code(() => validateChanges([{ op: 'set_param', key: 'r', value: 1.2 }], specs))).toBe('OUT_OF_BOUNDS');
    expect(code(() => validateChanges([{ op: 'set_param', key: 'r', value: 60, unit: 'cm' }], specs))).toBe('UNIT_MISMATCH');
    expect(code(() => validateChanges([{ op: 'set_param', key: 'n', value: 2.5 }], specs))).toBe('INVALID_VALUE');
    expect(code(() => validateChanges([{ op: 'set_param', key: 'r', value: 0.65 }], specs))).toBe('NO_EFFECT');
    expect(code(() => validateChanges([{ op: 'set_param', key: 'r', value: 'abc' }], specs))).toBe('INVALID_VALUE');
  });
  it('passes free-text requests through for the harness to interpret', () => {
    expect(validateChanges([{ op: 'request', text: 'avoid the doorway' }], specs)).toEqual([{ op: 'request', text: 'avoid the doorway' }]);
  });
});

describe('incident state machine', () => {
  it('has no way out of terminal states and no path from approval back to undecided', () => {
    for (const t of ['RESOLVED', 'EXECUTION_FAILED', 'HARNESS_REJECTED', 'CLOSED_REJECTED'] as const) expect(INCIDENT_TRANSITIONS[t]).toEqual([]);
    expect(canTransition('SUBMITTED', 'AWAITING_DECISION')).toBe(false);
    expect(canTransition('IN_CALL', 'RESOLVED')).toBe(false); // only harness events resolve, via SUBMITTED/EXECUTING
    expect(canTransition('IN_CALL', 'AWAITING_DECISION')).toBe(true);
  });
});

describe('ElevenLabs webhook signature', () => {
  const body = '{"type":"post_call_transcription"}';
  it('accepts a valid signature and rejects tampering, wrong secret and stale timestamps', () => {
    const sig = signElevenLabs(body, 's3cret');
    expect(verifyElevenLabsSignature(body, sig, 's3cret')).toBe(true);
    expect(verifyElevenLabsSignature(body + ' ', sig, 's3cret')).toBe(false);
    expect(verifyElevenLabsSignature(body, sig, 'other')).toBe(false);
    const old = signElevenLabs(body, 's3cret', Math.floor(Date.now() / 1000) - 3600);
    expect(verifyElevenLabsSignature(body, old, 's3cret')).toBe(false);
    expect(verifyElevenLabsSignature(body, undefined, 's3cret')).toBe(false);
  });
});
