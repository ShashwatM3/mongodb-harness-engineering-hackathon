// Acceptance tests 1–14 from the project brief, run end to end through the real HTTP routes with:
// in-memory MongoDB replica set, ScriptedCallProvider (test plays the ElevenLabs agent), MockHarness + deterministic
// fact-lookup supervisor. No network, no paid APIs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drain, incidentFor, incidentState, PIN, postIncident, setup, tool, triggerAndAnswer, verified, waitFor, type TestEnv } from '../helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env?.close();
});

const approve = (env: TestEnv, ctx: Awaited<ReturnType<typeof verified>>, revision: number) =>
  tool(env, ctx, 'submit_decision', { revision, decision: 'APPROVE', confirmation_utterance: `Yes, I approve revision ${revision}.` });

describe('Test 1 — proactive trigger', () => {
  it('creates exactly one call job per incident without human initiation, and dedupes redelivery', async () => {
    const inc = incidentFor(env, 'A');
    const r1 = await postIncident(env, inc);
    expect(r1.statusCode).toBe(201);
    const r2 = await postIncident(env, inc); // same event_id redelivered
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ duplicate: true, incident_id: inc.incident_id });

    await Promise.all([env.gw.tick(), env.gw.calls.place(inc.incident_id), env.gw.calls.place(inc.incident_id)]);
    const calls = await env.gw.db.c.calls.find({ incident_id: inc.incident_id }).toArray();
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('ANSWERED');
    expect(await env.gw.db.c.incidents.countDocuments({ event_id: inc.event_id })).toBe(1);
  });

  it('rejects unauthorized and invalid triggers without creating anything', async () => {
    const inc = incidentFor(env, 'A');
    expect((await postIncident(env, inc, 'wrong-token-xxxxxxxxxxxx')).statusCode).toBe(401);
    const bad = await postIncident(env, { ...inc, severity: 'APOCALYPTIC' });
    expect(bad.statusCode).toBe(400);
    expect(await env.gw.db.c.incidents.countDocuments({ _id: inc.incident_id })).toBe(0);
  });
});

describe('Test 2 — dynamic context, one agent configuration', () => {
  it('serves each category its own context through the same tools', async () => {
    const a = await verified(env, 'A');
    const b = await verified(env, 'B');
    const ia = await tool(env, a, 'get_incident');
    const ib = await tool(env, b, 'get_incident');
    expect(ia.body.category).toBe('navigation.trajectory_deviation');
    expect(ib.body.category).toBe('manipulation.grasp_failure');
    expect(ia.body.robot_id).toBe('AMR-07');
    expect(ib.body.robot_id).toBe('AMR-12');
  });

  it('withholds incident details until identity is verified, and locks after 3 bad codes', async () => {
    const ctx = await triggerAndAnswer(env, 'C');
    const before = await tool(env, ctx, 'get_incident');
    expect(before.body).toMatchObject({ ok: false, error_code: 'IDENTITY_REQUIRED' });
    for (let i = 0; i < 3; i++) expect((await tool(env, ctx, 'verify_identity', { code: '0000' })).body.verified).toBe(false);
    const locked = await tool(env, ctx, 'verify_identity', { code: PIN });
    expect(locked.status).toBe(403);
  });

  it('rejects tool calls with a wrong secret or a call bound to another incident', async () => {
    const a = await verified(env, 'A');
    const b = await verified(env, 'B');
    expect((await tool(env, a, 'get_incident', {}, 'wrong-secret-xxxxxxxxxxxx')).status).toBe(401);
    const cross = await tool(env, { ...a, call_id: b.call_id }, 'get_incident');
    expect(cross.status).toBe(403);
  });
});

