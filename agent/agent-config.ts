// Source of truth for the ElevenLabs agent: one generic agent, four webhook tools. Used by scripts/provision-agent.ts.
// Field names follow the @elevenlabs/elevenlabs-js 2.71 types (camelCase; the SDK serialises to the snake_case API).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SYSTEM_PROMPT = readFileSync(join(here, 'system-prompt.md'), 'utf8');

/** The whole opening: incident in 1–2 sentences, plan in 1–2 sentences, then hand over to the human. */
export const FIRST_MESSAGE = 'Hi {{supervisor_name}}, this is the fleet supervisor. {{incident_brief}} The proposed fix: {{proposal_brief}} Do you want to approve it, change it, or ask me anything?';

/** Tool names from earlier versions; provisioning deletes them so the workspace stays clean. */
export const OBSOLETE_TOOLS = ['verify_identity', 'get_incident', 'get_supervisor_answer', 'get_trajectory', 'get_metrics', 'get_proposal', 'revise_proposal', 'submit_decision', 'get_execution_status'];

/** Short acknowledgements that must not count as an interruption (they are often background or back-channel speech). */
export const IGNORE_AS_INTERRUPTION = ['uh huh', 'mm hmm', 'hmm', 'um', 'uh', 'right', 'got it'];

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
    name: 'ask_supervisor',
    description: 'Ask the robot supervisor AI a question whose answer is not in your incident context (causes, comparisons, what-ifs, anything else).',
    params: { question: { type: 'string', description: "The human's question in their own words, with any context needed." } },
    required: ['question'],
    timeoutSecs: 15,
    preToolSpeech: 'force',
  },
  {
    name: 'show_trajectory',
    description: "Show the robot's planned and actual path on the human's dashboard.",
    params: { segment: { type: 'string', description: 'Optional part of the path they asked about, e.g. "lift lobby".' } },
    required: [],
    timeoutSecs: 10,
    preToolSpeech: 'off',
  },
  {
    name: 'change_plan',
    description: 'Change one setting of the proposed fix to a new value the human asked for. The supervisor checks it and returns the new plan and revision number.',
    params: {
      parameter_key: { type: 'string', description: 'The setting key from the incident context (the [key ...] value).' },
      new_value: { type: 'string', description: 'The new value, e.g. "0.6".' },
      unit: { type: 'string', description: 'The unit the human used, e.g. "m".' },
      reason: { type: 'string', description: "The human's reason, if they gave one." },
    },
    required: ['parameter_key', 'new_value'],
    timeoutSecs: 20,
    preToolSpeech: 'force',
  },
  {
    name: 'send_feedback',
    description: "Send the human's decision and feedback on the plan back to the supervisor. Call as soon as they approve, reject, or say not now.",
    params: {
      revision: { type: 'integer', description: 'The current revision number of the plan they are deciding on.' },
      decision: { type: 'string', description: 'APPROVE, REJECT, or DEFER (wait / not now).', enum: ['APPROVE', 'REJECT', 'DEFER'] },
      feedback: { type: 'string', description: "The human's feedback in their own words: reasons, conditions, instructions for the supervisor." },
    },
    required: ['revision', 'decision'],
    timeoutSecs: 15,
    preToolSpeech: 'off',
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
    // Background speech must not cut a tool call short.
    interruptionMode: 'disable_during_tool' as const,
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
