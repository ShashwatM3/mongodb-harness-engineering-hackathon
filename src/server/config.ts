import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(8787),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8787'),
  /** `memory` starts an in-process MongoDB replica set (non-durable, dev only). Use the Atlas URI for real runs. */
  MONGODB_URI: z.string().default('memory'),
  MONGODB_DB: z.string().default('intervention_gateway'),

  HARNESS_TOKEN: z.string().min(16).default('dev-harness-token-change-me'),
  TOOL_SECRET: z.string().min(16).default('dev-tool-secret-change-me'),
  /** Optional bearer token for /api (dashboard). Empty = open (demo only). */
  DASHBOARD_TOKEN: z.string().default(''),

  HARNESS_MODE: z.enum(['mock', 'http']).default('mock'),
  HARNESS_BASE_URL: z.string().default(''),
  HARNESS_OUTBOUND_TOKEN: z.string().default(''),
  HARNESS_TIMEOUT_MS: z.coerce.number().int().default(10_000),

  /** simulated = dashboard softphone; twilio = real phone call via ElevenLabs' Twilio integration; scripted = tests. */
  CALL_MODE: z.enum(['simulated', 'twilio', 'scripted']).default('simulated'),
  /** twilio = number imported via ElevenLabs' native Twilio integration; sip = imported "From SIP Trunk" (e.g. Telnyx). */
  PHONE_ROUTE: z.enum(['twilio', 'sip']).default('twilio'),
  /** ElevenLabs id of the imported phone number (`npm run phone:numbers`). */
  ELEVENLABS_PHONE_NUMBER_ID: z.string().default(''),
  /** E.164 number to call when the incident's supervisor has no allowed contact number. */
  SUPERVISOR_PHONE: z.string().default(''),
  /** Comma-separated E.164 allowlist; the gateway refuses to dial anything else. */
  CALL_ALLOWED_NUMBERS: z.string().default(''),
  CALL_RING_TIMEOUT_MS: z.coerce.number().int().default(45_000),
  CALL_RETRY_DELAY_MS: z.coerce.number().int().default(120_000),
  CALL_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(2),
  CALL_CONNECT_TIMEOUT_MS: z.coerce.number().int().default(90_000),

  SUPERVISOR_SYNC_BUDGET_MS: z.coerce.number().int().default(8_000),

  ELEVENLABS_API_KEY: z.string().default(''),
  ELEVENLABS_AGENT_ID: z.string().default(''),
  ELEVENLABS_WEBHOOK_SECRET: z.string().default(''),

  ANTHROPIC_API_KEY: z.string().default(''),
  MOCK_SUPERVISOR_MODEL: z.string().default('claude-opus-5-5'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const merged = { ...process.env, ...overrides };
  // Treat empty strings from .env as "unset" so defaults apply.
  for (const [k, v] of Object.entries(merged)) if (v === '') delete (merged as Record<string, unknown>)[k];
  return Env.parse(merged);
}
