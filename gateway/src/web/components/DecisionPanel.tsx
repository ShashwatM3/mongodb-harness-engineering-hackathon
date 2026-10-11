import { useEffect, useState } from 'react';
import { api, ApiError, type Aggregate, type Change } from '../api';

const OPEN = ['CALL_PENDING', 'CALLING', 'IN_CALL', 'AWAITING_DECISION', 'UNREACHED', 'DEFERRED'];

/** The proposed fix in plain words, and the three things a human can do with it. */
export function DecisionPanel({ agg, notify }: { agg: Aggregate; notify: (msg: string) => void }) {
  const latest = agg.revisions.at(-1)!;
  const plan = latest.content;
  const changed = plan.editable_parameters.filter((p) => p.proposed_value !== p.current_value);
  const open = OPEN.includes(agg.state) && agg.head?.state === 'UNDER_REVIEW';

  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(Object.fromEntries(plan.editable_parameters.map((p) => [p.key, String(p.proposed_value)])));
    setEditing(false);
    setError(null);
  }, [latest.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      notify(ok);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = (decision: 'APPROVE' | 'REJECT' | 'DEFER') =>
    run(
      () =>
        api('POST', `/api/incidents/${agg.incident_id}/decisions`, {
          revision: latest.revision,
          decision,
          feedback: feedback || undefined,
          idempotency_key: `dash-${agg.incident_id}-${latest.revision}-${decision}-${crypto.randomUUID()}`,
        }),
      decision === 'APPROVE' ? 'Approved — feedback sent to the supervisor' : decision === 'REJECT' ? 'Rejected — feedback sent to the supervisor' : 'Postponed',
    );

  const edits: Change[] = plan.editable_parameters
    .filter((p) => draft[p.key] !== undefined && draft[p.key] !== String(p.proposed_value))
    .map((p) => ({ op: 'set_param', key: p.key, value: p.type === 'enum' ? draft[p.key] : Number(draft[p.key]), unit: p.unit }));

  return (
    <section className="card">
      <div className="card-head">
        <h3>Proposed fix</h3>
        <span className="muted small">version {latest.revision}{latest.source !== 'SUPERVISOR' ? ' · changed by you' : ''}</span>
      </div>
      <p className="lead">{plan.plain_summary ?? plan.summary}</p>

      {changed.length > 0 && (
        <div className="changes">
          {changed.map((p) => (
            <div key={p.key} className="change">
              <span>{p.label}</span>
              <span className="mono">
                {String(p.current_value)} → <b>{String(p.proposed_value)}</b> {p.unit}
              </span>
            </div>
          ))}
        </div>
      )}

      {open && (
        <>
          {editing ? (
            <div className="edit">
              {plan.editable_parameters.map((p) => (
                <label key={p.key} className="edit-row">
                  <span>{p.label}</span>
                  <input type="number" step="any" min={p.min} max={p.max} value={draft[p.key] ?? ''} onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })} />
                  <span className="muted small">{p.unit} · {p.min}–{p.max}</span>
                </label>
              ))}
              <div className="row">
                <button
                  className="primary"
                  disabled={busy || edits.length === 0}
                  onClick={() =>
                    run(() => api('POST', `/api/incidents/${agg.incident_id}/revisions`, { base_revision: latest.revision, changes: edits, rationale: feedback || 'Changed on the dashboard.' }), 'Plan updated')
                  }
                >
                  Update plan
                </button>
                <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="link" onClick={() => setEditing(true)}>Change a value…</button>
          )}

          <textarea placeholder="Feedback for the supervisor (optional)" value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} />
          <div className="row actions">
            <button className="ok" disabled={busy} onClick={() => decide('APPROVE')}>Approve</button>
            <button className="bad" disabled={busy} onClick={() => decide('REJECT')}>Reject</button>
            <button className="ghost" disabled={busy} onClick={() => decide('DEFER')}>Not now</button>
          </div>
        </>
      )}
      {agg.head?.state === 'RECONCILING' && <p className="muted small">Checking the change with the supervisor…</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
