import type { IncidentInput, Metric, ProposalContent, Trajectory } from '../../shared/schemas';

/**
 * Builds what the voice agent knows at the start of a call, from whatever the harness provided — no per-category code.
 *  - incident_brief / proposal_brief: the 1–2 sentence plain-language opening (harness `plain_summary`, else the
 *    technical summary).
 *  - incident_context: everything else, as readable text, so follow-up questions can be answered without a tool call.
 */
export function buildBriefing(inc: IncidentInput, plan: ProposalContent, revision: number, metrics: Metric[], trajectory: Trajectory | null) {
  const incident_brief = oneOrTwoSentences(inc.plain_summary ?? inc.failure_summary);
  const proposal_brief = oneOrTwoSentences(plan.plain_summary ?? plan.summary);
  const pct = (c?: number) => (c === undefined ? '' : `, ${Math.round(c * 100)}% confidence`);
  const val = (m: Metric) => (m.value === null ? 'not recorded' : `${m.value} ${m.unit}`.trim());

  const lines: string[] = [
    `INCIDENT${inc.synthetic ? ' (synthetic data from simulated runs)' : ''}`,
    `- Robot ${inc.robot_id}, task ${inc.task_id}, category ${inc.category}, severity ${inc.severity}.`,
    `- What happened: ${inc.observed_behavior}`,
    `- What should have happened: ${inc.expected_behavior}`,
    `- Supervisor's diagnosis (a hypothesis${pct(inc.root_cause_hypothesis.confidence)}): ${inc.root_cause_hypothesis.text}`,
    `- Why the human is being asked: ${inc.escalation.reason}`,
  ];
  if (inc.evidence_refs.length) {
    lines.push('EVIDENCE');
    for (const e of inc.evidence_refs) lines.push(`- (${e.kind.toLowerCase()}) ${e.summary} [${e.source}]`);
  }
  if (metrics.length) {
    lines.push('METRICS');
    for (const m of metrics) {
      const exp = m.expected === undefined ? '' : `; expected ${m.expected} ${m.unit}`.trimEnd();
      const hist = m.history?.length ? `; history ${m.history.map((h) => `${h.label} ${h.value}`).join(', ')}` : '';
      lines.push(`- ${m.label}: ${val(m)} (${m.kind.toLowerCase()}${exp}${hist})${m.note ? ` — ${m.note}` : ''}`);
    }
  }
  if (trajectory) {
    lines.push('TRAJECTORY (also viewable on the dashboard)');
    for (const d of trajectory.deviations) lines.push(`- at ${d.t} s: ${d.description} (${d.magnitude_m} m, ${d.kind.toLowerCase()})`);
  }
  lines.push(`CURRENT PLAN — revision ${revision}, risk ${plan.risk.toLowerCase()}`);
  lines.push(`- ${plan.summary}`);
  for (const p of plan.editable_parameters) {
    const range = p.min !== undefined || p.max !== undefined ? `; allowed ${p.min ?? '…'} to ${p.max ?? '…'} ${p.unit}` : '';
    lines.push(`- ${p.label} [key ${p.key}]: currently ${p.current_value} ${p.unit}, plan ${p.proposed_value} ${p.unit}${range}`);
  }
  lines.push(`- Why: ${plan.justification}`);
  for (const c of plan.constraints) lines.push(`- Constraint: ${c}`);

  return { incident_brief, proposal_brief, incident_context: lines.join('\n') };
}

/** First two sentences. A sentence ends at . ! or ? followed by whitespace (or the end) — not at a decimal point like 0.45. */
export function oneOrTwoSentences(text: string): string {
  const parts = text.trim().split(/(?<=[.!?])\s+/);
  return parts.slice(0, 2).join(' ').trim();
}
