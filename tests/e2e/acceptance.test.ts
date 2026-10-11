// End-to-end tests through the real HTTP routes: in-memory MongoDB replica set, ScriptedCallProvider (the test plays the
// ElevenLabs agent by calling the webhook tools), MockHarness + deterministic fact-lookup supervisor. No network.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drain, incidentFor, incidentState, postIncident, setup, tool, triggerAndAnswer, waitFor, type Ctx, type TestEnv } from '../helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env?.close();
});

const feedback = (ctx: Ctx, revision: number, decision: 'APPROVE' | 'REJECT' | 'DEFER', text = 'ok') => tool(env, ctx, 'send_feedback', { revision, decision, feedback: text });
const received = (ctx: Ctx) => env.mock.received.filter((f) => f.incident_id === ctx.incident_id);

describe('1 — proactive trigger', () => {
  it('creates exactly one call per incident without human initiation, and dedupes redelivery', async () => {
    const inc = incidentFor(env, 'A');
    expect((await postIncident(env, inc)).statusCode).toBe(201);
    const again = await postIncident(env, inc);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true });
    await Promise.all([env.gw.tick(), env.gw.calls.place(inc.incident_id), env.gw.calls.place(inc.incident_id)]);
    expect(await env.gw.db.c.calls.countDocuments({ incident_id: inc.incident_id })).toBe(1);
  });

  it('rejects unauthorized and invalid triggers without storing anything', async () => {
    const inc = incidentFor(env, 'A');
    expect((await postIncident(env, inc, 'wrong-token-xxxxxxxxxxxx')).statusCode).toBe(401);
    expect((await postIncident(env, { ...inc, severity: 'APOCALYPTIC' })).statusCode).toBe(400);
    expect(await env.gw.db.c.incidents.countDocuments({ _id: inc.incident_id })).toBe(0);
  });
});

describe('2 — one agent, per-incident context', () => {
  it('gives each call a short plain-language opening plus the full context, for any category', async () => {
    for (const [name, expectWord] of [['A', 'worker'], ['B', 'tote'], ['C', 'lift']] as const) {
      const sim = env;
      const inc = incidentFor(sim, name);
      await postIncident(sim, inc);
      await sim.gw.tick();
      const call = (await sim.gw.db.c.calls.findOne({ incident_id: inc.incident_id }))!;
      // Scripted calls auto-answer; mint the session the browser would receive.
      const { buildBriefing } = await import('../../src/server/domain/briefing');
      const { revision, head } = await sim.gw.proposals.current(inc.incident_id);
      const b = buildBriefing(inc, revision.content, head.latest_revision, await sim.mock.getMetrics(inc), await sim.mock.getTrajectory(inc));
      expect(b.incident_brief.split(/[.!?]\s/).length).toBeLessThanOrEqual(2);
      expect(b.incident_brief.toLowerCase()).toContain(expectWord);
      expect(b.incident_context).toContain(inc.robot_id);
      expect(b.incident_context).toContain('CURRENT PLAN — revision 1');
      expect(call.status).toBe('ANSWERED');
    }
  });

  it('rejects tool calls with a wrong secret or bound to another incident', async () => {
    const a = await triggerAndAnswer(env, 'A');
    const b = await triggerAndAnswer(env, 'B');
    expect((await tool(env, a, 'show_trajectory', {}, 'wrong-secret-xxxxxxxxxxxx')).status).toBe(401);
    expect((await tool(env, { ...a, call_id: b.call_id }, 'show_trajectory')).status).toBe(403);
  });
});

