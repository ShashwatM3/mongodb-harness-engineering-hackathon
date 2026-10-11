import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CallDoc, IncidentDoc } from '../db';
import { GatewayError } from '../domain/errors';
import type { Requester } from '../domain/proposals';
import type { Gateway } from '../gateway';
import { errorBody, requireBearer } from './common';

/**
 * Webhook tools called by the ElevenLabs agent during a live conversation. Every request is:
 *  1. authenticated with the shared tool secret (ElevenLabs workspace secret header),
 *  2. bound to one incident + one active call (+ the provider conversation id once known),
 *  3. gated on server-side identity verification (except verify_identity itself).
 * Business errors return HTTP 200 with { ok:false, error_code, message } so the agent can read the message and respond;
 * auth and binding failures return 401/403.
 */

const Base = z.object({
  incident_id: z.string().min(1),
  call_id: z.string().min(1),
  conversation_id: z.string().optional(),
});

const num = z.coerce.number();

const TOOLS = {
  verify_identity: Base.extend({ code: z.coerce.string().min(1).max(32) }),
  get_incident: Base,
  ask_supervisor: Base.extend({ question: z.string().min(3).max(1000) }),
  get_supervisor_answer: Base.extend({ query_id: z.string().min(1) }),
  get_trajectory: Base.extend({ segment: z.string().max(200).optional() }),
  get_metrics: Base.extend({ metric: z.string().max(200).optional() }),
  get_proposal: Base,
  revise_proposal: Base.extend({
    base_revision: num.int().min(1),
    parameter_key: z.string().max(200).optional(),
    new_value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    unit: z.string().max(40).optional(),
    change_request: z.string().max(2000).optional(),
    rationale: z.string().min(1).max(2000),
  }),
  submit_decision: Base.extend({
    revision: num.int().min(1),
    decision: z.enum(['APPROVE', 'REJECT', 'DEFER', 'REQUEST_MORE_INFORMATION']),
    confirmation_utterance: z.string().max(500).optional(),
    reason: z.string().max(2000).optional(),
  }),
  get_execution_status: Base,
} as const;
type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

const pct = (c?: number) => (c === undefined ? null : `${Math.round(c * 100)} percent`);

