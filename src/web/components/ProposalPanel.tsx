import { useEffect, useState } from 'react';
import { api, ApiError, fmtTime, type Aggregate, type Change, type Revision } from '../api';

const DECIDABLE = ['CALL_PENDING', 'CALLING', 'IN_CALL', 'AWAITING_DECISION', 'DEFERRED', 'UNREACHED'];

export function ProposalPanel({ agg, notify }: { agg: Aggregate; notify: (msg: string) => void }) {
  const latest = agg.revisions.at(-1)!;
  const p = latest.content;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<number>(latest.revision);

  useEffect(() => {
    setDraft(Object.fromEntries(p.editable_parameters.map((s) => [s.key, String(s.proposed_value)])));
    setViewing(latest.revision);
    setError(null);
  }, [latest.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const decidable = DECIDABLE.includes(agg.state) && agg.head?.state === 'UNDER_REVIEW';
  const held = agg.decisions.find((d) => d.confirmation.status === 'PENDING_SECOND_FACTOR');

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      notify(ok);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changes: Change[] = p.editable_parameters
    .filter((s) => draft[s.key] !== undefined && draft[s.key] !== String(s.proposed_value))
    .map((s) => ({ op: 'set_param', key: s.key, value: s.type === 'boolean' ? draft[s.key] === 'true' : s.type === 'enum' ? draft[s.key] : Number(draft[s.key]), unit: s.unit }));

  const decide = (decision: string) =>
    run(
      () =>
        api('POST', `/api/incidents/${agg.incident_id}/decisions`, {
          revision: latest.revision,
          decision,
          reason: rationale || undefined,
          idempotency_key: `dash-${agg.incident_id}-${latest.revision}-${decision}-${crypto.randomUUID()}`,
        }),
      `${decision.replaceAll('_', ' ').toLowerCase()} recorded for revision ${latest.revision}`,
    );

  const shown = agg.revisions.find((r) => r.revision === viewing) ?? latest;

  return (
    <div>
      {held && (
        <div className="banner warn row">
          <span>High-risk approval of revision {held.revision} given by voice is held. Confirm here to send it to the harness.</span>
          <span className="spacer" />
          <button className="ok" disabled={busy} onClick={() => run(() => api('POST', `/api/decisions/${held._id}/confirm`), 'Approval confirmed and queued')}>
            Confirm approval
          </button>
        </div>
      )}
      {agg.head?.state === 'RECONCILING' && <div className="banner info">A modification is being reconciled with the supervisor…</div>}

      <div className="row" style={{ marginBottom: 6 }}>
        <span className="badge b-accent mono">rev {latest.revision}</span>
        <span className={`badge ${p.risk === 'HIGH' ? 'b-bad' : p.risk === 'MEDIUM' ? 'b-warn' : 'b-neutral'}`}>risk {p.risk}</span>
        <span className="small muted">by {latest.source.replace('_', ' ').toLowerCase()} · {fmtTime(latest.created_at)}</span>
        <span className="spacer" />
        <span className="small muted">status: {agg.head?.state === 'DECIDED' ? `${agg.head.decision} (rev ${agg.head.decided_revision})` : agg.head?.state}</span>
      </div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.summary}</div>
      <div className="small muted" style={{ marginBottom: 8 }}>{p.justification}</div>
      {p.constraints.length > 0 && <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>{p.constraints.map((c) => <li key={c}>{c}</li>)}</ul>}

      <table>
        <thead><tr><th>Parameter</th><th style={{ textAlign: 'right' }}>Current</th><th style={{ textAlign: 'right' }}>Proposed</th><th>New value</th></tr></thead>
        <tbody>
          {p.editable_parameters.map((s) => (
            <tr key={s.key}>
              <td>{s.label}<div className="mono small muted">{s.key}</div><div className="small muted">allowed {s.min ?? '−∞'} … {s.max ?? '∞'} {s.unit}</div></td>
              <td className="num">{String(s.current_value)} {s.unit}</td>
              <td className="num" style={{ fontWeight: s.proposed_value !== s.current_value ? 700 : 400 }}>{String(s.proposed_value)} {s.unit}</td>
              <td>
                {s.type === 'enum' ? (
                  <select disabled={!decidable} value={draft[s.key] ?? ''} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}>
                    {s.enum_values?.map((v) => <option key={v}>{v}</option>)}
                  </select>
                ) : (
                  <input
                    disabled={!decidable}
                    style={{ width: 90 }}
                    type={s.type === 'boolean' ? 'text' : 'number'}
                    step={s.type === 'integer' ? 1 : 'any'}
                    min={s.min}
                    max={s.max}
                    value={draft[s.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 10 }}>
        <input placeholder="Rationale / reason (recorded in the audit log)" value={rationale} onChange={(e) => setRationale(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <button
          disabled={!decidable || busy || changes.length === 0 || !rationale}
          onClick={() => run(() => api('POST', `/api/incidents/${agg.incident_id}/revisions`, { base_revision: latest.revision, changes, rationale }), 'Revision requested')}
          title={!rationale ? 'Enter a rationale first' : ''}
        >
          Request revision ({changes.length} change{changes.length === 1 ? '' : 's'})
        </button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="ok" disabled={!decidable || busy} onClick={() => window.confirm(`Approve revision ${latest.revision}?\n\n${p.summary}\n\nThe harness will validate and execute it.`) && decide('APPROVE')}>
          Approve rev {latest.revision}
        </button>
        <button className="bad" disabled={!decidable || busy} onClick={() => window.confirm(`Reject revision ${latest.revision}?`) && decide('REJECT')}>
          Reject rev {latest.revision}
        </button>
        <button disabled={!decidable || busy} onClick={() => decide('REQUEST_MORE_INFORMATION')}>Request more info</button>
        <button disabled={!decidable || busy} onClick={() => decide('DEFER')}>Defer</button>
      </div>
      {error && <div className="banner bad" style={{ marginTop: 8 }}>{error}</div>}

      <h2 style={{ marginTop: 14 }}>Revision history</h2>
      <div className="row" style={{ marginBottom: 6 }}>
        {agg.revisions.map((r) => (
          <button key={r.revision} className={viewing === r.revision ? 'primary' : ''} onClick={() => setViewing(r.revision)}>
            rev {r.revision} <span className="small">{r.status.toLowerCase().replace('_', ' ')}</span>
          </button>
        ))}
      </div>
      <RevisionDiff rev={shown} prev={agg.revisions.find((r) => r.revision === (shown.based_on_revision ?? -1))} />
    </div>
  );
}

function RevisionDiff({ rev, prev }: { rev: Revision; prev?: Revision }) {
  const rows = rev.content.editable_parameters.map((s) => {
    const before = prev?.content.editable_parameters.find((x) => x.key === s.key)?.proposed_value;
    return { s, before, changed: prev !== undefined && before !== s.proposed_value };
  });
  return (
    <div className="small">
      <div>
        <b>rev {rev.revision}</b> · {rev.source.toLowerCase().replace('_', ' ')} · requested by {rev.requested_by} · {fmtTime(rev.created_at)}
        {rev.request && <div className="muted">Rationale: “{rev.request.rationale}”</div>}
      </div>
      <table style={{ marginTop: 4 }}>
        <tbody>
          {rows.map(({ s, before, changed }) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td className="num">{prev ? `${String(before)} → ` : ''}<b style={{ color: changed ? 'var(--accent)' : undefined }}>{String(s.proposed_value)}</b> {s.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
