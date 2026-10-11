import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtTime, type Aggregate, type IncidentRow, type Metric, type ServerEvent, type Trajectory } from './api';
import { IncidentDetail } from './components/IncidentDetail';
import { SeverityBadge, StateBadge } from './components/bits';
import { Softphone, type Ringing } from './components/Softphone';

interface Config {
  harness: string;
  call_mode: string;
  elevenlabs_configured: boolean;
  scenarios: Array<{ name: string; title: string; description: string }>;
}

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [rows, setRows] = useState<IncidentRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [agg, setAgg] = useState<Aggregate | null>(null);
  const [trajectory, setTrajectory] = useState<Trajectory | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [focus, setFocus] = useState<{ incident: string; segment: string | null } | null>(null);
  const [ring, setRing] = useState<Ringing | null>(null);
  /** Call answered in this tab; other tabs dismiss their ringing card when the call is answered elsewhere. */
  const answeredHere = useRef<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const selRef = useRef<string | null>(null);
  selRef.current = selected;

  const notify = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 3500);
  }, []);

  const loadList = useCallback(() => api<IncidentRow[]>('GET', '/api/incidents').then(setRows).catch(() => {}), []);
  const loadDetail = useCallback(async (id: string) => {
    const a = await api<Aggregate>('GET', `/api/incidents/${id}`);
    if (selRef.current === id) setAgg(a);
  }, []);

  useEffect(() => {
    void api<Config>('GET', '/api/config').then(setConfig);
    void loadList();
  }, [loadList]);

  useEffect(() => {
    setAgg(null);
    setTrajectory(null);
    setMetrics([]);
    if (!selected) return;
    void loadDetail(selected);
    void api<{ trajectory: Trajectory | null }>('GET', `/api/incidents/${selected}/trajectory`).then((r) => selRef.current === selected && setTrajectory(r.trajectory));
    void api<{ metrics: Metric[] }>('GET', `/api/incidents/${selected}/metrics`).then((r) => selRef.current === selected && setMetrics(r.metrics));
  }, [selected, loadDetail]);

  // Live sync: every committed state change arrives as an event; the UI re-reads authoritative state.
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let pending: number | null = null;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as ServerEvent;
      if (e.type === 'call.ringing') {
        setRing({ call_id: e.data.call_id, incident_id: e.incident_id!, supervisor: e.data.supervisor, severity: e.data.severity, robot_id: e.data.robot_id, summary: e.data.summary, ring_deadline: e.data.ring_deadline });
      }
      if (['call.no_answer', 'call.declined', 'call.failed'].includes(e.type)) setRing((r) => (r && r.call_id === e.data.call_id ? null : r));
      if (e.type === 'call.answered' && answeredHere.current !== e.data.call_id) setRing((r) => (r && r.call_id === e.data.call_id ? null : r));
      if (e.type === 'trajectory.focus') {
        setSelected(e.incident_id);
        setFocus({ incident: e.incident_id!, segment: e.data.segment_id ?? null });
        notify('Voice agent highlighted the trajectory');
      }
      if (e.type === 'proposal.revised') notify(`New proposal revision ${e.data.revision} (${e.actor.toLowerCase()})`);
      if (e.type === 'execution.updated') notify(`Harness: ${e.data.status}`);
      if (pending) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        void loadList();
        if (selRef.current && (!e.incident_id || e.incident_id === selRef.current)) void loadDetail(selRef.current);
      }, 120);
    };
    return () => es.close();
  }, [loadList, loadDetail, notify]);

  const trigger = async (name: string) => {
    const r = await api<{ incident_id: string }>('POST', `/dev/scenarios/${name}/trigger`);
    setSelected(r.incident_id);
    notify(`Supervisor raised incident ${r.incident_id}`);
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Robotics Intervention Gateway</h1>
        <span className={`badge ${connected ? 'b-ok' : 'b-bad'}`}>{connected ? 'live' : 'disconnected'}</span>
        {config && (
          <span className="small muted">
            harness: {config.harness} · calls: {config.call_mode} · voice: {config.elevenlabs_configured ? 'ElevenLabs' : 'not configured'}
          </span>
        )}
        <span className="spacer" />
        {config?.scenarios.length ? <span className="small muted">Simulate supervisor trigger:</span> : null}
        {config?.scenarios.map((s) => (
          <button key={s.name} title={s.description} onClick={() => void trigger(s.name)}>
            {s.name} · {s.title.split(' ').slice(0, 2).join(' ')}
          </button>
        ))}
      </header>
      <aside className="sidebar">
        {rows.length === 0 && <div className="muted" style={{ padding: 14 }}>No incidents yet. Trigger a scenario or POST to /v1/incidents.</div>}
        {rows.map((r) => (
          <div key={r.incident_id} className={`inc ${selected === r.incident_id ? 'sel' : ''}`} onClick={() => setSelected(r.incident_id)}>
            <div className="row">
              <SeverityBadge severity={r.severity} />
              <span className="t">{r.robot_id}</span>
              <span className="spacer" />
              <span className="mono small muted">{fmtTime(r.created_at)}</span>
            </div>
            <div className="small" style={{ margin: '3px 0' }}>{r.failure_summary}</div>
            <div className="row small">
              <StateBadge state={r.state} />
              {r.call_status && <span className="badge b-neutral">call {r.call_status.toLowerCase()}</span>}
              {r.latest_revision && <span className="badge b-neutral mono">rev {r.latest_revision}</span>}
              <span className="mono muted">{r.category}</span>
            </div>
          </div>
        ))}
      </aside>
      <main className="main">
        {!selected && <div className="muted">Select an incident.</div>}
        {selected && !agg && <div className="muted">Loading…</div>}
        {agg && <IncidentDetail agg={agg} trajectory={trajectory} metrics={metrics} focusSegment={focus?.incident === agg.incident_id ? focus.segment : null} notify={notify} />}
      </main>
      {ring && <Softphone key={ring.call_id} ring={ring} onClose={() => setRing(null)} onOpenIncident={setSelected} onAnswered={(id) => (answeredHere.current = id)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
