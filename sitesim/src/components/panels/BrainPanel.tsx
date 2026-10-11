/**
 * Brain panel: the fleet's versioned knowledge graph (harness read API) at a glance —
 * zone scores, the site → zone → task skeleton with attached components, live brain reads,
 * the supervisor loop, and incident escalation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZONE_COLOR, useStore } from "../../state/store";
import { Panel } from "../ui/primitives";

const API = import.meta.env.VITE_HARNESS_API ?? "http://localhost:8000";

type Status = "skeleton" | "added" | "unchanged" | "retired" | "evidence";
interface BNode { id: string; kind: string; label: string; parent_id: string | null; status: Status; key?: string; value?: unknown; since?: number; until?: number }
interface BLink { source: string; target: string; kind: "scope" | "evidence" }
interface Graph { version: number; compare_to: number | null; nodes: BNode[]; links: BLink[] }
interface Versions { latest: number; chain: Array<{ version: number; parent: number | null; hypothesis?: string; added?: number; retired?: number }> }
interface Scores { version: number; zones: Record<string, number>; worst_zone?: string; v1?: Record<string, number> }
interface Ev { kind: string; at?: string; [k: string]: unknown }
interface Incident { incident_id: string; open_url: string; plain_summary: string }

const fmtScore = (s: number | undefined) => s === undefined || s === null ? "—" : s <= 1 ? String(Math.round(s * 100)) : String(Math.round(s));
const fmtDelta = (cur?: number, base?: number) => {
  if (cur === undefined || base === undefined) return null;
  const d = (cur <= 1 ? cur * 100 : cur) - (base <= 1 ? base * 100 : base);
  return { text: `${d >= 0 ? "+" : ""}${Math.round(d)}`, color: d > 0.5 ? "var(--green)" : d < -0.5 ? "var(--red)" : "var(--muted)" };
};
const fmtVal = (v: unknown) => v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const summarize = (e: Ev) => {
  if (e.kind === "tool_call") { const inp = e.input === undefined ? "" : typeof e.input === "string" ? e.input : JSON.stringify(e.input); return { tag: String(e.tool ?? "tool"), text: trunc(inp, 60) }; }
  return { tag: "supervisor", text: trunc(String(e.text ?? ""), 80) };
};

async function getJson<T>(path: string): Promise<T | null> {
  try { const r = await fetch(API + path); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

/** SSE with exponential backoff; EventSource's own retry is bypassed so a dead server does not hammer. */
function useEvents(onEvent: (e: Ev) => void) {
  const cb = useRef(onEvent); cb.current = onEvent;
  const [live, setLive] = useState(false);
  useEffect(() => {
    let es: EventSource | null = null, timer = 0, delay = 1000, dead = false;
    const open = () => {
      if (dead) return;
      es = new EventSource(API + "/api/events");
      es.onopen = () => { delay = 1000; setLive(true); };
      es.onmessage = (m) => { try { cb.current(JSON.parse(m.data)); } catch { /* ignore */ } };
      es.onerror = () => { es?.close(); es = null; setLive(false); timer = window.setTimeout(open, delay); delay = Math.min(30000, delay * 2); };
    };
    open();
    return () => { dead = true; es?.close(); clearTimeout(timer); };
  }, []);
  return live;
}

