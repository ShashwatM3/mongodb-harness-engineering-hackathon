// Creates or updates the ElevenLabs agent, its webhook tools and the tool-auth workspace secret from agent/.
// Idempotent: re-run after changing PUBLIC_BASE_URL (e.g. a new ngrok URL) or the prompt.
//   npm run provision:agent
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { FIRST_MESSAGE, IGNORE_AS_INTERRUPTION, OBSOLETE_TOOLS, SYSTEM_PROMPT, TOOLS, webhookToolConfig } from '../agent/agent-config';

const AGENT_NAME = 'Robotics Intervention Gateway';
const SECRET_NAME = 'intervention_gateway_tool_auth';

const env = (k: string, required = true) => {
  const v = process.env[k] ?? '';
  if (required && !v) throw new Error(`${k} is required`);
  return v;
};

const apiKey = env('ELEVENLABS_API_KEY');
const baseUrl = env('PUBLIC_BASE_URL');
const toolSecret = env('TOOL_SECRET');
const llm = process.env.ELEVENLABS_AGENT_LLM || 'claude-sonnet-5-5';
const existingAgent = env('ELEVENLABS_AGENT_ID', false);
if (!baseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be a public https URL (e.g. your ngrok URL) so ElevenLabs can reach the tools.');
if (toolSecret.startsWith('dev-')) console.warn('! TOOL_SECRET is the development default; set a random value in .env before exposing the gateway.');

const client = new ElevenLabsClient({ apiKey });

async function main() {
  // 1. Tool-auth secret (stored in the ElevenLabs workspace, referenced by id from tool headers).
  const secrets = await client.conversationalAi.secrets.list();
  const found = secrets.secrets.find((s) => s.name === SECRET_NAME);
  let secretId: string;
  if (found) {
    await client.conversationalAi.secrets.update(found.secretId, { name: SECRET_NAME, value: `Bearer ${toolSecret}` });
    secretId = found.secretId;
    console.log(`✓ updated secret ${SECRET_NAME}`);
  } else {
    secretId = (await client.conversationalAi.secrets.create({ name: SECRET_NAME, value: `Bearer ${toolSecret}` })).secretId;
    console.log(`✓ created secret ${SECRET_NAME}`);
  }

  // 2. Webhook tools (matched by name).
  const existing = (await client.conversationalAi.tools.list()).tools;
  const toolIds: string[] = [];
  for (const t of TOOLS) {
    const toolConfig = webhookToolConfig(t, baseUrl, secretId);
    const prior = existing.find((x) => (x.toolConfig as { name?: string }).name === t.name);
    const res = prior
      ? await client.conversationalAi.tools.update(prior.id, { toolConfig })
      : await client.conversationalAi.tools.create({ toolConfig });
    toolIds.push(res.id);
    console.log(`✓ ${prior ? 'updated' : 'created'} tool ${t.name} → ${toolConfig.apiSchema.url}`);
  }

  // 3. The agent: one generic configuration for every incident category.
  const conversationConfig = {
    agent: {
      firstMessage: FIRST_MESSAGE,
      language: 'en',
      prompt: {
        prompt: SYSTEM_PROMPT,
        llm,
        temperature: 0.2,
        toolIds,
        builtInTools: { endCall: { type: 'system' as const, name: 'end_call', description: 'End the call when the supervisor is done.', params: { systemToolType: 'end_call' as const } } },
      },
    },
    // Focus on the person on the call: wait for complete turns, don't let back-channel words or background speech
    // interrupt, and boost the decision vocabulary in speech recognition.
    turn: {
      turnEagerness: 'patient' as const,
      interruptionIgnoreTerms: IGNORE_AS_INTERRUPTION,
      softTimeoutConfig: { timeoutSeconds: 3, message: 'One moment, checking with the supervisor.' },
    },
    asr: { keywords: ['approve', 'reject', 'revision', 'trajectory', 'metres', 'newtons'] },
  };
  let agentId = existingAgent;
  if (agentId) {
    await client.conversationalAi.agents.update(agentId, { name: AGENT_NAME, conversationConfig: conversationConfig as never });
    console.log(`✓ updated agent ${agentId}`);
  } else {
    agentId = (await client.conversationalAi.agents.create({ name: AGENT_NAME, conversationConfig: conversationConfig as never })).agentId;
    console.log(`✓ created agent ${agentId}\n  → add ELEVENLABS_AGENT_ID=${agentId} to .env and restart the gateway`);
  }
  // 4. Remove tools from earlier versions (only after the agent no longer references them).
  for (const t of existing) {
    const name = (t.toolConfig as { name?: string }).name ?? '';
    if (OBSOLETE_TOOLS.includes(name)) {
      await client.conversationalAi.tools.delete(t.id).then(
        () => console.log(`✓ deleted obsolete tool ${name}`),
        (err: unknown) => console.warn(`! could not delete obsolete tool ${name}: ${(err as Error)?.message ?? String(err)}`),
      );
    }
  }
  console.log(`\nPost-call webhook (optional, manual): ElevenLabs dashboard → Agents → Settings → Webhooks → ${baseUrl}/v1/webhooks/elevenlabs ; copy the HMAC secret into ELEVENLABS_WEBHOOK_SECRET.`);
}

main().catch((err) => {
  console.error('✗ provisioning failed:', err?.body ?? err?.message ?? err);
  process.exit(1);
});
