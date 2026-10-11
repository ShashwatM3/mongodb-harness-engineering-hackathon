import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isDuplicateKey } from '../db';
import type { Gateway } from '../gateway';
import { safeEqual } from './common';

const TOLERANCE_S = 30 * 60;

/**
 * Verifies `ElevenLabs-Signature: t=<unix>,v0=<hex>` where v0 = HMAC-SHA256(secret, `${t}.${rawBody}`) — the scheme used by
 * the official SDK's constructEvent (checked in @elevenlabs/elevenlabs-js 2.71). Returns false on any mismatch.
 */
export function verifyElevenLabsSignature(raw: string, header: string | undefined, secret: string, nowS = Date.now() / 1000): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',');
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const v0 = parts.find((p) => p.startsWith('v0='));
  if (!t || !v0 || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowS - Number(t)) > TOLERANCE_S) return false;
  const expected = 'v0=' + createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return safeEqual(v0, expected);
}

export function signElevenLabs(raw: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}

/** Post-call webhooks. Enrich the call record; never change decisions. Redeliveries are deduplicated. */
export function registerWebhookRoutes(app: FastifyInstance, gw: Gateway) {
  app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    scope.post('/v1/webhooks/elevenlabs', async (req, reply) => {
      const secret = gw.config.ELEVENLABS_WEBHOOK_SECRET;
      if (!secret) return reply.code(503).send({ error_code: 'NOT_CONFIGURED', message: 'ELEVENLABS_WEBHOOK_SECRET is not set.' });
      const raw = req.body as string;
      if (!verifyElevenLabsSignature(raw, req.headers['elevenlabs-signature'] as string | undefined, secret)) {
        return reply.code(401).send({ error_code: 'BAD_SIGNATURE', message: 'Invalid webhook signature.' });
      }
      const evt = JSON.parse(raw) as { type?: string; data?: Record<string, any> };
      const type = String(evt.type ?? 'unknown');
      const data = evt.data ?? {};
      const conversation_id = String(data.conversation_id ?? '');
      try {
        await gw.db.c.webhook_receipts.insertOne({ _id: `${type}:${conversation_id}`, received_at: new Date() });
      } catch (err) {
        if (isDuplicateKey(err)) return { ok: true, duplicate: true };
        throw err;
      }
      const call = conversation_id ? await gw.db.c.calls.findOne({ conversation_id }) : null;
      if (!call) {
        await gw.events.emit('webhook.unmatched', null, 'ELEVENLABS', { type, conversation_id });
        return { ok: true, matched: false };
      }
      if (type === 'post_call_transcription') {
        const post_call = {
          status: data.status ?? null,
          termination_reason: data.metadata?.termination_reason ?? null,
          call_duration_secs: data.metadata?.call_duration_secs ?? null,
          transcript_summary: data.analysis?.transcript_summary ?? null,
          data_collection_results: data.analysis?.data_collection_results ?? null,
          transcript: Array.isArray(data.transcript)
            ? data.transcript.map((t: any) => ({ role: t.role, message: t.message, tool_calls: t.tool_calls?.map((c: any) => c.tool_name) ?? [] }))
            : null,
        };
        await gw.db.c.calls.updateOne({ _id: call._id }, { $set: { post_call } });
        await gw.events.emit('call.post_call_received', call.incident_id, 'ELEVENLABS', {
          call_id: call._id,
          termination_reason: post_call.termination_reason,
          note: 'Post-call analysis is informational only; it never records or changes a decision.',
        });
        if (call.status === 'ANSWERED') await gw.calls.end(call._id, `provider: ${post_call.termination_reason ?? 'ended'}`);
      } else if (type === 'call_initiation_failure') {
        await gw.calls.end(call._id, `initiation failure: ${data.failure_reason ?? 'unknown'}`);
      } else {
        await gw.events.emit('webhook.ignored', call.incident_id, 'ELEVENLABS', { type });
      }
      return { ok: true };
    });
  });
}