describe('3 / 10 — questions go to the supervisor; unknowns are not invented', () => {
  it('forwards an unscripted question and returns the grounded answer', async () => {
    const ctx = await triggerAndAnswer(env, 'A');
    const q = 'Why did the robot slow down before it passed the worker?';
    const r = await tool(env, ctx, 'ask_supervisor', { question: q });
    expect(env.mock.questions.some((x) => x.incident_id === ctx.incident_id && x.question === q)).toBe(true);
    expect(r.body).toMatchObject({ ok: true, status: 'ANSWERED' });
    expect(r.body.answer).toMatch(/0\.41 metres per second/);
  });

  it('says the data is missing instead of guessing', async () => {
    const ctx = await triggerAndAnswer(env, 'D');
    const s = env.mock.scenarios.get('D')!;
    const saved = s.supervisor.delay_ms;
    s.supervisor.delay_ms = 0;
    try {
      const r = await tool(env, ctx, 'ask_supervisor', { question: 'What did the lidar scans show about localization?' });
      expect(r.body).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', answer: null });
      expect(r.body.missing).toMatch(/not retained/);
    } finally {
      s.supervisor.delay_ms = saved;
    }
  });

  it('a slow supervisor returns PENDING, and asking again later returns the answer without re-asking', async () => {
    const ctx = await triggerAndAnswer(env, 'D');
    const s = env.mock.scenarios.get('D')!;
    const saved = s.supervisor.delay_ms;
    s.supervisor.delay_ms = 900;
    try {
      const q = 'What exactly happened at the intersection deadlock?';
      expect((await tool(env, ctx, 'ask_supervisor', { question: q })).body.status).toBe('PENDING');
      const later = await waitFor(async () => {
        const r = await tool(env, ctx, 'ask_supervisor', { question: q });
        return r.body.status !== 'PENDING' && r.body;
      });
      expect(later.status).toBe('ANSWERED');
      expect(env.mock.questions.filter((x) => x.incident_id === ctx.incident_id)).toHaveLength(1);
    } finally {
      s.supervisor.delay_ms = saved;
    }
  });
});

describe('4 — trajectory', () => {
  it('pushes the trajectory to the dashboard, or says there is none', async () => {
    const ctx = await triggerAndAnswer(env, 'A');
    const seen: string[] = [];
    const off = env.gw.events.subscribe((e) => e.incident_id === ctx.incident_id && seen.push(e.type));
    expect((await tool(env, ctx, 'show_trajectory', { segment: 'lift lobby' })).body.shown).toBe(true);
    off();
    expect(seen).toContain('trajectory.focus');
    const api = await env.app.inject({ method: 'GET', url: `/api/incidents/${ctx.incident_id}/trajectory` });
    expect(api.json().trajectory.task_id).toBe('task:M:PICK:0412');
    expect((await tool(env, await triggerAndAnswer(env, 'B'), 'show_trajectory')).body.shown).toBe(false);
  });
});

describe('6 / 9 — changing the plan', () => {
  it('creates a new revision via the supervisor and sends nothing yet', async () => {
    const ctx = await triggerAndAnswer(env, 'A');
    const r = await tool(env, ctx, 'change_plan', { parameter_key: 'planner.lift_lobby.inflation_radius_m', new_value: '0.6', unit: 'metres' });
    expect(r.body).toMatchObject({ ok: true, changed: true, revision: 2 });
    expect(r.body.new_plan).toMatch(/0\.6 m/);
    await drain(env);
    expect(received(ctx)).toHaveLength(0);
  });

  it('refuses out-of-range, wrong-unit and supervisor-refused changes without a new revision', async () => {
    const ctx = await triggerAndAnswer(env, 'A');
    const key = 'planner.lift_lobby.inflation_radius_m';
    expect((await tool(env, ctx, 'change_plan', { parameter_key: key, new_value: 2 })).body.error_code).toBe('OUT_OF_BOUNDS');
    expect((await tool(env, ctx, 'change_plan', { parameter_key: key, new_value: 60, unit: 'cm' })).body.error_code).toBe('UNIT_MISMATCH');
    const refused = await tool(env, ctx, 'change_plan', { parameter_key: key, new_value: 0.85 });
    expect(refused.body).toMatchObject({ ok: true, changed: false });
    expect(await env.gw.db.c.proposal_revisions.countDocuments({ incident_id: ctx.incident_id })).toBe(1);
  });

  it('feedback on an outdated revision is refused and the agent is told the new plan', async () => {
    const ctx = await triggerAndAnswer(env, 'A');
    await tool(env, ctx, 'change_plan', { parameter_key: 'planner.lift_lobby.speed_cap_mps', new_value: 0.6 });
    const stale = await feedback(ctx, 1, 'APPROVE');
    expect(stale.body).toMatchObject({ ok: false, error_code: 'STALE_REVISION', latest_revision: 2 });
    expect(stale.body.message).toMatch(/Updated plan/);
    expect((await feedback(ctx, 7, 'APPROVE')).body.error_code).toBe('UNKNOWN_REVISION');
  });
});

