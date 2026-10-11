import type { Metric } from '../api';

export function KindBadge({ kind }: { kind: string }) {
  const cls = kind === 'MEASURED' ? 'b-ok' : kind === 'EXPECTED' ? 'b-neutral' : kind === 'ESTIMATE' ? 'b-accent' : 'b-warn';
  return <span className={`badge ${cls}`} title="Provenance of this value">{kind.toLowerCase()}</span>;
}

const STATE_CLASS: Record<string, string> = {
  RESOLVED: 'b-ok',
  SUBMITTED: 'b-accent',
  EXECUTING: 'b-accent',
  IN_CALL: 'b-accent',
  CALLING: 'b-accent',
  CALL_PENDING: 'b-neutral',
  AWAITING_DECISION: 'b-warn',
  AWAITING_CONFIRMATION: 'b-warn',
  DEFERRED: 'b-neutral',
  UNREACHED: 'b-bad',
  EXECUTION_FAILED: 'b-bad',
  HARNESS_REJECTED: 'b-bad',
  CLOSED_REJECTED: 'b-neutral',
};
export function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${STATE_CLASS[state] ?? 'b-neutral'}`}>{state.replaceAll('_', ' ').toLowerCase()}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const cls = severity === 'CRITICAL' || severity === 'HIGH' ? 'b-bad' : severity === 'MEDIUM' ? 'b-warn' : 'b-neutral';
  return <span className={`badge ${cls}`}>{severity}</span>;
}

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 90, h = 22;
  const min = Math.min(...values), max = Math.max(...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 2 - ((v - min) / Math.max(max - min, 1e-9)) * (h - 4)).toFixed(1)}`);
  return (
    <svg width={w} height={h} aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      <circle cx={pts.at(-1)!.split(',')[0]} cy={pts.at(-1)!.split(',')[1]} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

export function MetricsTable({ metrics, title }: { metrics: Metric[]; title?: string }) {
  if (!metrics.length) return <div className="muted">No metrics available from the harness.</div>;
  return (
    <table>
      {title && <caption className="small muted" style={{ textAlign: 'left' }}>{title}</caption>}
      <thead>
        <tr><th>Metric</th><th style={{ textAlign: 'right' }}>Value</th><th style={{ textAlign: 'right' }}>Expected</th><th>Kind</th><th>History</th><th>Measured / source</th></tr>
      </thead>
      <tbody>
        {metrics.map((m) => {
          const off = typeof m.value === 'number' && typeof m.expected === 'number' && Math.abs(m.value - m.expected) / Math.max(Math.abs(m.expected), 1e-9) > 0.1;
          return (
            <tr key={m.key + m.timestamp}>
              <td>{m.label}{m.note && <div className="small muted">{m.note}</div>}</td>
              <td className="num" style={{ color: off ? 'var(--bad)' : undefined }}>{m.value === null ? 'not recorded' : `${m.value} ${m.unit}`}</td>
              <td className="num">{m.expected === undefined ? '—' : `${m.expected} ${m.unit}`}</td>
              <td><KindBadge kind={m.kind} /></td>
              <td>{m.history && <span title={m.history.map((h) => `${h.label}: ${h.value}`).join(', ')}><Sparkline values={m.history.map((h) => h.value)} /></span>}</td>
              <td className="small muted"><span className="mono">{new Date(m.timestamp).toLocaleString()}</span><br />{m.source}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