export function registerAgentTools(app: FastifyInstance, gw: Gateway) {
  app.post<{ Params: { tool: string } }>('/v1/agent-tools/:tool', async (req, reply) => {
    if (!requireBearer(req, reply, gw.config.TOOL_SECRET)) return;
    const name = req.params.tool as ToolName;
    const schema = TOOLS[name];
    if (!schema) return reply.code(404).send({ ok: false, error_code: 'UNKNOWN_TOOL', message: `No tool ${req.params.tool}.` });

    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error_code: 'INVALID_ARGUMENTS',
        message: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      };
    }
    const args = parsed.data as z.infer<(typeof TOOLS)[ToolName]>;

    try {
      const { call, incident } = await bind(gw, args, name);
      const result = await handlers[name](gw, args as never, call, incident);
      await gw.events.emit('agent.tool_call', incident._id, 'VOICE', { tool: name, call_id: call._id, ok: true });
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

async function bind(gw: Gateway, args: z.infer<typeof Base>, tool: ToolName) {
  const call = await gw.calls.activeCallFor(args.call_id, args.incident_id);
  if (args.conversation_id && !args.conversation_id.startsWith('{{')) {
    if (call.conversation_id && call.conversation_id !== args.conversation_id) {
      throw new GatewayError('CALL_BINDING', 'This conversation is not bound to this call.', 403);
    }
    if (!call.conversation_id) await gw.calls.connected(call._id, args.conversation_id);
  }
  if (tool !== 'verify_identity' && !call.identity_verified) {
    throw new GatewayError(
      'IDENTITY_REQUIRED',
      'Identity is not verified yet. Ask the supervisor for their four-digit supervisor code and call verify_identity before sharing any incident details.',
      200,
    );
  }
  const incident = await gw.incidents.get(args.incident_id);
  return { call, incident };
}

const voiceRequester = (inc: IncidentDoc, call: CallDoc): Requester => ({
  channel: 'VOICE',
  supervisor_id: inc.incident.responsible_supervisor.id,
  call_id: call._id,
  conversation_id: call.conversation_id,
});

type Handler<K extends ToolName> = (gw: Gateway, args: z.infer<(typeof TOOLS)[K]>, call: CallDoc, inc: IncidentDoc) => Promise<Record<string, unknown>>;
const handlers: { [K in ToolName]: Handler<K> } = {
  async verify_identity(gw, a, call, inc) {
    const r = await gw.identity.verify(call._id, inc._id, inc.incident.responsible_supervisor.id, a.code);
    return r.verified
      ? { verified: true, message: `Identity verified for ${inc.incident.responsible_supervisor.name}. You may now brief them on the incident.` }
      : { verified: false, attempts_remaining: r.remaining, message: r.remaining ? 'That code is incorrect. Ask them to repeat it.' : 'Verification is now locked for this call.' };
  },

  async get_incident(gw, _a, _call, inc) {
    const i = inc.incident;
    const { revision } = await gw.proposals.current(inc._id);
    return {
      synthetic_data: i.synthetic,
      state: inc.state,
      category: i.category,
      severity: i.severity,
      robot_id: i.robot_id,
      task_id: i.task_id,
      what_happened: i.observed_behavior,
      what_was_expected: i.expected_behavior,
      summary: i.failure_summary,
      supervisor_hypothesis: { kind: 'HYPOTHESIS', text: i.root_cause_hypothesis.text, confidence: pct(i.root_cause_hypothesis.confidence) },
      evidence: i.evidence_refs.map((e) => ({ id: e.id, kind: e.kind, summary: e.summary })),
      why_you_are_being_called: i.escalation.reason,
      current_proposal: { revision: revision.revision, summary: revision.content.summary, risk: revision.content.risk },
    };
  },

  async ask_supervisor(gw, a, call, inc) {
    const r = await gw.queries.ask(inc._id, a.question, 'VOICE', call._id);
    return speakableAnswer(r);
  },

  async get_supervisor_answer(gw, a, _call, inc) {
    return speakableAnswer(await gw.queries.get(inc._id, a.query_id));
  },

  async get_trajectory(gw, a, _call, inc) {
    const t = await gw.harness.getTrajectory(inc.incident);
    if (!t) {
      return { available: false, message: 'The harness has no trajectory for this incident. Do not describe a path.' };
    }
    const segment = a.segment ? t.segments.find((s) => s.label.toLowerCase().includes(a.segment!.toLowerCase()) || s.id === a.segment) : undefined;
    gw.events.signal('trajectory.focus', inc._id, { segment_id: segment?.id ?? null });
    await gw.events.emit('trajectory.viewed', inc._id, 'VOICE', { segment_id: segment?.id ?? null });
    const dur = t.actual.length ? t.actual[t.actual.length - 1].t - t.actual[0].t : 0;
    return {
      available: true,
      synthetic_data: t.synthetic,
      robot_id: t.robot_id,
      duration_seconds: dur,
      units: t.units,
      segments: t.segments.map((s) => ({ label: s.label, from_s: s.t_start, to_s: s.t_end })),
      deviations: t.deviations.map((d) => ({ at_seconds: d.t, magnitude_metres: d.magnitude_m, kind: d.kind, description: d.description })),
      focused_segment: segment?.label ?? null,
      dashboard: 'The planned and actual paths are now shown on the supervisor dashboard with deviation markers. Tell them to look at the trajectory panel.',
      source: t.source,
    };
  },

  async get_metrics(gw, a, _call, inc) {
    const keys = a.metric ? a.metric.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const metrics = await gw.harness.getMetrics(inc.incident, keys);
    if (!metrics.length) {
      return { available: false, message: `The harness has no metric matching "${a.metric ?? ''}". Say it is unavailable; do not estimate.` };
    }
    return {
      available: true,
      metrics: metrics.map((m) => ({
        label: m.label,
        value: m.value,
        unit: m.unit,
        kind: m.kind,
        expected: m.expected ?? null,
        measured_at: m.timestamp,
        source: m.source,
        note: m.note ?? null,
        history: m.history?.map((h) => `${h.label}: ${h.value}`).join(', ') ?? null,
      })),
    };
  },

  async get_proposal(gw, _a, _call, inc) {
    const { head, revision } = await gw.proposals.current(inc._id);
    const p = revision.content;
    return {
      proposal_id: head._id,
      revision: head.latest_revision,
      status: head.state === 'DECIDED' ? `already ${head.decision === 'APPROVE' ? 'approved' : 'rejected'} (revision ${head.decided_revision})` : head.state === 'RECONCILING' ? 'a modification is being reconciled' : 'awaiting decision',
      summary: p.summary,
      changes: p.changes.map((c) => {
        if (c.op !== 'set_param') return { request: c.text };
        const spec = p.editable_parameters.find((s) => s.key === c.key);
        return { parameter: spec?.label ?? c.key, key: c.key, from: spec?.current_value ?? null, to: c.value, unit: spec?.unit ?? c.unit ?? '' };
      }),
      editable_parameters: p.editable_parameters.map((s) => ({ key: s.key, label: s.label, unit: s.unit, allowed_min: s.min ?? null, allowed_max: s.max ?? null, current: s.current_value, proposed: s.proposed_value })),
      justification: p.justification,
      constraints: p.constraints,
      risk: p.risk,
      approval_requirements:
        p.risk === 'HIGH'
          ? 'HIGH risk: a voice approval is held until the supervisor also confirms it on the dashboard.'
          : 'An explicit spoken confirmation naming the revision number is required, e.g. "I approve revision N".',
      source: revision.source,
    };
  },

  async revise_proposal(gw, a, call, inc) {
    const changes = a.change_request
      ? [{ op: 'request' as const, text: a.change_request }]
      : a.parameter_key !== undefined && a.new_value !== undefined
        ? [{ op: 'set_param' as const, key: a.parameter_key, value: a.new_value, unit: a.unit }]
        : null;
    if (!changes) throw new GatewayError('INVALID_ARGUMENTS', 'Provide parameter_key and new_value, or a change_request.', 422);
    const r = await gw.proposals.revise(inc._id, { base_revision: a.base_revision, changes, rationale: a.rationale }, voiceRequester(inc, call));
    if (!r.accepted) {
      return { accepted: false, reason: r.reason, current_revision: r.latest_revision, message: 'The supervisor refused this modification; no new revision was created and nothing was executed.' };
    }
    return {
      accepted: true,
      new_revision: r.revision.revision,
      summary: r.revision.content.summary,
      message: `Revision ${r.revision.revision} created. Nothing has been executed. Read it back and ask for an explicit decision on revision ${r.revision.revision}.`,
    };
  },

  async submit_decision(gw, a, call, inc) {
    const { head } = await gw.proposals.current(inc._id);
    const idempotency_key = createHash('sha256')
      .update([call.conversation_id ?? call._id, head._id, a.revision, a.decision].join('|'))
      .digest('hex');
    const { decision, replayed } = await gw.decisions.decide(
      inc._id,
      { revision: a.revision, decision: a.decision, reason: a.reason, idempotency_key, confirmation_utterance: a.confirmation_utterance },
      voiceRequester(inc, call),
    );
    const held = decision.confirmation.status === 'PENDING_SECOND_FACTOR';
    const messages: Record<string, string> = {
      APPROVE: held
        ? `Approval of revision ${decision.revision} is recorded but HELD: this is a high-risk change, so the supervisor must also press Confirm on the dashboard. Nothing has been sent to the robots yet.`
        : `Approval of revision ${decision.revision} is recorded and queued for the harness. Nothing is applied until the harness confirms execution; use get_execution_status to check.`,
      REJECT: `Rejection of revision ${decision.revision} is recorded. No change will be executed.`,
      DEFER: `The decision is deferred. Nothing will be executed. The incident stays open.`,
      REQUEST_MORE_INFORMATION: `The request for more information is recorded and sent to the supervisor. Nothing will be executed.`,
    };
    return { recorded: true, replayed, decision: decision.decision, revision: decision.revision, decision_id: decision._id, message: messages[decision.decision] };
  },

  async get_execution_status(gw, _a, _call, inc) {
    const decision = await gw.db.c.decisions.findOne({ incident_id: inc._id, decision: 'APPROVE' });
    if (!decision) return { approved: false, applied: false, message: 'No approval has been recorded for this incident, so nothing has been executed.' };
    const exec = decision.submission.execution_id ? await gw.db.c.executions.findOne({ _id: decision.submission.execution_id }) : null;
    const applied = exec?.status === 'APPLIED';
    return {
      approved: decision.confirmation.status === 'CONFIRMED',
      revision: decision.revision,
      delivery_to_harness: decision.submission.state,
      execution_status: exec?.status ?? 'NOT_STARTED',
      detail: exec?.detail ?? decision.submission.last_error ?? null,
      applied,
      result_metrics: exec?.result_metrics?.map((m) => ({ label: m.label, value: m.value, unit: m.unit, kind: m.kind })) ?? [],
      message: applied
        ? 'The harness confirmed the change was applied.'
        : exec && ['FAILED', 'CANCELLED', 'REJECTED_BY_HARNESS'].includes(exec.status)
          ? 'The harness did NOT apply the change. Explain the detail.'
          : 'Not applied yet. Do not say it is applied.',
    };
  },
};

function speakableAnswer(r: Awaited<ReturnType<Gateway['queries']['ask']>>) {
  const guidance: Record<string, string> = {
    ANSWERED: "Relay the supervisor's answer, keeping its labels (measured, estimate, hypothesis).",
    INSUFFICIENT_EVIDENCE: 'The supervisor does not have evidence for this. Say so plainly and explain what is missing. Do not guess.',
    PENDING: 'The supervisor is still analysing. Tell the human you are waiting on the analysis, then call get_supervisor_answer with this query_id.',
    UNAVAILABLE: 'The supervisor could not answer. Say so. Do not substitute your own answer.',
  };
  return {
    query_id: r.query_id,
    status: r.status,
    answer: r.answer ?? null,
    confidence: pct(r.confidence),
    evidence_refs: r.evidence_refs,
    limitations: r.limitations ?? null,
    instruction: guidance[r.status],
  };
}
