import { describe, expect, it } from 'vitest';
import { validateChanges } from '../../src/server/domain/proposals';
import { canTransition, INCIDENT_TRANSITIONS } from '../../src/server/domain/state';
import { signElevenLabs, verifyElevenLabsSignature } from '../../src/server/routes/webhooks';
import { GatewayError } from '../../src/server/domain/errors';
import type { ParamSpec } from '../../src/shared/schemas';

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
  it('ends at the human decision; nothing leaves APPROVED or REJECTED', () => {
    expect(INCIDENT_TRANSITIONS.APPROVED).toEqual([]);
    expect(INCIDENT_TRANSITIONS.REJECTED).toEqual([]);
    expect(canTransition('IN_CALL', 'AWAITING_DECISION')).toBe(true);
    expect(canTransition('APPROVED', 'AWAITING_DECISION')).toBe(false);
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
