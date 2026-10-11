// Source of truth for the ElevenLabs agent: one generic agent, ten webhook tools. Used by scripts/provision-agent.ts.
// Field names follow the @elevenlabs/elevenlabs-js 2.71 types (camelCase; the SDK serialises to the snake_case API).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SYSTEM_PROMPT = readFileSync(join(here, 'system-prompt.md'), 'utf8');
export const FIRST_MESSAGE =
  'Hi, this is the robotics harness gateway calling {{supervisor_name}} about a {{severity}} severity incident on {{robot_id}}. Before I share any details, please tell me your four-digit supervisor code.';

export const DYNAMIC_VARIABLE_PLACEHOLDERS = {
  incident_id: 'inc-placeholder',
  call_id: 'call-placeholder',
  supervisor_name: 'Robotics Lead',
  robot_id: 'AMR-00',
  severity: 'MEDIUM',
  category: 'unknown',
  one_line_summary: 'placeholder',
};

// A property is either LLM-filled (has a description) or platform-filled (has a dynamicVariable) — the API rejects both.
type Prop = { type: 'string' | 'number' | 'integer' | 'boolean'; description?: string; enum?: string[]; dynamicVariable?: string };

const bound: Record<string, Prop> = {
  incident_id: { type: 'string', dynamicVariable: 'incident_id' },
  call_id: { type: 'string', dynamicVariable: 'call_id' },
  conversation_id: { type: 'string', dynamicVariable: 'system__conversation_id' },
};

export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, Prop>;
  required: string[];
  timeoutSecs: number;
  preToolSpeech: 'auto' | 'force' | 'off';
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'verify_identity',
    description: 'Verify the human supervisor with their four-digit code. Must succeed before any incident details are shared.',
    params: { code: { type: 'string', description: 'The digits the human said, e.g. "2468".' } },
    required: ['code'],
    timeoutSecs: 10,
    preToolSpeech: 'off',
  },
  {
    name: 'get_incident',
    description: 'Get the full context of the incident this call is about: what happened, what was expected, the supervisor hypothesis, evidence and current proposal.',
    params: {},
    required: [],
    timeoutSecs: 10,
    preToolSpeech: 'auto',
  },
  {
    name: 'ask_supervisor',
    description:
      'Forward any technical question to the robotics supervisor agent (causes, timing, comparisons, alternatives, what-ifs, anything not already answered by a tool in this call). Returns the supervisor answer with evidence, or INSUFFICIENT_EVIDENCE, or PENDING with a query_id if analysis takes longer.',
    params: { question: { type: 'string', description: "The human's question, in their own words, with any needed context." } },
    required: ['question'],
    timeoutSecs: 15,
    preToolSpeech: 'force',
  },
  {
    name: 'get_supervisor_answer',
    description: 'Check whether a PENDING supervisor analysis has finished.',
    params: { query_id: { type: 'string', description: 'query_id returned by ask_supervisor.' } },
    required: ['query_id'],
    timeoutSecs: 10,
    preToolSpeech: 'auto',
  },
  {
    name: 'get_trajectory',
    description: 'Get the planned vs actual trajectory summary (segments, deviations with times and magnitudes) and highlight it on the human dashboard.',
    params: { segment: { type: 'string', description: 'Optional segment the human asked about, e.g. "lift lobby".' } },
    required: [],
    timeoutSecs: 10,
    preToolSpeech: 'auto',
  },
  {
    name: 'get_metrics',
    description: 'Get measured, expected and historical metrics with units, timestamps and sources.',
    params: { metric: { type: 'string', description: 'Optional comma-separated keywords, e.g. "cycle time, on-time". Omit for all metrics.' } },
    required: [],
    timeoutSecs: 10,
    preToolSpeech: 'auto',
  },
  {
    name: 'get_proposal',
    description: 'Get the authoritative latest proposal revision: changes, editable parameters with allowed ranges and units, justification, risk and approval requirements.',
    params: {},
    required: [],
    timeoutSecs: 10,
    preToolSpeech: 'auto',
  },
  {
    name: 'revise_proposal',
    description:
      'Ask the supervisor to create a new revision with a human-requested change. Either set one editable parameter (parameter_key + new_value + unit) or describe the change in change_request. Does not execute anything.',
    params: {
      base_revision: { type: 'integer', description: 'The revision number currently being discussed.' },
      parameter_key: { type: 'string', description: 'Key of an editable parameter from get_proposal.' },
      new_value: { type: 'string', description: 'New value as said by the human, e.g. "0.6".' },
      unit: { type: 'string', description: 'Unit the human used, e.g. "m".' },
      change_request: { type: 'string', description: 'Free-text change request, only if no single parameter fits.' },
      rationale: { type: 'string', description: "The human's reason for the change." },
    },
    required: ['base_revision', 'rationale'],
    timeoutSecs: 20,
    preToolSpeech: 'force',
  },
  {
    name: 'submit_decision',
    description:
      'Record the human decision on an exact proposal revision: APPROVE, REJECT, DEFER or REQUEST_MORE_INFORMATION. For APPROVE/REJECT the human must have explicitly said e.g. "I approve revision 2"; pass their exact words.',
    params: {
      revision: { type: 'integer', description: 'The exact revision number the human decided on.' },
      decision: { type: 'string', description: 'The decision.', enum: ['APPROVE', 'REJECT', 'DEFER', 'REQUEST_MORE_INFORMATION'] },
      confirmation_utterance: { type: 'string', description: "The human's exact confirming words." },
      reason: { type: 'string', description: 'Optional reason given by the human.' },
    },
    required: ['revision', 'decision'],
    timeoutSecs: 15,
    preToolSpeech: 'auto',
  },
  {
    name: 'get_execution_status',
    description: 'Get the authoritative execution state from the harness for the approved change. Only applied=true means the change was applied.',
    params: {},
    required: [],
    timeoutSecs: 10,
    preToolSpeech: 'auto',
  },
];

export function webhookToolConfig(t: ToolSpec, baseUrl: string, secretId: string) {
  const properties: Record<string, Prop> = { ...bound, ...t.params };
  return {
    type: 'webhook' as const,
    name: t.name,
    description: t.description,
    responseTimeoutSecs: t.timeoutSecs,
    preToolSpeech: t.preToolSpeech,
    apiSchema: {
      url: `${baseUrl.replace(/\/$/, '')}/v1/agent-tools/${t.name}`,
      method: 'POST' as const,
      requestHeaders: { authorization: { secretId } },
      requestBodySchema: {
        type: 'object' as const,
        description: `Arguments for ${t.name}`,
        required: ['incident_id', 'call_id', ...t.required],
        properties,
      },
    },
  };
}
