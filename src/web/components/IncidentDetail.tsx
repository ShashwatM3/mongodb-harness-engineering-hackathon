import { useEffect, useState } from 'react';
import { api, ApiError, fmtTime, type Aggregate, type Metric, type Trajectory } from '../api';
import { KindBadge, MetricsTable, StatusPill } from './bits';
import { DecisionPanel } from './DecisionPanel';
import { TrajectoryView } from './TrajectoryView';

const DECISION_TEXT = { APPROVE: 'Approved', REJECT: 'Rejected', DEFER: 'Not now', MODIFY: 'Changed' } as const;

export function IncidentDetail(props: { agg: Aggregate; trajectory: Trajectory | null; metrics: Metric[]; focus: { segment: string | null; at: number } | null; notify: (m: string) => void }) {
  const { agg, trajectory, metrics, focus, notify } = props;
  const focusSegment = focus?.segment ?? null;
  const i = agg.incident;
  const [showPath, setShowPath] = useState(false);
  // The voice agent asked to show the path: open it.
  useEffect(() => {
    if (focus) setShowPath(true);
  }, [focus?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const sent = agg.decisions.filter((d) => d.decision !== 'MODIFY');
  const call = agg.calls.at(-1);
  const callActive = call && ['QUEUED', 'RINGING', 'ANSWERED'].includes(call.status);

  return (
    <div className="detail">
      <div className="meta">
        <StatusPill state={agg.state} />
        <span>{i.robot_id}</span>
        <span className="muted">{fmtTime(i.timestamp)}</span>
        {i.synthetic && <span className="muted small">· simulated data</span>}
      </div>
      <h2 className="headline">{i.plain_summary ?? i.failure_summary}</h2>

      <DecisionPanel agg={agg} notify={notify} />

      {sent.length > 0 && (
        <section className="card">
          <div className="card-head"><h3>Sent to the supervisor</h3></div>
          {sent.map((d) => (
            <div key={d._id} className="feedback">
              <div className="row">
                <b>{DECISION_TEXT[d.decision]}</b>
                <span className="muted small">version {d.revision} · by {d.channel === 'VOICE' ? 'phone' : 'dashboard'} · {fmtTime(d.created_at)}</span>
                <span className="spacer" />
                <span className={`small ${d.submission.state === 'ACKED' ? 'good' : d.submission.state === 'FAILED' ? 'error' : 'muted'}`}>
                  {d.submission.state === 'ACKED' ? '✓ delivered' : d.submission.state === 'FAILED' ? 'delivery failed' : 'sending…'}
                </span>
              </div>
              {d.feedback && <p className="quote">“{d.feedback}”</p>}
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>Call</h3>
          <span className="muted small">{call ? callLabel(call.status, call.end_reason) : 'not called yet'}</span>
          <span className="spacer" />
          {!callActive && ['AWAITING_DECISION', 'DEFERRED', 'UNREACHED', 'CALL_PENDING'].includes(agg.state) && (
            <button className="ghost" onClick={() => api('POST', `/api/incidents/${agg.incident_id}/call`).then(() => notify('Calling you…'), (e: ApiError) => notify(e.message))}>
              Call me
            </button>
          )}
        </div>
        {call && call.transcript.length > 0 ? (
          <div className="transcript">
            {call.transcript.map((l, idx) => (
              <div key={idx} className={`bubble ${l.role === 'user' ? 'user' : 'agent'}`}>{l.text}</div>
            ))}
          </div>
        ) : (
          <p className="muted small">The conversation will appear here.</p>
        )}
      </section>

      {trajectory && (
        <section className="card">
          <div className="card-head">
            <h3>Robot path</h3>
            <span className="spacer" />
            <button className="link" onClick={() => setShowPath((v) => !v)}>{showPath ? 'Hide' : 'Show'}</button>
          </div>
          {showPath && <TrajectoryView trajectory={trajectory} focusSegment={focusSegment} />}
        </section>
      )}

      <details className="card more">
        <summary>Technical details</summary>
        <dl className="kv">
          <dt>What happened</dt><dd>{i.observed_behavior}</dd>
          <dt>Expected</dt><dd>{i.expected_behavior}</dd>
          <dt>Likely cause</dt><dd>{i.root_cause_hypothesis.text}{i.root_cause_hypothesis.confidence !== undefined && <span className="muted"> ({Math.round(i.root_cause_hypothesis.confidence * 100)}% confidence)</span>}</dd>
          <dt>Why you</dt><dd>{i.escalation.reason}</dd>
          <dt>Plan detail</dt><dd>{agg.revisions.at(-1)!.content.summary}<div className="muted small">{agg.revisions.at(-1)!.content.justification}</div></dd>
          <dt>Ids</dt><dd className="mono small">{agg.incident_id} · {i.task_id} · {i.category}</dd>
        </dl>
        {i.evidence_refs.length > 0 && (
          <>
            <h4>Evidence</h4>
            {i.evidence_refs.map((e) => (
              <p key={e.id} className="small"><KindBadge kind={e.kind} /> {e.summary} <span className="muted">— {e.source}</span></p>
            ))}
          </>
        )}
        {metrics.length > 0 && (
          <>
            <h4>Metrics</h4>
            <MetricsTable metrics={metrics} />
          </>
        )}
        <AskSupervisor agg={agg} notify={notify} />
        {agg.revisions.length > 1 && (
          <>
            <h4>Plan versions</h4>
            {agg.revisions.map((r) => (
              <p key={r.revision} className="small">
                <b>v{r.revision}</b> {r.content.plain_summary ?? r.content.summary} <span className="muted">— {r.source === 'SUPERVISOR' ? 'supervisor' : r.source === 'HUMAN_VOICE' ? 'you, by phone' : 'you, on dashboard'}</span>
              </p>
            ))}
          </>
        )}
        <h4>Activity</h4>
        <ul className="log">
          {[...agg.audit].reverse().slice(0, 60).map((a) => (
            <li key={a.id}><span className="mono small muted">{fmtTime(a.at)}</span> {a.type.replaceAll('.', ' ').replaceAll('_', ' ')}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function callLabel(status: string, reason: string | null) {
  if (status === 'RINGING') return 'ringing…';
  if (status === 'ANSWERED') return 'on the call';
  if (status === 'NO_ANSWER') return 'no answer';
  if (status === 'DECLINED') return 'declined';
  if (status === 'ENDED') return `ended${reason ? ` (${reason})` : ''}`;
  return status.toLowerCase();
}

function AskSupervisor({ agg, notify }: { agg: Aggregate; notify: (m: string) => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h4>Questions to the supervisor</h4>
      {agg.queries.map((x) => (
        <div key={x._id} className="small qa">
          <b>{x.question}</b>
          <div>{x.result?.answer ?? x.result?.limitations ?? (x.status === 'PENDING' ? 'Thinking…' : '—')}</div>
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
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask something…" style={{ flex: 1 }} />
        <button className="ghost" disabled={busy || q.length < 3}>Ask</button>
      </form>
    </>
  );
}
