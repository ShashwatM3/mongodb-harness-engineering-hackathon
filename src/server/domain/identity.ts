import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db';
import { GatewayError } from './errors';
import type { EventLog } from './events';

const MAX_PIN_FAILURES = 3;

const hash = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString('hex');

/**
 * Demo identity factor for voice: a per-supervisor 4–8 digit PIN, stored hashed. The verified flag lives on the call
 * document server-side; the LLM never holds a token. Known weakness (documented): the PIN passes through ASR, the LLM and
 * the transcript. Production should use a dashboard signature or a push/OTP factor instead.
 */
export class IdentityService {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
  ) {}

  async seed(spec: string): Promise<void> {
    for (const pair of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [id, pin] = pair.split(':');
      if (!id || !pin || !/^\d{4,8}$/.test(pin)) throw new Error(`Invalid SUPERVISOR_PINS entry "${pair}" (expected id:digits)`);
      const salt = randomBytes(16).toString('hex');
      await this.db.c.supervisors.updateOne({ _id: id }, { $set: { pin_salt: salt, pin_hash: hash(pin, salt) } }, { upsert: true });
    }
  }

  async verify(call_id: string, incident_id: string, supervisor_id: string, rawPin: string): Promise<{ verified: boolean; remaining: number }> {
    const call = await this.db.c.calls.findOne({ _id: call_id, incident_id });
    if (!call) throw new GatewayError('CALL_BINDING', 'Unknown call.', 403);
    if (call.identity_verified) return { verified: true, remaining: MAX_PIN_FAILURES - call.pin_failures };
    if (call.pin_failures >= MAX_PIN_FAILURES) {
      throw new GatewayError('IDENTITY_LOCKED', 'Too many incorrect codes. Identity verification is locked for this call; use the dashboard.', 403);
    }
    const sup = await this.db.c.supervisors.findOne({ _id: supervisor_id });
    if (!sup) throw new GatewayError('NOT_ENROLLED', 'The responsible supervisor has no voice code enrolled. Use the dashboard to decide.', 403);
    const pin = rawPin.replace(/\D/g, '');
    const ok = pin.length >= 4 && timingSafeEqual(Buffer.from(hash(pin, sup.pin_salt), 'hex'), Buffer.from(sup.pin_hash, 'hex'));
    if (ok) {
      await this.db.c.calls.updateOne({ _id: call_id }, { $set: { identity_verified: true } });
      await this.events.emit('identity.verified', incident_id, 'VOICE', { call_id, supervisor_id });
      return { verified: true, remaining: MAX_PIN_FAILURES - call.pin_failures };
    }
    const upd = await this.db.c.calls.findOneAndUpdate({ _id: call_id }, { $inc: { pin_failures: 1 } }, { returnDocument: 'after' });
    const remaining = Math.max(0, MAX_PIN_FAILURES - (upd?.pin_failures ?? MAX_PIN_FAILURES));
    await this.events.emit('identity.failed', incident_id, 'VOICE', { call_id, remaining });
    return { verified: false, remaining };
  }
}