describe('7 / 8 — feedback goes back to the supervisor exactly once', () => {
  it('approval + the human words are recorded and delivered once, even with retries', async () => {
    const ctx = await triggerAndAnswer(env, 'C');
    const r = await feedback(ctx, 1, 'APPROVE', 'Go ahead, but watch the cycle time.');
    expect(r.body).toMatchObject({ ok: true, sent: true });
    expect((await feedback(ctx, 1, 'APPROVE', 'Go ahead, but watch the cycle time.')).body.ok).toBe(true); // tool retry
    await Promise.all([drain(env), drain(env), env.gw.tick()]);
    expect(received(ctx)).toHaveLength(1);
    expect(received(ctx)[0]).toMatchObject({ decision: 'APPROVE', revision: 1, feedback: 'Go ahead, but watch the cycle time.' });
    expect(await incidentState(env, ctx.incident_id)).toBe('APPROVED');
    const d = await env.gw.db.c.decisions.findOne({ incident_id: ctx.incident_id, decision: 'APPROVE' });
    expect(d!.submission.state).toBe('ACKED');
  });

  it('rejection is recorded, delivered, and closes the incident', async () => {
    const ctx = await triggerAndAnswer(env, 'A');
    await feedback(ctx, 1, 'REJECT', 'Get me camera footage first.');
    await drain(env);
    expect(await incidentState(env, ctx.incident_id)).toBe('REJECTED');
    expect(received(ctx).map((f) => [f.decision, f.feedback])).toEqual([['REJECT', 'Get me camera footage first.']]);
    expect((await feedback(ctx, 1, 'APPROVE')).body.error_code).toMatch(/ALREADY_DECIDED|ILLEGAL_STATE/);
  });

  it('deferral keeps the incident open', async () => {
    const ctx = await triggerAndAnswer(env, 'D');
    await feedback(ctx, 1, 'DEFER', 'Call me after the shift.');
    expect(await incidentState(env, ctx.incident_id)).toBe('DEFERRED');
  });

  it('a failed delivery is retried and still delivered once', async () => {
    const ctx = await triggerAndAnswer(env, 'C');
    env.mock.failNextDeliveries = 1;
    await feedback(ctx, 1, 'APPROVE');
    await drain(env);
    expect(received(ctx)).toHaveLength(0);
    await env.gw.db.c.decisions.updateOne({ incident_id: ctx.incident_id, decision: 'APPROVE' }, { $set: { 'submission.next_attempt_at': new Date(0) } });
    await drain(env);
    expect(received(ctx)).toHaveLength(1);
  });
});