describe('Test 3 — arbitrary technical question reaches the supervisor', () => {
  it('forwards the question to the harness adapter and returns its answer', async () => {
    const ctx = await verified(env, 'A');
    const q = 'Why did the robot slow down before it passed the worker?';
    const r = await tool(env, ctx, 'ask_supervisor', { question: q });
    expect(env.mock.questions.some((x) => x.incident_id === ctx.incident_id && x.question === q)).toBe(true);
    expect(r.body.status).toBe('ANSWERED');
    expect(r.body.answer).toMatch(/0\.41 metres per second/);
    expect(r.body.evidence_refs).toContain('ev:A:slow');
  });

  it('returns PENDING for long analyses and the answer later via get_supervisor_answer', async () => {
    const ctx = await verified(env, 'D'); // scenario D supervisor takes 12 s
    const s = env.mock.scenarios.get('D')!;
    const saved = s.supervisor.delay_ms;
    s.supervisor.delay_ms = 900;
    try {
      const r = await tool(env, ctx, 'ask_supervisor', { question: 'What exactly happened at the intersection deadlock?' });
      expect(r.body.status).toBe('PENDING');
      const retry = await tool(env, ctx, 'ask_supervisor', { question: 'What exactly happened at the intersection deadlock?' });
      expect(retry.body.query_id).toBe(r.body.query_id); // a retried tool call does not re-ask
      const later = await waitFor(async () => {
        const g = await tool(env, ctx, 'get_supervisor_answer', { query_id: r.body.query_id });
        return g.body.status !== 'PENDING' && g.body;
      });
      expect(later.status).toBe('ANSWERED');
      expect(env.mock.questions.filter((x) => x.incident_id === ctx.incident_id)).toHaveLength(1);
    } finally {
      s.supervisor.delay_ms = saved;
    }
  });
});

describe('Test 4 — trajectory', () => {
  it("returns the incident's own trajectory and signals the dashboard", async () => {
    const ctx = await verified(env, 'A');
    const seen: Array<{ type: string; incident_id: string | null }> = [];
    const off = env.gw.events.subscribe((e) => seen.push(e));
    const r = await tool(env, ctx, 'get_trajectory', { segment: 'lift lobby' });
    off();
    expect(r.body.available).toBe(true);
    expect(r.body.robot_id).toBe('AMR-07');
    expect(r.body.deviations[1]).toMatchObject({ at_seconds: 41.2, magnitude_metres: 0.48, kind: 'MEASURED' });
    expect(seen.some((e) => e.type === 'trajectory.focus' && e.incident_id === ctx.incident_id)).toBe(true);

    const api = await env.app.inject({ method: 'GET', url: `/api/incidents/${ctx.incident_id}/trajectory` });
    expect(api.json().trajectory.task_id).toBe('task:M:PICK:0412');
    expect(api.json().trajectory.actual.length).toBeGreaterThan(10);
  });

  it('says so when no trajectory exists instead of inventing one', async () => {
    const ctx = await verified(env, 'B');
    const r = await tool(env, ctx, 'get_trajectory');
    expect(r.body.available).toBe(false);
  });
});

describe('Test 5 — metrics', () => {
  it('returns value, unit, timestamp, source and kind', async () => {
    const ctx = await verified(env, 'B');
    const r = await tool(env, ctx, 'get_metrics', { metric: 'latch force' });
    const m = r.body.metrics.find((x: any) => x.label === 'Peak latch force');
    expect(m).toMatchObject({ value: 18.4, unit: 'N', kind: 'MEASURED', expected: 25, source: 'amr12.latch_sensor (synthetic)', measured_at: '2026-10-11T10:12:40-07:00' });
    const none = await tool(env, ctx, 'get_metrics', { metric: 'battery temperature' });
    expect(none.body.available).toBe(false);
  });
});

describe('Test 6 — modification creates a revision, never an execution', () => {
  it('creates revision 2 through the harness and executes nothing', async () => {
    const ctx = await verified(env, 'A');
    const r = await tool(env, ctx, 'revise_proposal', {
      base_revision: 1,
      parameter_key: 'planner.lift_lobby.inflation_radius_m',
      new_value: '0.60',
      unit: 'metres',
      rationale: 'Less cycle-time cost, still above 1 m separation in replay.',
    });
    expect(r.body).toMatchObject({ ok: true, accepted: true, new_revision: 2 });
    const p = await tool(env, ctx, 'get_proposal');
    expect(p.body.revision).toBe(2);
    expect(p.body.changes[0]).toMatchObject({ key: 'planner.lift_lobby.inflation_radius_m', to: 0.6, from: 0.45, unit: 'm' });
    await drain(env);
    expect(env.mock.received.filter((d) => d.incident_id === ctx.incident_id)).toHaveLength(0);
    expect(await env.gw.db.c.executions.countDocuments({ incident_id: ctx.incident_id })).toBe(0);
    // A retried identical request returns the same revision instead of conflicting or duplicating.
    const again = await tool(env, ctx, 'revise_proposal', { base_revision: 1, parameter_key: 'planner.lift_lobby.inflation_radius_m', new_value: 0.6, rationale: 'retry' });
    expect(again.body).toMatchObject({ accepted: true, new_revision: 2 });
    expect(await env.gw.db.c.proposal_revisions.countDocuments({ incident_id: ctx.incident_id })).toBe(2);
  });

  it('refuses out-of-bounds, wrong-unit and harness-refused modifications without a new revision', async () => {
    const ctx = await verified(env, 'A');
    const key = 'planner.lift_lobby.inflation_radius_m';
    expect((await tool(env, ctx, 'revise_proposal', { base_revision: 1, parameter_key: key, new_value: 2, rationale: 'x' })).body.error_code).toBe('OUT_OF_BOUNDS');
    expect((await tool(env, ctx, 'revise_proposal', { base_revision: 1, parameter_key: key, new_value: 60, unit: 'cm', rationale: 'x' })).body.error_code).toBe('UNIT_MISMATCH');
    expect((await tool(env, ctx, 'revise_proposal', { base_revision: 1, parameter_key: 'motor.torque', new_value: 1, rationale: 'x' })).body.error_code).toBe('UNKNOWN_PARAMETER');
    const refused = await tool(env, ctx, 'revise_proposal', { base_revision: 1, parameter_key: key, new_value: 0.85, rationale: 'x' });
    expect(refused.body).toMatchObject({ ok: true, accepted: false });
    expect(refused.body.reason).toMatch(/impassable/);
    expect(await env.gw.db.c.proposal_revisions.countDocuments({ incident_id: ctx.incident_id })).toBe(1);
  });
});

