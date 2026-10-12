// Safe re-pointing of the EXISTING ElevenLabs agent's webhook tools after the tunnel URL or TOOL_SECRET changes.
// Unlike provision-agent.ts it never creates an agent and never touches the agent's prompt, first message, LLM,
// turn or ASR settings. It only: (1) upserts the workspace secret, (2) upserts the four webhook tools by name,
// (3) makes sure the agent's prompt.toolIds contains those four tool ids (everything else in the prompt is sent back as read).
//   npx tsx --env-file-if-exists=.env scripts/update-agent-tools.ts [--dry-run]
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { TOOLS, webhookToolConfig } from '../agent/agent-config';

const SECRET_NAME = 'intervention_gateway_tool_auth';
const dryRun = process.argv.includes('--dry-run');

const env = (k: string) => {
  const v = process.env[k] ?? '';
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const apiKey = env('ELEVENLABS_API_KEY');
const agentId = env('ELEVENLABS_AGENT_ID');
const baseUrl = env('PUBLIC_BASE_URL');
const toolSecret = env('TOOL_SECRET');
if (!baseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be https:// (the tunnel URL).');

const client = new ElevenLabsClient({ apiKey });

async function main() {
  // Read first so a dry run can show the current state.
  const agent = await client.conversationalAi.agents.get(agentId);
  const prompt = (agent.conversationConfig?.agent?.prompt ?? {}) as Record<string, unknown> & { toolIds?: string[] };
  console.log(`agent ${agentId} "${agent.name}" currently references toolIds=${JSON.stringify(prompt.toolIds ?? [])}`);

  const secrets = await client.conversationalAi.secrets.list();
  const found = secrets.secrets.find((s) => s.name === SECRET_NAME);
  let secretId = found?.secretId ?? '';
  if (dryRun) console.log(`[dry-run] would ${found ? 'update' : 'create'} secret ${SECRET_NAME}`);
  else if (found) {
    await client.conversationalAi.secrets.update(found.secretId, { name: SECRET_NAME, value: `Bearer ${toolSecret}` });
    console.log(`✓ updated secret ${SECRET_NAME}`);
  } else {
    secretId = (await client.conversationalAi.secrets.create({ name: SECRET_NAME, value: `Bearer ${toolSecret}` })).secretId;
    console.log(`✓ created secret ${SECRET_NAME}`);
  }

  const existing = (await client.conversationalAi.tools.list()).tools;
  const toolIds: string[] = [];
  for (const t of TOOLS) {
    const toolConfig = webhookToolConfig(t, baseUrl, secretId || '<new-secret-id>');
    const prior = existing.find((x) => (x.toolConfig as { name?: string }).name === t.name);
    if (dryRun) {
      console.log(`[dry-run] would ${prior ? `update tool ${prior.id}` : 'create tool'} ${t.name} → ${toolConfig.apiSchema.url}`);
      if (prior) toolIds.push(prior.id);
      continue;
    }
    const res = prior
      ? await client.conversationalAi.tools.update(prior.id, { toolConfig })
      : await client.conversationalAi.tools.create({ toolConfig });
    toolIds.push(res.id);
    console.log(`✓ ${prior ? 'updated' : 'created'} tool ${t.name} (${res.id}) → ${toolConfig.apiSchema.url}`);
  }

  // Keep any other tool ids the teammate attached; just make sure ours are present.
  const merged = Array.from(new Set([...(prompt.toolIds ?? []), ...toolIds]));
  const changed = merged.length !== (prompt.toolIds ?? []).length;
  if (!changed) return console.log('✓ agent already references all four tools; prompt untouched');
  if (dryRun) return console.log(`[dry-run] would set prompt.toolIds=${JSON.stringify(merged)} (prompt text, LLM, first message unchanged)`);
  // Send the prompt object back exactly as read, with only toolIds changed, so no prompt text or LLM setting is lost.
  await client.conversationalAi.agents.update(agentId, {
    conversationConfig: { agent: { prompt: { ...prompt, toolIds: merged } } } as never,
  });
  console.log(`✓ agent ${agentId} prompt.toolIds=${JSON.stringify(merged)} (prompt text unchanged)`);
}

main().catch((err) => {
  console.error('✗ update-agent-tools failed:', err?.body ?? err?.message ?? err);
  process.exit(1);
});