describe('11 — call interruption', () => {
  it('hanging up before deciding infers nothing', async () => {
    const ctx = await triggerAndAnswer(env, 'A');
    await env.app.inject({ method: 'POST', url: `/api/calls/${ctx.call_id}/end`, payload: { reason: 'dropped' } });
    expect(await incidentState(env, ctx.incident_id)).toBe('AWAITING_DECISION');
    await drain(env);
    expect(received(ctx)).toHaveLength(0);
    expect((await tool(env, ctx, 'show_trajectory')).body.error_code).toBe('CALL_NOT_ACTIVE');
  });

  it('only the session that answered can end the call (a second dashboard tab cannot)', async () => {
    const sim = await setup({ CALL_MODE: 'simulated', CALL_RING_TIMEOUT_MS: 60_000 });
    try {
      const inc = incidentFor(sim, 'A');
      await postIncident(sim, inc);
      await sim.gw.tick();
      const call = (await sim.gw.db.c.calls.findOne({ incident_id: inc.incident_id }))!;
      const a = await sim.app.inject({ method: 'POST', url: `/api/calls/${call._id}/answer` });
      const token = a.json().answer_token as string;
      expect(a.json().dynamic_variables).toMatchObject({ incident_id: inc.incident_id, current_revision: 1 });
      expect((await sim.app.inject({ method: 'POST', url: `/api/calls/${call._id}/answer` })).json().error_code).toBe('CALL_NOT_RINGING');
      const rogue = await sim.app.inject({ method: 'POST', url: `/api/calls/${call._id}/end`, payload: { reason: 'failed to connect' } });
      expect(rogue.json().error_code).toBe('CALL_NOT_YOURS');
      expect(await incidentState(sim, inc.incident_id)).toBe('IN_CALL');
      await sim.app.inject({ method: 'POST', url: `/api/calls/${call._id}/end`, payload: { reason: 'hung up', answer_token: token } });
      expect(await incidentState(sim, inc.incident_id)).toBe('AWAITING_DECISION');
    } finally {
      await sim.close();
    }
  });

  it('unanswered calls retry once then mark UNREACHED; a session that never connects is ended', async () => {
    const sim = await setup({ CALL_MODE: 'simulated', CALL_RING_TIMEOUT_MS: 0, CALL_RETRY_DELAY_MS: 0, CALL_MAX_ATTEMPTS: 2, CALL_CONNECT_TIMEOUT_MS: 0 });
    try {
      const inc = incidentFor(sim, 'C');
      await postIncident(sim, inc);
      for (let i = 0; i < 4; i++) await sim.gw.tick();
      expect((await sim.gw.db.c.calls.find({ incident_id: inc.incident_id }).toArray()).map((c) => c.status)).toEqual(['NO_ANSWER', 'NO_ANSWER']);
      expect(await incidentState(sim, inc.incident_id)).toBe('UNREACHED');

      const inc2 = incidentFor(sim, 'C');
      await sim.gw.db.db.command({ ping: 1 });
      await postIncident(sim, inc2);
      await sim.gw.calls.place(inc2.incident_id);
      const call = (await sim.gw.db.c.calls.findOne({ incident_id: inc2.incident_id }))!;
      await sim.gw.calls.answer(call._id, true); // answered, but no voice session ever connects
      await sim.gw.calls.tick(new Date(Date.now() + 1000));
      expect((await sim.gw.db.c.calls.findOne({ _id: call._id }))!.end_reason).toBe('voice session never connected');
      expect(await incidentState(sim, inc2.incident_id)).toBe('AWAITING_DECISION');
    } finally {
      await sim.close();
    }
  });
});