export function BrainPanel() {
  const open = useStore((s) => s.brainPanel);
  const setOpen = useStore((s) => s.setBrainPanel);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [scores, setScores] = useState<Scores | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [pulsed, setPulsed] = useState<Record<string, number>>({});
  const [feed, setFeed] = useState<Ev[]>([]);
  const [round, setRound] = useState<{ n: number | string; running: boolean } | null>(null);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [verdict, setVerdict] = useState<{ verdict: string; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const openedIncidents = useRef(new Set<string>());

  const latest = versions?.latest ?? null;
  const v = sel ?? latest;

  const refresh = useCallback(async () => {
    const [vs, sc] = await Promise.all([getJson<Versions>("/api/brain/versions"), getJson<Scores>("/api/scores")]);
    if (vs) setVersions(vs);
    if (sc) setScores(sc);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (v === null) return;
    const cmp = v > 1 ? v - 1 : "";
    let stale = false;
    getJson<Graph>(`/api/brain/graph?v=${v}&compare_to=${cmp}`).then((g) => { if (g && !stale) setGraph(g); });
    return () => { stale = true; };
  }, [v, latest]);

  const live = useEvents((e) => {
    switch (e.kind) {
      case "brain_read": {
        const scope = Array.isArray(e.scope) ? (e.scope as string[]) : [];
        const ids = [...scope, ...(Array.isArray(e.component_ids) ? (e.component_ids as string[]) : []), ...(typeof e.node_id === "string" ? [e.node_id] : [])];
        const now = Date.now();
        setPulsed((p) => ({ ...p, ...Object.fromEntries(ids.map((id) => [id, now])) }));
        window.setTimeout(() => setPulsed((p) => { const q = { ...p }; for (const id of ids) if (q[id] === now) delete q[id]; return q; }), 1500);
        const reader = String(e.reader ?? "");
        const st = useStore.getState();
        if (/^R\d+$/.test(reader)) st.pulseBrain(reader); else if (st.selectedRobot) st.pulseBrain(st.selectedRobot);
        break;
      }
      case "supervisor_text": case "tool_call": setFeed((f) => [e, ...f].slice(0, 3)); break;
      case "round_start": setRound({ n: (e.round ?? e.n ?? e.index ?? "") as number | string, running: true }); setVerdict(null); break;
      case "round_end": setRound((r) => ({ n: (e.round ?? e.n ?? r?.n ?? "") as number | string, running: false })); setBusy(false); refresh(); break;
      case "verdict": setVerdict({ verdict: String(e.verdict ?? ""), reason: typeof e.reason === "string" ? e.reason : undefined }); break;
      case "promoted": setSel(null); refresh(); break;
      case "incident": {
        const inc = { incident_id: String(e.incident_id ?? ""), open_url: String(e.open_url ?? ""), plain_summary: String(e.plain_summary ?? "") };
        setIncident(inc);
        if (inc.open_url && !openedIncidents.current.has(inc.incident_id)) { openedIncidents.current.add(inc.incident_id); window.open(inc.open_url, "harness-call"); }
        break;
      }
    }
  });

  const runRound = async () => {
    setBusy(true);
    try { await fetch(API + "/api/loop/round", { method: "POST" }); } catch { setBusy(false); }
  };

  // Tree: skeleton nodes by parent, components attached via parent_id or a scope link.
  const tree = useMemo(() => {
    const nodes = graph?.nodes ?? [], links = graph?.links ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const skel = nodes.filter((n) => n.status === "skeleton");
    const kids = new Map<string, BNode[]>(), comps = new Map<string, BNode[]>();
    for (const n of skel) if (n.parent_id) (kids.get(n.parent_id) ?? kids.set(n.parent_id, []).get(n.parent_id)!).push(n);
    const attach = (n: BNode) => {
      if (n.parent_id && byId.get(n.parent_id)?.status === "skeleton") return n.parent_id;
      const l = links.find((x) => x.kind === "scope" && (x.source === n.id || x.target === n.id));
      return l ? (l.source === n.id ? l.target : l.source) : null;
    };
    for (const n of nodes) {
      if (n.status === "skeleton" || n.status === "evidence" || n.kind === "evidence") continue;
      const at = attach(n); if (at) (comps.get(at) ?? comps.set(at, []).get(at)!).push(n);
    }
    const roots = skel.filter((n) => !n.parent_id || !byId.has(n.parent_id));
    return { roots, kids, comps };
  }, [graph]);

  const zones = useMemo(() => {
    const keys = Object.keys(scores?.zones ?? {});
    return keys.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }, [scores]);

  const renderNode = (n: BNode, depth: number): React.ReactNode => (
    <div key={n.id} className={"bn" + (pulsed[n.id] ? " pulse" : "")} style={{ marginLeft: depth ? 10 : 0 }}>
      <div className="bn-h">
        <span className="bn-k">{n.kind}</span>
        <span className="bn-l" style={{ color: n.kind === "zone" ? ZONE_COLOR[n.label] ?? ZONE_COLOR[n.id.split(":")[1]] : undefined }}>{n.label}</span>
      </div>
      {(tree.comps.get(n.id) ?? []).length > 0 && (
        <div className="bn-chips">
          {tree.comps.get(n.id)!.map((c) => (
            <span key={c.id} className={`bchip ${c.status}` + (pulsed[c.id] ? " pulse" : "")} title={`${c.id}\n${c.key ?? ""} = ${fmtVal(c.value)}`}>
              <span className="bchip-l">{trunc(c.key ?? c.label, 22)}</span>
              {fmtVal(c.value) && <span className="bchip-v">{trunc(fmtVal(c.value), 10)}</span>}
            </span>
          ))}
        </div>
      )}
      {(tree.kids.get(n.id) ?? []).map((k) => renderNode(k, depth + 1))}
    </div>
  );

  const chips = latest ? Array.from({ length: latest }, (_, i) => i + 1) : [];
  return (
    <Panel title="Brain" sub={latest ? `v${latest}` : live ? "…" : "offline"} action={
      <span className="brain-act">
        {chips.map((i) => <button key={i} className={"vchip" + (i === v ? " on" : "")} onClick={() => setSel(i === latest ? null : i)}>{i}</button>)}
        <button className="link" onClick={() => setOpen(!open)}>{open ? "–" : "+"}</button>
      </span>
    }>
      {open && <>
        {incident && (
          <div className="brain-incident">
            <div className="t">Robotics Lead is being called</div>
            <div className="s">{incident.plain_summary}</div>
            <div className="row">
              <button className="btn primary" onClick={() => window.open(incident.open_url, "harness-call")}>Open call</button>
              <button className="btn ghost" onClick={() => setIncident(null)}>Dismiss</button>
            </div>
          </div>
        )}
        <div className="brain-tiles">
          {(zones.length ? zones : ["A", "B", "C", "D", "M"]).map((z) => {
            const d = fmtDelta(scores?.zones[z], scores?.v1?.[z]);
            return (
              <div key={z} className={"btile" + (scores?.worst_zone === z ? " worst" : "")}>
                <span className="z" style={{ color: ZONE_COLOR[z] }}>{z}</span>
                <span className="n">{fmtScore(scores?.zones[z])}</span>
                <span className="d" style={{ color: d?.color }}>{d ? `v1 → ${d.text}` : "v1 → —"}</span>
              </div>
            );
          })}
        </div>
        <button className="btn-outline" style={{ marginTop: 4 }} onClick={() => useStore.getState().setViewTab("BRAIN")}>Open the knowledge graph →</button>
        <div className="brain-sup">
          <div className="brain-sup-h">
            <span>Supervisor{round ? <span className={"rnd" + (round.running ? " on" : "")}>{round.running ? `round ${round.n} running` : `round ${round.n} done`}</span> : null}</span>
            <button className="btn" disabled={busy || round?.running} onClick={runRound}>{busy || round?.running ? "Running…" : "Run a round"}</button>
          </div>
          {verdict && <div className={"brain-verdict " + verdict.verdict.toLowerCase()}>{verdict.verdict}{verdict.reason ? ` · ${trunc(verdict.reason, 70)}` : ""}</div>}
          {feed.length === 0 && <div className="brain-empty">No supervisor activity yet</div>}
          {feed.map((e, i) => { const s = summarize(e); return <div key={i} className="brain-row"><span className="tag">{s.tag}</span><span className="txt">{s.text}</span></div>; })}
        </div>
      </>}
    </Panel>
  );
}
