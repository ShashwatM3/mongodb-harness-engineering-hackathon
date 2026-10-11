import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtTime, type Aggregate, type IncidentRow, type Metric, type ServerEvent, type Trajectory } from './api';
import { IncidentDetail } from './components/IncidentDetail';
import { MeetView } from './components/MeetView';
import { StatusPill } from './components/bits';
import { Softphone, inCall, useSoftphone, type Ringing } from './components/Softphone';

interface Config {
  harness: string;
  call_mode: string;
  elevenlabs_configured: boolean;
  scenarios: Array<{ name: string; title: string; description: string }>;
}

/** `?incident=<id>` deep link: keep looking for the incident in the list for this long before giving up. */
const DEEP_LINK_WAIT_MS = 30_000;

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [rows, setRows] = useState<IncidentRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [agg, setAgg] = useState<Aggregate | null>(null);
  const [trajectory, setTrajectory] = useState<Trajectory | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [focus, setFocus] = useState<{ incident: string; segment: string | null; at: number } | null>(null);
  const [ring, setRing] = useState<Ringing | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [scenario, setScenario] = useState('A');
  const selRef = useRef<string | null>(null);
  selRef.current = selected;
  /** Call answered in this tab; other tabs dismiss their ringing card when the call is answered elsewhere. */
  const answeredHere = useRef<string | null>(null);
  /** Incident requested through `?incident=`; cleared once selected. */
  const deepLink = useRef<string | null>(new URLSearchParams(location.search).get('incident'));

  const notify = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 3000);
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

  // Deep link: select the incident as soon as it shows up in the list (it may still be in flight from the harness).
  useEffect(() => {
    const want = deepLink.current;
    if (!want) return;
    if (rows.some((r) => r.incident_id === want)) {
      deepLink.current = null;
      setSelected(want);
    }
  }, [rows]);
  useEffect(() => {
    if (!deepLink.current) return;
    const started = Date.now();
    const id = setInterval(() => {
      if (!deepLink.current || Date.now() - started > DEEP_LINK_WAIT_MS) return clearInterval(id);
      void loadList();
    }, 1000);
    return () => clearInterval(id);
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

  // A call that was already ringing before this tab connected (e.g. opened from a deep link) is not replayed on SSE:
  // recover it from the incident's own call record so the ring UI comes up.
  useEffect(() => {
    if (!agg) return;
    const call = agg.calls.at(-1) as (Aggregate['calls'][number] & { ring_deadline?: string | null }) | undefined;
    if (!call || call.status !== 'RINGING') return;
    setRing((r) =>
      r && r.call_id === call._id
        ? r
        : {
            call_id: call._id,
            incident_id: agg.incident_id,
            supervisor: agg.incident.responsible_supervisor.name,
            severity: agg.incident.severity,
            robot_id: agg.incident.robot_id,
            summary: agg.incident.plain_summary ?? agg.incident.failure_summary,
            ring_deadline: call.ring_deadline ?? new Date(Date.now() + 45_000).toISOString(),
          },
    );
  }, [agg]);

  // Live sync: every committed change arrives as an event; the UI re-reads authoritative state.
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
        setFocus({ incident: e.incident_id!, segment: e.data.segment_id ?? null, at: Date.now() });
      }
      if (e.type === 'proposal.revised') notify(`Plan updated to version ${e.data.revision}`);
      if (e.type === 'feedback.delivered') notify('Feedback delivered to the supervisor');
      if (pending) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        void loadList();
        if (selRef.current && (!e.incident_id || e.incident_id === selRef.current)) void loadDetail(selRef.current);
      }, 120);
    };
    return () => es.close();
  }, [loadList, loadDetail, notify]);

  const phone = useSoftphone(ring, { onOpenIncident: setSelected, onAnswered: (id) => (answeredHere.current = id) });

  const trigger = async () => {
    const r = await api<{ incident_id: string }>('POST', `/dev/scenarios/${scenario}/trigger`);
    setSelected(r.incident_id);
  };

  // Meet-like screen while the selected incident is the one ringing / on the call; the floating card otherwise.
  const meet = Boolean(ring && agg && agg.incident_id === ring.incident_id && (phone.phase === 'ringing' || inCall(phone.phase)));

  return (
    <div className={`app ${meet ? 'in-meet' : ''}`}>
      <header className="topbar">
        <h1>Robot Fleet · Human Review</h1>
        <span className={`dot ${connected ? 'on' : ''}`} title={connected ? 'live' : 'disconnected'} />
        <span className="spacer" />
        {config && !config.elevenlabs_configured && <span className="muted small">voice not configured</span>}
        {config?.scenarios.length ? (
          <div className="row">
            <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {config.scenarios.map((s) => (
                <option key={s.name} value={s.name}>{s.title}</option>
              ))}
            </select>
            <button className="primary" onClick={() => void trigger()}>Simulate incident</button>
          </div>
        ) : null}
      </header>
      <aside className="sidebar">
        {rows.length === 0 && <p className="muted empty">{deepLink.current ? 'Waiting for the incident…' : 'No incidents yet.'}</p>}
        {rows.map((r) => (
          <button key={r.incident_id} className={`inc ${selected === r.incident_id ? 'sel' : ''}`} onClick={() => setSelected(r.incident_id)}>
            <div className="row">
              <StatusPill state={r.state} />
              <span className="spacer" />
              <span className="muted small">{fmtTime(r.created_at)}</span>
            </div>
            <div className="inc-text">{r.plain_summary}</div>
            <div className="muted small">{r.robot_id}</div>
          </button>
        ))}
      </aside>
      <main className={`main ${meet ? 'meet-main' : ''}`}>
        {!selected && <p className="muted empty">Select an incident, or simulate one.</p>}
        {selected && !agg && <p className="muted empty">Loading…</p>}
        {agg && meet && <MeetView agg={agg} phone={phone} notify={notify} />}
        {agg && !meet && <IncidentDetail agg={agg} trajectory={trajectory} metrics={metrics} focus={focus?.incident === agg.incident_id ? focus : null} notify={notify} />}
      </main>
      {ring && !meet && <Softphone phone={phone} onClose={() => setRing(null)} onOpenIncident={setSelected} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
