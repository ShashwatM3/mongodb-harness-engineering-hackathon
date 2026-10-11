import type { IncidentDoc } from '../db';
import { buildBriefing } from '../domain/briefing';
import type { ProposalEngine } from '../domain/proposals';
import type { HarnessAdapter } from '../harness/adapter';

export type CallVariables = Record<string, string | number | boolean>;

/**
 * The ElevenLabs dynamic variables for one call — identical for the browser softphone and a real phone call: ids that bind
 * tool calls to this incident/call, the spoken opening (incident + plan in 1–2 sentences each) and the full context.
 */
export async function buildCallVariables(
  deps: { proposals: ProposalEngine; harness: HarnessAdapter },
  inc: IncidentDoc,
  call_id: string,
): Promise<CallVariables> {
  const { head, revision } = await deps.proposals.current(inc._id);
  const [metrics, trajectory] = await Promise.all([
    deps.harness.getMetrics(inc.incident).catch(() => []),
    deps.harness.getTrajectory(inc.incident).catch(() => null),
  ]);
  const brief = buildBriefing(inc.incident, revision.content, head.latest_revision, metrics, trajectory);
  return {
    incident_id: inc._id,
    call_id,
    supervisor_name: inc.incident.responsible_supervisor.name,
    current_revision: head.latest_revision,
    incident_brief: brief.incident_brief,
    proposal_brief: brief.proposal_brief,
    incident_context: brief.incident_context,
  };
}