describe('Test 7 — approval', () => {
  it('requires an explicit confirmation naming the revision', async () => {
    const ctx = await verified(env, 'C');
    const casual = await tool(env, ctx, 'submit_decision', { revision: 1, decision: 'APPROVE', confirmation_utterance: 'yeah sure' });
    expect(casual.body.error_code).toBe('CONFIRMATION_REQUIRED');
    const negated = await tool(env, ctx, 'submit_decision', { revision: 1, decision: 'APPROVE', confirmation_utterance: 'I do not approve revision 1' });
    expect(negated.body.error_code).toBe('CONFIRMATION_REQUIRED');
    expect(await env.gw.db.c.decisions.countDocuments({ incident_id: ctx.incident_id })).toBe(0);
  });

  it('persists the approval, submits it to the harness exactly once, and does not claim success early', async () => {
    const ctx = await verified(env, 'C');
    env.mock.setOutcome(ctx.incident_id, 'APPLIED');
    const r = await approve(env, ctx, 1);
    expect(r.body).toMatchObject({ ok: true, recorded: true, decision: 'APPROVE', revision: 1 });
    expect(r.body.message).toMatch(/Nothing is applied until the harness confirms/);

    // Before the outbox runs: approved, not applied.
    const early = await tool(env, ctx, 'get_execution_status');
    expect(early.body).toMatchObject({ approved: true, applied: false, delivery_to_harness: 'PENDING' });

    // Tool retry after success + concurrent dispatchers → still one delivery.
    const retry = await approve(env, ctx, 1);
    expect(retry.body.replayed).toBe(true);
    await Promise.all([drain(env), drain(env), env.gw.tick()]);
    expect(env.mock.received.filter((d) => d.incident_id === ctx.incident_id && d.decision === 'APPROVE')).toHaveLength(1);
    expect(await env.gw.db.c.decisions.countDocuments({ incident_id: ctx.incident_id, decision: 'APPROVE' })).toBe(1);

    await waitFor(async () => (await incidentState(env, ctx.incident_id)) === 'RESOLVED');
    const done = await tool(env, ctx, 'get_execution_status');
    expect(done.body).toMatchObject({ applied: true, execution_status: 'APPLIED' });
  });

  it('holds HIGH-risk voice approvals until a dashboard second factor', async () => {
    const ctx = await verified(env, 'E');
    const r = await approve(env, ctx, 1);
    expect(r.body.message).toMatch(/HELD/);
    expect(await incidentState(env, ctx.incident_id)).toBe('AWAITING_CONFIRMATION');
    await drain(env);
    expect(env.mock.received.filter((d) => d.incident_id === ctx.incident_id)).toHaveLength(0);
    const res = await env.app.inject({ method: 'POST', url: `/api/decisions/${r.body.decision_id}/confirm` });
    expect(res.statusCode).toBe(200);
    await drain(env);
    expect(env.mock.received.filter((d) => d.incident_id === ctx.incident_id)).toHaveLength(1);
  });
});

