import { useState } from 'react';
import { api, ApiError, fmtTime, type Aggregate, type Metric, type Trajectory } from '../api';
import { KindBadge, MetricsTable, SeverityBadge, StateBadge } from './bits';
import { ProposalPanel } from './ProposalPanel';
import { TrajectoryView } from './TrajectoryView';

const EXEC_CLASS: Record<string, string> = { APPLIED: 'b-ok', FAILED: 'b-bad', CANCELLED: 'b-bad', REJECTED_BY_HARNESS: 'b-bad' };

export function IncidentDetail(props: {
  agg: Aggregate;
  trajectory: Trajectory | null;
  metrics: Metric[];
  focusSegment: string | null;
  notify: (m: string) => void;
}) {
  const { agg, trajectory, metrics, focusSegment, notify } = props;
  const i = agg.incident;
  const approval = agg.decisions.find((d) => d.decision === 'APPROVE');
  const exec = approval?.submission.execution_id ? agg.executions.find((e) => e._id === approval.submission.execution_id) : undefined;
  const activeCall = agg.calls.find((c) => ['QUEUED', 'RINGING', 'ANSWERED'].includes(c.status));

  return (
    <div>
      <StatusBanner agg={agg} execStatus={exec?.status} />
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{i.failure_summary}</h2>
      </div>
      <div className="grid">
        <div className="card c7">
          <h2>What happened</h2>
          <dl className="kv">
            <dt>Incident</dt><dd className="mono">{agg.incident_id}</dd>
            <dt>State</dt><dd><StateBadge state={agg.state} /></dd>
            <dt>Severity</dt><dd><SeverityBadge severity={i.severity} /> <span className="mono small">{i.category}</span> {i.synthetic && <span className="badge b-warn">SYNTHETIC DATA</span>}</dd>
            <dt>Robot / task</dt><dd className="mono">{i.robot_id} · {i.task_id}</dd>
            <dt>Observed</dt><dd>{i.observed_behavior}</dd>
            <dt>Expected</dt><dd>{i.expected_behavior}</dd>
            <dt>Diagnosis</dt><dd><KindBadge kind="HYPOTHESIS" /> {i.root_cause_hypothesis.text}{i.root_cause_hypothesis.confidence !== undefined && <b> ({Math.round(i.root_cause_hypothesis.confidence * 100)}% confidence)</b>}</dd>
            <dt>Escalated because</dt><dd>{i.escalation.reason}</dd>
            <dt>Supervisor</dt><dd>{i.responsible_supervisor.name} <span className="mono small muted">{i.responsible_supervisor.id}</span></dd>
          </dl>
        </div>
        <div className="card c5">
          <h2>Evidence</h2>
          {i.evidence_refs.length === 0 && <div className="muted">No evidence attached.</div>}
          {i.evidence_refs.map((e) => (
            <div key={e.id} style={{ marginBottom: 8 }}>
              <KindBadge kind={e.kind} /> {e.summary}
              <div className="small muted mono">{e.id} · {e.source} · {fmtTime(e.timestamp)}</div>
            </div>
          ))}
          <AskSupervisor agg={agg} notify={notify} />
        </div>

        <div className="card c6">
          <h2>Trajectory</h2>
          <TrajectoryView trajectory={trajectory} focusSegment={focusSegment} />
        </div>
        <div className="card c6">
          <h2>Proposed correction</h2>
          <ProposalPanel agg={agg} notify={notify} />
        </div>

        <div className="card c12">
          <h2>Metrics</h2>
          <MetricsTable metrics={metrics} />
        </div>

        <div className="card c6">
          <h2>Decision & execution</h2>
          {agg.decisions.length === 0 && <div className="muted">No decision recorded. Nothing has been sent to the harness.</div>}
          <table>
            <tbody>
              {agg.decisions.map((d) => (
                <tr key={d._id}>
                  <td className="mono small">{fmtTime(d.created_at)}</td>
                  <td><b>{d.decision.replaceAll('_', ' ')}</b> rev {d.revision}<div className="small muted">{d.channel.toLowerCase()} · {d.confirmation.status.toLowerCase().replaceAll('_', ' ')}{d.confirmation.utterance ? ` · “${d.confirmation.utterance}”` : ''}</div></td>
                  <td className="small">harness delivery: <b>{d.submission.state.toLowerCase()}</b>{d.submission.last_error && <div className="muted">{d.submission.last_error}</div>}{d.submission.harness_reason && <div className="muted">{d.submission.harness_reason}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {exec && (
            <>
              <div className="row" style={{ marginTop: 10 }}>
                <b>Harness execution</b> <span className={`badge ${EXEC_CLASS[exec.status] ?? 'b-accent'}`}>{exec.status}</span>
                <span className="mono small muted">{exec._id}</span>
              </div>
              <ul className="timeline" style={{ marginTop: 6 }}>
                {exec.events.map((e) => (
                  <li key={e.seq}><span className="mono small">{fmtTime(e.timestamp)}</span><span><b>{e.status}</b> <span className="muted">{e.detail}</span></span></li>
                ))}
              </ul>
              {exec.result_metrics && exec.result_metrics.length > 0 && <div style={{ marginTop: 8 }}><MetricsTable metrics={exec.result_metrics} title="Effect reported by the harness after the change" /></div>}
            </>
          )}
        </div>

        <div className="card c6">
          <div className="row" style={{ marginBottom: 6 }}>
            <h2 style={{ margin: 0 }}>Calls</h2>
            <span className="spacer" />
            <button
              disabled={!!activeCall || !['AWAITING_DECISION', 'DEFERRED', 'UNREACHED', 'CALL_PENDING'].includes(agg.state)}
              onClick={() => api('POST', `/api/incidents/${agg.incident_id}/call`).then(() => notify('Calling supervisor'), (e: ApiError) => notify(e.message))}
            >
              Call supervisor again
            </button>
          </div>
          {agg.calls.length === 0 && <div className="muted">No call yet.</div>}
          {agg.calls.map((c) => (
            <details key={c._id} open={c === agg.calls.at(-1)}>
              <summary>
                <span className="mono small">{fmtTime(c.created_at)}</span> attempt {c.attempt} · <b>{c.status.toLowerCase()}</b>
                {c.identity_verified && <span className="badge b-ok" style={{ marginLeft: 6 }}>identity verified</span>}
                {c.end_reason && <span className="small muted"> · {c.end_reason}</span>}
              </summary>
              <div className="transcript">
                {c.transcript.map((l, idx) => (
                  <div key={idx} className={`bubble ${l.role === 'user' ? 'user' : 'agent'}`}>{l.text}</div>
                ))}
              </div>
              {c.post_call && <div className="small muted">Post-call summary (informational): {String((c.post_call as { transcript_summary?: string }).transcript_summary ?? '—')}</div>}
            </details>
          ))}
        </div>

        <div className="card c12">
          <h2>Audit log</h2>
          <ul className="timeline" style={{ maxHeight: 260, overflow: 'auto' }}>
            {[...agg.audit].reverse().map((a) => (
              <li key={a.id}>
                <span className="mono small">{fmtTime(a.at)}</span>
                <span><b>{a.type}</b> <span className="badge b-neutral">{a.actor}</span> <span className="mono small muted">{JSON.stringify(a.data).slice(0, 220)}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function StatusBanner({ agg, execStatus }: { agg: Aggregate; execStatus?: string }) {
  const s = agg.state;
  if (s === 'RESOLVED') return <div className="banner ok">Change applied — confirmed by the harness ({execStatus}).</div>;
  if (s === 'EXECUTION_FAILED') return <div className="banner bad">The harness tried to apply the approved change and it FAILED. See execution detail.</div>;
  if (s === 'HARNESS_REJECTED') return <div className="banner bad">The harness refused the approved change during validation.</div>;
  if (s === 'SUBMITTED' || s === 'EXECUTING') return <div className="banner info">Approved and sent to the harness — not applied until the harness confirms.</div>;
  if (s === 'AWAITING_CONFIRMATION') return <div className="banner warn">High-risk approval waiting for dashboard confirmation.</div>;
  if (s === 'UNREACHED') return <div className="banner bad">Supervisor could not be reached by phone. Decide here or call again.</div>;
  if (s === 'CLOSED_REJECTED') return <div className="banner info">Proposal rejected. Nothing was executed.</div>;
  if (s === 'AWAITING_DECISION') return <div className="banner warn">Awaiting a decision. No decision is inferred from a call ending.</div>;
  return null;
}

function AskSupervisor({ agg, notify }: { agg: Aggregate; notify: (m: string) => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 12 }}>
      <h2>Questions to the supervisor</h2>
      {agg.queries.map((x) => (
        <div key={x._id} style={{ marginBottom: 8 }}>
          <div><span className="badge b-neutral">{x.channel.toLowerCase()}</span> <b>{x.question}</b></div>
          <div className="small">
            <span className={`badge ${x.status === 'ANSWERED' ? 'b-ok' : x.status === 'PENDING' ? 'b-accent' : 'b-warn'}`}>{x.status.toLowerCase().replaceAll('_', ' ')}</span>{' '}
            {x.result?.answer ?? x.result?.limitations ?? '…'}
            {x.result?.evidence_refs?.length ? <span className="mono muted"> [{x.result.evidence_refs.join(', ')}]</span> : null}
          </div>
        </div>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          api('POST', `/api/incidents/${agg.incident_id}/questions`, { question: q })
            .then(() => setQ(''), (err: ApiError) => notify(err.message))
            .finally(() => setBusy(false));
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the supervisor…" style={{ flex: 1 }} />
        <button disabled={busy || q.length < 3}>Ask</button>
      </form>
    </div>
  );
}