describe('13 — voice and dashboard share one engine', () => {
  it('a dashboard change is what the voice decision must target, and vice versa', async () => {
    const ctx = await triggerAndAnswer(env, 'C');
    const dash = await env.app.inject({
      method: 'POST',
      url: `/api/incidents/${ctx.incident_id}/revisions`,
      payload: { base_revision: 1, changes: [{ op: 'set_param', key: 'sequencing.max_batch_wait_s', value: 10 }], rationale: 'shorter wait' },
    });
    expect(dash.json().revision.revision).toBe(2);
    expect((await feedback(ctx, 1, 'APPROVE')).body.error_code).toBe('STALE_REVISION');
    await tool(env, ctx, 'change_plan', { parameter_key: 'sequencing.max_batch_wait_s', new_value: 15 });
    const agg = (await env.app.inject({ method: 'GET', url: `/api/incidents/${ctx.incident_id}` })).json();
    expect(agg.revisions.map((r: any) => [r.revision, r.status, r.source])).toEqual([
      [1, 'SUPERSEDED', 'SUPERVISOR'],
      [2, 'SUPERSEDED', 'HUMAN_DASHBOARD'],
      [3, 'PENDING_REVIEW', 'HUMAN_VOICE'],
    ]);
    const stale = await env.app.inject({ method: 'POST', url: `/api/incidents/${ctx.incident_id}/decisions`, payload: { revision: 2, decision: 'APPROVE', idempotency_key: 'dash-stale-123' } });
    expect(stale.json().error_code).toBe('STALE_REVISION');
  });

  it('simultaneous approvals from voice and dashboard record exactly one decision', async () => {
    const ctx = await triggerAndAnswer(env, 'C');
    const [v, d] = await Promise.all([
      feedback(ctx, 1, 'APPROVE'),
      env.app.inject({ method: 'POST', url: `/api/incidents/${ctx.incident_id}/decisions`, payload: { revision: 1, decision: 'APPROVE', idempotency_key: `dash-${ctx.incident_id}` } }),
    ]);
    expect([v.body.ok === true, d.statusCode === 200].filter(Boolean)).toHaveLength(1);
    expect(await env.gw.db.c.decisions.countDocuments({ incident_id: ctx.incident_id, final: true })).toBe(1);
  });
});

describe('14 — concurrent incidents', () => {
  it('keeps calls, plans and feedback separate', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((s) => triggerAndAnswer(env, s)));
    await Promise.all([
      tool(env, a, 'change_plan', { parameter_key: 'planner.lift_lobby.inflation_radius_m', new_value: 0.6 }),
      tool(env, b, 'change_plan', { parameter_key: 'latch.force_setpoint_n', new_value: 28 }),
    ]);
    await Promise.all([feedback(a, 2, 'APPROVE', 'A ok'), feedback(b, 2, 'REJECT', 'B no'), feedback(c, 1, 'DEFER', 'C later')]);
    await drain(env);
    expect(received(a)[0]).toMatchObject({ decision: 'APPROVE', feedback: 'A ok', proposal_id: a.proposal_id });
    expect(received(a)[0].proposal.changes[0]).toMatchObject({ key: 'planner.lift_lobby.inflation_radius_m', value: 0.6 });
    expect(received(b)[0]).toMatchObject({ decision: 'REJECT', feedback: 'B no', proposal_id: b.proposal_id });
    expect(received(c)[0]).toMatchObject({ decision: 'DEFER', feedback: 'C later' });
    expect((await tool(env, { ...a, incident_id: b.incident_id }, 'show_trajectory')).status).toBe(403);
  });
});

describe('post-call webhook', () => {
  it('verifies signatures, dedupes redelivery and never records a decision', async () => {
    const { signElevenLabs } = await import('../../src/server/routes/webhooks');
    const ctx = await triggerAndAnswer(env, 'A');
    const body = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: ctx.conversation_id, metadata: { termination_reason: 'client disconnected' }, analysis: { transcript_summary: 'Human said approve.' }, transcript: [] } });
    const send = (sig: string) => env.app.inject({ method: 'POST', url: '/v1/webhooks/elevenlabs', headers: { 'content-type': 'application/json', 'elevenlabs-signature': sig }, payload: body });
    expect((await send('t=1,v0=deadbeef')).statusCode).toBe(401);
    const sig = signElevenLabs(body, 'whsec_test');
    expect((await send(sig)).json()).toMatchObject({ ok: true });
    expect((await send(sig)).json()).toMatchObject({ duplicate: true });
    expect(await incidentState(env, ctx.incident_id)).toBe('AWAITING_DECISION');
    expect(await env.gw.db.c.decisions.countDocuments({ incident_id: ctx.incident_id })).toBe(0);
  });
});
