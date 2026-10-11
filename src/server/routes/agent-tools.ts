import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CallDoc, IncidentDoc } from '../db';
import type { Requester } from '../domain/proposals';
import type { Gateway } from '../gateway';
import { errorBody, requireBearer } from './common';

/**
 * Webhook tools called by the ElevenLabs agent during a live conversation. The agent already has the full incident
 * context (dynamic variable), so tools exist only for: asking the supervisor something not in that context, showing the
 * trajectory on the dashboard, changing the plan, and sending the human's feedback.
 *
 * Every request is authenticated with the shared tool secret and bound to one incident + one active call. Business errors
 * return HTTP 200 { ok:false, error_code, message } so the agent can read them; auth/binding failures return 401/403.
 */

const Base = z.object({ incident_id: z.string().min(1), call_id: z.string().min(1), conversation_id: z.string().optional() });

const TOOLS = {
  ask_supervisor: Base.extend({ question: z.string().min(3).max(1000) }),
  show_trajectory: Base.extend({ segment: z.string().max(200).optional() }),
  change_plan: Base.extend({
    parameter_key: z.string().min(1).max(200),
    new_value: z.union([z.string(), z.number(), z.boolean()]),
    unit: z.string().max(40).optional(),
    reason: z.string().max(2000).optional(),
  }),
  send_feedback: Base.extend({
    revision: z.coerce.number().int().min(1),
    decision: z.enum(['APPROVE', 'REJECT', 'DEFER']),
    feedback: z.string().max(4000).optional(),
  }),
} as const;
type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function registerAgentTools(app: FastifyInstance, gw: Gateway) {
  app.post<{ Params: { tool: string } }>('/v1/agent-tools/:tool', async (req, reply) => {
    if (!requireBearer(req, reply, gw.config.TOOL_SECRET)) return;
    const name = req.params.tool as ToolName;
    const schema = TOOLS[name];
    if (!schema) return reply.code(404).send({ ok: false, error_code: 'UNKNOWN_TOOL', message: `No tool ${req.params.tool}.` });

    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return { ok: false, error_code: 'INVALID_ARGUMENTS', message: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
    }
    const args = parsed.data;
    try {
      const call = await gw.calls.activeCallFor(args.call_id, args.incident_id);
      if (args.conversation_id && !args.conversation_id.startsWith('{{')) {
        if (call.conversation_id && call.conversation_id !== args.conversation_id) {
          return reply.code(403).send({ ok: false, error_code: 'CALL_BINDING', message: 'This conversation is not bound to this call.' });
        }
        if (!call.conversation_id) await gw.calls.connected(call._id, args.conversation_id);
      }
      const incident = await gw.incidents.get(args.incident_id);
      const result = await handlers[name](gw, args as never, call, incident);
      await gw.events.emit('agent.tool_call', incident._id, 'VOICE', { tool: name, ok: true });
      return { ok: true, ...result };
    } catch (err) {
      const { status, body } = errorBody(err);
      if (status === 401 || status === 403) return reply.code(status).send({ ok: false, ...body });
      if (status >= 500) req.log.error({ err, tool: name }, 'agent tool failed');
      await gw.events.emit('agent.tool_call', args.incident_id, 'VOICE', { tool: name, ok: false, error_code: body.error_code }).catch(() => {});
      return { ok: false, ...body };
    }
  });
}

const voiceRequester = (inc: IncidentDoc, call: CallDoc): Requester => ({
  channel: 'VOICE',
  supervisor_id: inc.incident.responsible_supervisor.id,
  call_id: call._id,
  conversation_id: call.conversation_id,
});

type Handler<K extends ToolName> = (gw: Gateway, args: z.infer<(typeof TOOLS)[K]>, call: CallDoc, inc: IncidentDoc) => Promise<Record<string, unknown>>;
const handlers: { [K in ToolName]: Handler<K> } = {
  async ask_supervisor(gw, a, call, inc) {
    const r = await gw.queries.ask(inc._id, a.question, 'VOICE', call._id);
    const say: Record<string, string> = {
      ANSWERED: 'Give the gist of this answer in one or two plain sentences. Offer more detail if they want it.',
      INSUFFICIENT_EVIDENCE: "The supervisor doesn't have the data to answer this. Say so plainly and say what is missing. Do not guess.",
      PENDING: 'The supervisor is still working on it. Say so; if they want to wait, call ask_supervisor again with the same question in a few seconds.',
      UNAVAILABLE: 'The supervisor could not answer right now. Say so. Do not answer it yourself.',
    };
    return { status: r.status, answer: r.answer ?? null, missing: r.limitations ?? null, instruction: say[r.status] };
  },

  async show_trajectory(gw, a, _call, inc) {
    const t = await gw.harness.getTrajectory(inc.incident);
    if (!t) return { shown: false, message: 'There is no trajectory for this incident. Say so; do not describe a path.' };
    const segment = a.segment ? t.segments.find((s) => s.label.toLowerCase().includes(a.segment!.toLowerCase()) || s.id === a.segment) : undefined;
    gw.events.signal('trajectory.focus', inc._id, { segment_id: segment?.id ?? null });
    await gw.events.emit('trajectory.shown', inc._id, 'VOICE', { segment_id: segment?.id ?? null });
    return { shown: true, message: 'The path is now on their dashboard: dashed line is the plan, solid line is what the robot did, red dots mark where it went off.' };
  },

  async change_plan(gw, a, call, inc) {
    const { head } = await gw.proposals.current(inc._id);
    const r = await gw.proposals.revise(
      inc._id,
      { base_revision: head.latest_revision, changes: [{ op: 'set_param', key: a.parameter_key, value: a.new_value, unit: a.unit }], rationale: a.reason || 'Requested by the human on the call.' },
      voiceRequester(inc, call),
    );
    if (!r.accepted) return { changed: false, reason: r.reason, message: 'The supervisor did not accept this change. Tell them why in one sentence.' };
    const p = r.revision.content;
    return { changed: true, revision: r.revision.revision, new_plan: p.plain_summary ?? p.summary, message: `The plan is now revision ${r.revision.revision}. Say the new plan in one sentence and ask if they approve.` };
  },

  async send_feedback(gw, a, call, inc) {
    const { head } = await gw.proposals.current(inc._id);
    const idempotency_key = createHash('sha256')
      .update([call.conversation_id ?? call._id, head._id, a.revision, a.decision].join('|'))
      .digest('hex');
    const { decision } = await gw.decisions.decide(inc._id, { revision: a.revision, decision: a.decision, feedback: a.feedback, idempotency_key }, voiceRequester(inc, call));
    const what = { APPROVE: 'approval', REJECT: 'rejection', DEFER: 'request to wait' }[decision.decision as 'APPROVE' | 'REJECT' | 'DEFER'];
    return { sent: true, message: `Their ${what} of revision ${decision.revision} has been recorded and sent to the supervisor with their feedback.` };
  },
};
