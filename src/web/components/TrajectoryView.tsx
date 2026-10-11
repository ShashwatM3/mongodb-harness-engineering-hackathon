import { useEffect, useMemo, useState } from 'react';
import type { Trajectory } from '../api';
import { KindBadge } from './bits';

const W = 760;
const H = 380;
const PAD = 28;

/** Normalised 2D view of planned vs actual path. 3D/ROS trajectories should use metadata.viewer_url instead. */
export function TrajectoryView({ trajectory, focusSegment }: { trajectory: Trajectory | null; focusSegment: string | null }) {
  const [segment, setSegment] = useState<string | null>(null);
  const [t, setT] = useState<number | null>(null);
  useEffect(() => {
    if (focusSegment !== null) setSegment(focusSegment);
  }, [focusSegment]);

  const geo = useMemo(() => {
    if (!trajectory) return null;
    const pts = [...trajectory.planned, ...trajectory.actual];
    const xs = [...pts.map((p) => p.x), ...trajectory.zones.flatMap((z) => [z.x, z.x + z.w])];
    const ys = [...pts.map((p) => p.y), ...trajectory.zones.flatMap((z) => [z.y, z.y + z.h])];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const s = Math.min((W - 2 * PAD) / Math.max(maxX - minX, 1), (H - 2 * PAD) / Math.max(maxY - minY, 1));
    const sx = (x: number) => PAD + (x - minX) * s;
    const sy = (y: number) => H - PAD - (y - minY) * s; // y up
    return { sx, sy, s, minX, maxX };
  }, [trajectory]);

  if (!trajectory || !geo) {
    return <div className="muted">The harness has no trajectory for this incident (for example, a manipulation or sequencing issue). Nothing is drawn rather than guessing a path.</div>;
  }
  const { sx, sy, s } = geo;
  const line = (ps: { x: number; y: number }[]) => ps.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const seg = trajectory.segments.find((x) => x.id === segment) ?? null;
  const inSeg = seg ? trajectory.actual.filter((p) => p.t >= seg.t_start && p.t <= seg.t_end) : [];
  const tMax = trajectory.actual.at(-1)?.t ?? 0;
  const cursor = t === null ? null : interpolate(trajectory.actual, t);

  return (
    <div className="traj">
      <div className="row" style={{ marginBottom: 8 }}>
        <button className={segment === null ? 'primary' : ''} onClick={() => setSegment(null)}>All</button>
        {trajectory.segments.map((x) => (
          <button key={x.id} className={segment === x.id ? 'primary' : ''} onClick={() => setSegment(x.id)}>
            {x.label} <span className="mono small">{x.t_start}–{x.t_end}s</span>
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Planned and actual trajectory">
        {trajectory.zones.map((z) => (
          <g key={z.label}>
            <rect
              x={sx(z.x)} y={sy(z.y + z.h)} width={z.w * s} height={z.h * s}
              rx={z.kind === 'person' ? (z.w * s) / 2 : 3}
              fill={z.kind === 'person' ? 'var(--bad)' : z.kind === 'robot' ? 'var(--warn)' : z.kind === 'fixture' ? 'var(--muted)' : 'var(--accent-soft)'}
              opacity={z.kind === 'area' ? 0.6 : 0.85}
            />
            <text x={sx(z.x)} y={sy(z.y + z.h) - 4} fontSize="11" fill="var(--muted)">{z.label}</text>
          </g>
        ))}
        <polyline points={line(trajectory.planned)} fill="none" stroke="var(--planned)" strokeWidth="2" strokeDasharray="6 5" />
        <polyline points={line(trajectory.actual)} fill="none" stroke="var(--actual)" strokeWidth="2.5" />
        {inSeg.length > 1 && <polyline points={line(inSeg)} fill="none" stroke="var(--warn)" strokeWidth="6" opacity="0.55" />}
        {trajectory.deviations.map((d, i) => (
          <g key={i}>
            <circle cx={sx(d.x)} cy={sy(d.y)} r="6" fill="var(--bad)" stroke="var(--panel)" strokeWidth="2" />
            <text x={sx(d.x) + 8} y={sy(d.y) + (i % 2 ? 18 : -10)} fontSize="11" fill="var(--bad)" fontFamily="var(--mono)">
              t={d.t}s · {d.magnitude_m} m
            </text>
          </g>
        ))}
        {cursor && <circle cx={sx(cursor.x)} cy={sy(cursor.y)} r="7" fill="none" stroke="var(--text)" strokeWidth="2" />}
        <g fontSize="11" fill="var(--muted)">
          <line x1={W - 170} y1={16} x2={W - 145} y2={16} stroke="var(--planned)" strokeWidth="2" strokeDasharray="6 5" />
          <text x={W - 140} y={20}>planned</text>
          <line x1={W - 85} y1={16} x2={W - 60} y2={16} stroke="var(--actual)" strokeWidth="2.5" />
          <text x={W - 55} y={20}>actual</text>
        </g>
      </svg>
      <p className="small muted" style={{ marginTop: 8 }}>Dashed: planned path · solid: what the robot did · red dots: where it went off course.</p>
      <div className="small muted" style={{ marginTop: 6 }}>Source: {trajectory.source} · frame {trajectory.frame}{trajectory.viewer_url ? <> · <a href={trajectory.viewer_url}>open specialised viewer</a></> : null}</div>
    </div>
  );
}

function interpolate(ps: { t: number; x: number; y: number }[], t: number) {
  if (!ps.length) return null;
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1], b = ps[i];
    if (t <= b.t) {
      const f = (t - a.t) / Math.max(b.t - a.t, 1e-9);
      return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
    }
  }
  return ps[ps.length - 1];
}