describe('Test 8 — rejection', () => {
  it('records the rejection, notifies the harness, and executes nothing', async () => {
    const ctx = await verified(env, 'A');
    const r = await tool(env, ctx, 'submit_decision', { revision: 1, decision: 'REJECT', confirmation_utterance: 'I reject revision 1', reason: 'Want camera evidence first.' });
    expect(r.body).toMatchObject({ recorded: true, decision: 'REJECT' });
    await drain(env);
    expect(await incidentState(env, ctx.incident_id)).toBe('CLOSED_REJECTED');
    const delivered = env.mock.received.filter((d) => d.incident_id === ctx.incident_id);
    expect(delivered.map((d) => d.decision)).toEqual(['REJECT']);
    expect(await env.gw.db.c.executions.countDocuments({ incident_id: ctx.incident_id })).toBe(0);
    const later = await approve(env, ctx, 1);
    expect(later.body.error_code).toMatch(/ALREADY_DECIDED|ILLEGAL_STATE/);
  });
});

describe('Test 9 — stale and unknown revisions', () => {
  it('refuses approval of an outdated revision and of a revision that does not exist', async () => {
    const ctx = await verified(env, 'A');
    await tool(env, ctx, 'revise_proposal', { base_revision: 1, parameter_key: 'planner.lift_lobby.speed_cap_mps', new_value: 0.6, rationale: 'slower in lobby' });
    const stale = await approve(env, ctx, 1);
    expect(stale.body).toMatchObject({ ok: false, error_code: 'STALE_REVISION', latest_revision: 2 });
    const unknown = await approve(env, ctx, 7);
    expect(unknown.body.error_code).toBe('UNKNOWN_REVISION');
    // Stale modification base is refused too.
    const staleRevise = await tool(env, ctx, 'revise_proposal', { base_revision: 1, parameter_key: 'planner.lift_lobby.speed_cap_mps', new_value: 0.5, rationale: 'x' });
    expect(staleRevise.body.error_code).toBe('REVISION_CONFLICT');
    expect(await env.gw.db.c.decisions.countDocuments({ incident_id: ctx.incident_id, final: true })).toBe(0);
  });
});

describe('Test 10 — unknown information', () => {
  it('reports INSUFFICIENT_EVIDENCE instead of fabricating', async () => {
    const ctx = await verified(env, 'D');
    const s = env.mock.scenarios.get('D')!;
    const saved = s.supervisor.delay_ms;
    s.supervisor.delay_ms = 0;
    try {
      const r = await tool(env, ctx, 'ask_supervisor', { question: 'What did the lidar scans show about localization before the deadlock?' });
      expect(r.body.status).toBe('INSUFFICIENT_EVIDENCE');
      expect(r.body.answer).toBeNull();
      expect(r.body.limitations).toMatch(/not retained/);
      expect(r.body.instruction).toMatch(/Do not guess/);
    } finally {
      s.supervisor.delay_ms = saved;
    }
  });
});

describe('Test 11 — call interruption', () => {
  it('a dropped call before approval infers nothing', async () => {
    const ctx = await verified(env, 'A');
    await tool(env, ctx, 'revise_proposal', { base_revision: 1, parameter_key: 'planner.lift_lobby.inflation_radius_m', new_value: 0.6, rationale: 'x' });
    await env.app.inject({ method: 'POST', url: `/api/calls/${ctx.call_id}/end`, payload: { reason: 'dropped' } });
    expect(await incidentState(env, ctx.incident_id)).toBe('AWAITING_DECISION');
    expect(await env.gw.db.c.decisions.countDocuments({ incident_id: ctx.incident_id, final: true })).toBe(0);
    await drain(env);
    expect(env.mock.received.filter((d) => d.incident_id === ctx.incident_id)).toHaveLength(0);
    // Tools for the ended call are refused.
    const after = await tool(env, ctx, 'get_proposal');
    expect(after.body.error_code).toBe('CALL_NOT_ACTIVE');
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
      expect(token).toBeTruthy();
      const second = await sim.app.inject({ method: 'POST', url: `/api/calls/${call._id}/answer` });
      expect(second.json().error_code).toBe('CALL_NOT_RINGING');
      const rogue = await sim.app.inject({ method: 'POST', url: `/api/calls/${call._id}/end`, payload: { reason: 'failed to connect' } });
      expect(rogue.statusCode).toBe(409);
      expect(rogue.json().error_code).toBe('CALL_NOT_YOURS');
      expect(await incidentState(sim, inc.incident_id)).toBe('IN_CALL');
      const mine = await sim.app.inject({ method: 'POST', url: `/api/calls/${call._id}/end`, payload: { reason: 'hung up', answer_token: token } });
      expect(mine.statusCode).toBe(200);
      expect(await incidentState(sim, inc.incident_id)).toBe('AWAITING_DECISION');
    } finally {
      await sim.close();
    }
  });

  it('an unanswered simulated call retries once and then marks the incident UNREACHED', async () => {
    const sim = await setup({ CALL_MODE: 'simulated', CALL_RING_TIMEOUT_MS: 0, CALL_RETRY_DELAY_MS: 0, CALL_MAX_ATTEMPTS: 2 });
    try {
      const inc = incidentFor(sim, 'C');
      await postIncident(sim, inc);
      await sim.gw.tick(); // ring #1 → place
      await sim.gw.tick(); // expire #1, schedule retry
      await sim.gw.tick(); // ring #2
      await sim.gw.tick(); // expire #2 → UNREACHED
      const calls = await sim.gw.db.c.calls.find({ incident_id: inc.incident_id }).toArray();
      expect(calls.map((c) => c.status)).toEqual(['NO_ANSWER', 'NO_ANSWER']);
      expect(await incidentState(sim, inc.incident_id)).toBe('UNREACHED');
    } finally {
      await sim.close();
    }
  });
});

