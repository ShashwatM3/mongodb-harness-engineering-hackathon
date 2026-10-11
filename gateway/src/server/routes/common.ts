import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { GatewayError } from '../domain/errors';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/** Returns false (and sends 401) when the bearer token does not match. */
export function requireBearer(req: FastifyRequest, reply: FastifyReply, expected: string): boolean {
  if (expected && safeEqual(bearer(req), expected)) return true;
  void reply.code(401).send({ error_code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' });
  return false;
}

export function errorBody(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof GatewayError) return { status: err.httpStatus, body: { error_code: err.code, message: err.message, ...err.details } };
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: { error_code: 'INVALID_PAYLOAD', message: 'Payload failed validation.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    };
  }
  return { status: 500, body: { error_code: 'INTERNAL', message: 'Internal error.' } };
}