describe('Test 12 — execution outcomes', () => {
  it('reflects APPLIED and FAILED from the harness, and ignores reordered events', async () => {
    const ok = await verified(env, 'A');
    const bad = await verified(env, 'B'); // scenario B fails at the harness
    await approve(env, ok, 1);
    await approve(env, bad, 1);
    await drain(env);
    await waitFor(async () => (await incidentState(env, ok.incident_id)) === 'RESOLVED');
    await waitFor(async () => (await incidentState(env, bad.incident_id)) === 'EXECUTION_FAILED');
    const s = await tool(env, bad, 'get_execution_status');
    expect(s.body).toMatchObject({ applied: false, execution_status: 'FAILED' });
    expect(s.body.detail).toMatch(/rolled back/);

    // A late, lower-seq event cannot regress a terminal status.
    const exec = (await env.gw.db.c.executions.findOne({ incident_id: ok.incident_id }))!;
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/harness/events',
      headers: { authorization: 'Bearer test-harness-token-0123456789' },
      payload: { execution_id: exec._id, decision_id: exec.decision_id, incident_id: ok.incident_id, seq: 2, status: 'EXECUTING', timestamp: new Date().toISOString() },
    });
    expect(res.json()).toMatchObject({ applied: false });
    expect((await env.gw.db.c.executions.findOne({ _id: exec._id }))!.status).toBe('APPLIED');
  });

  it('records a harness refusal of an approved change', async () => {
    const ctx = await verified(env, 'C');
    env.mock.setOutcome(ctx.incident_id, 'REJECTED_BY_HARNESS');
    await approve(env, ctx, 1);
    await drain(env);
    await waitFor(async () => (await incidentState(env, ctx.incident_id)) === 'HARNESS_REJECTED');
  });
});

describe('Test 13 — voice and dashboard consistency', () => {
  it('a dashboard revision is what the voice agent reads next, and vice versa', async () => {
    const ctx = await verified(env, 'C');
    const dash = await env.app.inject({
      method: 'POST',
      url: `/api/incidents/${ctx.incident_id}/revisions`,
      payload: { base_revision: 1, changes: [{ op: 'set_param', key: 'sequencing.max_batch_wait_s', value: 10 }], rationale: 'shorter wait' },
    });
    expect(dash.json().revision.revision).toBe(2);
    const voice = await tool(env, ctx, 'get_proposal');
    expect(voice.body.revision).toBe(2);
    expect(voice.body.source).toBe('HUMAN_DASHBOARD');

    await tool(env, ctx, 'revise_proposal', { base_revision: 2, parameter_key: 'sequencing.max_batch_wait_s', new_value: 15, rationale: 'compromise' });
    const agg = (await env.app.inject({ method: 'GET', url: `/api/incidents/${ctx.incident_id}` })).json();
    expect(agg.head.latest_revision).toBe(3);
    expect(agg.revisions.map((r: any) => [r.revision, r.status, r.source])).toEqual([
      [1, 'SUPERSEDED', 'SUPERVISOR'],
      [2, 'SUPERSEDED', 'HUMAN_DASHBOARD'],
      [3, 'PENDING_REVIEW', 'HUMAN_VOICE'],
    ]);
    // Dashboard approval of the stale revision 2 is refused.
    const stale = await env.app.inject({ method: 'POST', url: `/api/incidents/${ctx.incident_id}/decisions`, payload: { revision: 2, decision: 'APPROVE', idempotency_key: 'dash-stale-123' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error_code).toBe('STALE_REVISION');
  });

  it('simultaneous approvals from voice and dashboard produce exactly one decision', async () => {
    const ctx = await verified(env, 'C');
    const [v, d] = await Promise.all([
      approve(env, ctx, 1),
      env.app.inject({ method: 'POST', url: `/api/incidents/${ctx.incident_id}/decisions`, payload: { revision: 1, decision: 'APPROVE', idempotency_key: `dash-${ctx.incident_id}` } }),
    ]);
    const okCount = [v.body.ok === true, d.statusCode === 200].filter(Boolean).length;
    expect(okCount).toBe(1);
    expect(await env.gw.db.c.decisions.countDocuments({ incident_id: ctx.incident_id, final: true })).toBe(1);
  });
});

describe('Test 14 — concurrent incidents', () => {
  it('keeps calls, proposals, decisions and executions separate', async () => {
    const ctxs = await Promise.all(['A', 'B', 'C', 'D'].map((s) => verified(env, s)));
    const [a, b, c] = ctxs;
    await Promise.all([
      tool(env, a, 'revise_proposal', { base_revision: 1, parameter_key: 'planner.lift_lobby.inflation_radius_m', new_value: 0.6, rationale: 'x' }),
      tool(env, b, 'revise_proposal', { base_revision: 1, parameter_key: 'latch.force_setpoint_n', new_value: 28, rationale: 'x' }),
    ]);
    await Promise.all([approve(env, a, 2), approve(env, b, 2), tool(env, c, 'submit_decision', { revision: 1, decision: 'DEFER', reason: 'later' })]);
    await drain(env);
    await waitFor(async () => (await incidentState(env, a.incident_id)) === 'RESOLVED');
    await waitFor(async () => (await incidentState(env, b.incident_id)) === 'EXECUTION_FAILED');
    expect(await incidentState(env, c.incident_id)).toBe('DEFERRED');

    for (const ctx of ctxs) {
      const decisions = await env.gw.db.c.decisions.find({ incident_id: ctx.incident_id }).toArray();
      for (const d of decisions) expect(d.proposal_id).toBe(ctx.proposal_id);
      const execs = await env.gw.db.c.executions.find({ incident_id: ctx.incident_id }).toArray();
      for (const e of execs) expect(decisions.map((d) => d._id)).toContain(e.decision_id);
    }
    const da = env.mock.received.find((d) => d.incident_id === a.incident_id)!;
    expect(da.proposal.changes[0]).toMatchObject({ key: 'planner.lift_lobby.inflation_radius_m', value: 0.6 });
    const db = env.mock.received.find((d) => d.incident_id === b.incident_id)!;
    expect(db.proposal.changes[0]).toMatchObject({ key: 'latch.force_setpoint_n', value: 28 });
    // Another incident's call cannot read this incident.
    const leak = await tool(env, { ...a, incident_id: b.incident_id }, 'get_incident');
    expect(leak.status).toBe(403);
  });
});

describe('Post-call webhook', () => {
  it('verifies signatures, dedupes redelivery and never records a decision', async () => {
    const { signElevenLabs } = await import('../../src/server/routes/webhooks');
    const ctx = await verified(env, 'A');
    const body = JSON.stringify({
      type: 'post_call_transcription',
      data: { conversation_id: ctx.conversation_id, status: 'done', metadata: { termination_reason: 'client disconnected' }, analysis: { transcript_summary: 'Human said approve.' }, transcript: [] },
    });
    const send = (sig: string) => env.app.inject({ method: 'POST', url: '/v1/webhooks/elevenlabs', headers: { 'content-type': 'application/json', 'elevenlabs-signature': sig }, payload: body });
    expect((await send('t=1,v0=deadbeef')).statusCode).toBe(401);
    const sig = signElevenLabs(body, 'whsec_test');
    expect((await send(sig)).json()).toMatchObject({ ok: true });
    expect((await send(sig)).json()).toMatchObject({ duplicate: true });
    expect(await incidentState(env, ctx.incident_id)).toBe('AWAITING_DECISION');
    expect(await env.gw.db.c.decisions.countDocuments({ incident_id: ctx.incident_id })).toBe(0);
  });
});
