/**
 * BRAIN view: the hierarchical knowledge graph drawn as a layered tree (site → zones → tasks), with every
 * component (rule, guardrail, context policy, tool grant) hanging under the node it attaches to. Side-by-side
 * compare against v1 highlights what the robot changed about itself; a brain read lights the whole scope path.
 * Spec: SCRATCHPADS/brain-hierarchical-knowledge-graph.md ("two concrete visuals").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZONE_COLOR, useStore } from "../../state/store";
import { API, getJson, invalidateGraphs, refreshBrain, useBrainEvents, useBrainGraph, useBrainSnapshot, type BNode, type Ev, type Explain, type Graph } from "../panels/brainApi";
import { ForceGraph } from "./ForceGraph";

const KIND_COLOR: Record<string, string> = { rule: "#60a5fa", guardrail: "#f97316", context_policy: "#a855f7", tool_grant: "#22c55e", preference: "#eab308" };
const W = 1600, H = 900;
const ROW_Y = [60, 290, 540];
const LEAF_W = 150, LEAF_H = 34, LEAF_GAP = 8, LEAF_TOP = 60;

interface Placed { node: BNode; x: number; y: number; w: number; h: number; row: number; zone: string | null }

/** Layered layout: skeleton rows, then component leaves in a ≤3-wide grid under their parent. */
function layout(g: Graph): { placed: Placed[]; byId: Map<string, Placed> } {
  const nodes = g.nodes;
  const byId = new Map<string, Placed>();
  const site = nodes.find((n) => n.kind === "site") ?? nodes.find((n) => n.parent_id === null);
  const zones = nodes.filter((n) => n.kind === "zone").sort((a, b) => a.id.localeCompare(b.id));
  const tasks = nodes.filter((n) => n.kind === "task");
  const comps = nodes.filter((n) => n.status !== "skeleton" && n.status !== "evidence" && !["site", "zone", "task"].includes(n.kind));
  const placed: Placed[] = [];
  const put = (node: BNode, x: number, y: number, w: number, h: number, row: number, zone: string | null) => { const p = { node, x, y, w, h, row, zone }; placed.push(p); byId.set(node.id, p); return p; };
  const zoneOf = (n: BNode): string | null => { const m = n.id.match(/^(?:zone|task):([^:]+)/); return m ? m[1] : null; };
  if (site) put(site, W / 2 - 110, ROW_Y[0], 220, 44, 0, null);
  const span = W / Math.max(1, zones.length);
  zones.forEach((z, i) => {
    const cx = span * i + span / 2;
    put(z, cx - 95, ROW_Y[1], 190, 42, 1, zoneOf(z));
    const kids = tasks.filter((t) => t.parent_id === z.id).sort((a, b) => a.id.localeCompare(b.id));
    const tw = Math.min(118, (span - 20) / Math.max(1, kids.length) - 8);
    kids.forEach((t, j) => {
      const tx = cx - (kids.length * (tw + 8)) / 2 + j * (tw + 8) + 4;
      put(t, tx, ROW_Y[2], tw, 34, 2, zoneOf(t));
    });
  });
  // components under their parent, in a compact grid; the site row fans wide, task rows stack 1-wide
  const groups = new Map<string, BNode[]>();
  for (const c of comps) { const pid = c.parent_id && byId.has(c.parent_id) ? c.parent_id : site?.id ?? ""; (groups.get(pid) ?? groups.set(pid, []).get(pid)!).push(c); }
  for (const [pid, list] of groups) {
    const parent = byId.get(pid); if (!parent) continue;
    const cols = parent.row === 2 ? 1 : parent.row === 1 ? 2 : Math.min(6, Math.max(3, Math.ceil(list.length / 2)));
    const w = parent.row === 2 ? Math.max(parent.w, 120) : LEAF_W;
    list.sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || a.id.localeCompare(b.id));
    list.forEach((c, k) => {
      const col = k % cols, rowk = Math.floor(k / cols);
      const x0 = parent.x + parent.w / 2 - (cols * (w + LEAF_GAP)) / 2 + LEAF_GAP / 2;
      put(c, x0 + col * (w + LEAF_GAP), parent.y + parent.h + LEAF_TOP + rowk * (LEAF_H + LEAF_GAP), w, LEAF_H, parent.row + 1, parent.zone);
    });
  }
  return { placed, byId };
}

function Tree({ g, pulses, onHover, onSelect, selected, showEvidence, caption }: {
  g: Graph; pulses: Map<string, number>; onHover: (p: Placed | null, e?: React.MouseEvent) => void; onSelect: (p: Placed) => void;
  selected: string | null; showEvidence: boolean; caption: Map<string, string>;
}) {
  const { placed, byId } = useMemo(() => layout(g), [g]);
  const maxY = Math.max(H, ...placed.map((p) => p.y + p.h + 40));
  const edges = useMemo(() => {
    const out: Array<{ a: Placed; b: Placed; kind: "scope" | "evidence" }> = [];
    for (const p of placed) { const par = p.node.parent_id ? byId.get(p.node.parent_id) : null; if (par) out.push({ a: par, b: p, kind: "scope" }); }
    if (showEvidence && selected) for (const l of g.links) if (l.kind === "evidence" && (l.source === selected || l.target === selected)) { const a = byId.get(l.source), b = byId.get(l.target); if (a && b) out.push({ a, b, kind: "evidence" }); }
    return out;
  }, [placed, byId, g.links, showEvidence, selected]);
  const now = Date.now();
  const lit = (id: string) => { const t = pulses.get(id); return t !== undefined && now - t < 1600; };
  const fill = (p: Placed) => {
    const n = p.node;
    if (n.kind === "site") return "#1e293b";
    if (n.kind === "zone" || n.kind === "task") return (p.zone && ZONE_COLOR[p.zone]) || "#334155";
    return KIND_COLOR[n.kind] ?? "#64748b";
  };
  return (
    <svg className="brain-svg" viewBox={`0 0 ${W} ${maxY}`} preserveAspectRatio="xMidYMin meet">
      <defs>
        <filter id="glow"><feGaussianBlur stdDeviation="6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {edges.map((e, i) => {
        const x1 = e.a.x + e.a.w / 2, y1 = e.a.y + e.a.h, x2 = e.b.x + e.b.w / 2, y2 = e.b.y;
        const my = (y1 + y2) / 2;
        const hot = lit(e.a.node.id) && lit(e.b.node.id);
        return <path key={i} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} fill="none" stroke={e.kind === "evidence" ? "#facc15" : hot ? "#60a5fa" : "#334155"} strokeWidth={hot ? 3 : e.kind === "evidence" ? 2 : 1.4} strokeDasharray={e.kind === "evidence" ? "6 5" : undefined} className={hot ? "edge-hot" : undefined} />;
      })}
      {placed.map((p) => {
        const n = p.node, skel = n.status === "skeleton";
        const isLit = lit(n.id), sel = selected === n.id;
        const added = n.status === "added", retired = n.status === "retired";
        const opacity = retired ? 0.45 : 1;
        const label = skel ? (n.kind === "task" ? n.id.split(":")[2] : n.label) : (n.key ?? n.label ?? n.id).replace(/^(sim|assign|class|zone)\./, "");
        const val = !skel && n.value !== undefined && n.value !== null ? String(typeof n.value === "object" ? JSON.stringify(n.value) : n.value) : null;
        return (
          <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={opacity} className={`bg-node${isLit ? " lit" : ""}${sel ? " sel" : ""}`}
            onMouseEnter={(e) => onHover(p, e)} onMouseLeave={() => onHover(null)} onClick={() => onSelect(p)} style={{ cursor: "pointer" }}>
            {isLit && <rect x={-6} y={-6} width={p.w + 12} height={p.h + 12} rx={skel ? 22 : 10} fill="none" stroke="#60a5fa" strokeWidth={3} className="pulse-ring" />}
            {added && <rect x={-3} y={-3} width={p.w + 6} height={p.h + 6} rx={12} fill="none" stroke="#22c55e" strokeWidth={2.5} filter="url(#glow)" />}
            <rect width={p.w} height={p.h} rx={skel ? 20 : 8} fill={skel ? "#0f172a" : fill(p)} fillOpacity={skel ? 1 : 0.22} stroke={sel ? "#fff" : fill(p)} strokeWidth={sel ? 2.5 : skel ? 2 : 1.5} />
            <text x={skel ? p.w / 2 : 10} y={skel ? p.h / 2 + 5 : 14} textAnchor={skel ? "middle" : "start"} fill="#e5eaf3" fontSize={skel ? (n.kind === "site" ? 18 : n.kind === "zone" ? 16 : 14) : 11.5} fontWeight={skel ? 700 : 600} fontFamily={skel ? "Inter, sans-serif" : "JetBrains Mono, monospace"} style={retired ? { textDecoration: "line-through" } : undefined}>
              {label.length > (skel ? 24 : 20) ? label.slice(0, skel ? 23 : 19) + "…" : label}
            </text>
            {!skel && <text x={10} y={28} fill="#8b98ad" fontSize={10.5} fontFamily="JetBrains Mono, monospace">{n.kind.replace("_", " ")}{val ? ` = ${val.length > 10 ? val.slice(0, 9) + "…" : val}` : ""}{n.since ? `  v${n.since}` : ""}</text>}
            {added && <text x={p.w - 6} y={-7} textAnchor="end" fill="#22c55e" fontSize={11} fontWeight={700}>+v{n.since}</text>}
            {retired && <text x={p.w - 6} y={-7} textAnchor="end" fill="#f87171" fontSize={11} fontWeight={700}>retired v{n.until}</text>}
            {caption.get(n.id) && <text x={p.w / 2} y={-12} textAnchor="middle" fill="#93c5fd" fontSize={12} fontWeight={600} className="read-caption">{caption.get(n.id)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function BrainGraphView() {
  const { versions, scores } = useBrainSnapshot();
  const latest = versions?.latest ?? null;
  const [v, setV] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [compare, setCompare] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [hover, setHover] = useState<{ p: Placed; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<Placed | null>(null);
  const [explain, setExplain] = useState<Explain | null>(null);
  const [showEvidence, setShowEvidence] = useState(true);
  const [layout, setLayout] = useState<"graph" | "tree">("graph");
  const [, tick] = useState(0);
  const pulses = useRef(new Map<string, number>());
  const captions = useRef(new Map<string, string>());
  const pulseBrain = useStore((s) => s.pulseBrain);
  const selectedRobot = useStore((s) => s.selectedRobot);
  const shown = v ?? latest;
  useEffect(() => { if (follow && latest !== null) setV(latest); }, [latest, follow]);
  const graph = useBrainGraph(shown, compare && shown !== null && shown > 1 ? 1 : null, epoch);
  const graphV1 = useBrainGraph(compare ? 1 : null, null, epoch);

  const onEvent = useCallback((e: Ev) => {
    if (e.kind === "brain_read") {
      const ids = [...((e.scope as string[]) ?? []), ...((e.component_ids as string[]) ?? []), String(e.node_id ?? "")].filter(Boolean);
      const t = Date.now();
      for (const id of ids) pulses.current.set(id, t);
      const reader = String(e.reader ?? "");
      if (e.node_id) captions.current.set(String(e.node_id), `read by ${reader || "agent"}`);
      if (/^R\d+$/.test(reader)) pulseBrain(reader); else if (selectedRobot) pulseBrain(selectedRobot);
      tick((n) => n + 1);
      window.setTimeout(() => { captions.current.delete(String(e.node_id)); tick((n) => n + 1); }, 1700);
    } else if (e.kind === "promoted" || e.kind === "round_end") {
      invalidateGraphs(); setEpoch((n) => n + 1); refreshBrain();
    }
  }, [pulseBrain, selectedRobot]);
  const live = useBrainEvents(onEvent);
  // re-render while any pulse is alive so rings fade out
  useEffect(() => { const id = window.setInterval(() => { const now = Date.now(); let any = false; for (const t of pulses.current.values()) if (now - t < 1700) any = true; if (any) tick((n) => n + 1); }, 400); return () => window.clearInterval(id); }, []);

  const onSelectNode = (n: BNode) => onSelect({ node: n, x: 0, y: 0, w: 0, h: 0, row: 0, zone: null });
  const onSelect = (p: Placed) => {
    setSelected(p); setExplain(null);
    if (p.node.status !== "skeleton") getJson<Explain>(`/api/brain/explain/${encodeURIComponent(p.node.id)}`).then(setExplain);
    else getJson<{ components: Array<Record<string, unknown>>; scope: string[] }>(`/api/brain/context/${encodeURIComponent(p.node.id)}?reader=dashboard${shown ? `&v=${shown}` : ""}`).then((c) => c && setExplain({ markdown: `${c.components.length} component(s) apply here, through ${c.scope.join(" → ")}` }));
  };
  const counts = useMemo(() => graph ? { added: graph.nodes.filter((n) => n.status === "added").length, retired: graph.nodes.filter((n) => n.status === "retired").length, comps: graph.nodes.filter((n) => !["skeleton", "evidence"].includes(n.status)).length } : null, [graph]);
  const chain = versions?.chain ?? [];
  const entry = chain.find((c) => c.version === shown);
  const ex = explain;
  const comp = ex?.component;
  const habit = (ex?.habit ?? (ex?.evidence as Record<string, unknown> | undefined)?.habit) as Record<string, unknown> | null | undefined;
  const gateRun = (ex?.gate_run ?? (ex?.evidence as Record<string, unknown> | undefined)?.gate_run) as Record<string, unknown> | null | undefined;
  const episodes = (ex?.episodes ?? (ex?.evidence as Record<string, unknown> | undefined)?.episodes ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="brain-view">
      <div className="brain-toolbar">
        <span className="bt-title">BRAIN {shown !== null ? `v${shown}` : ""}</span>
        <span className="bt-chips">{Array.from({ length: latest ?? 0 }, (_, i) => i + 1).map((n) => <button key={n} className={shown === n ? "on" : ""} onClick={() => { setV(n); setFollow(n === latest); }}>v{n}</button>)}</span>
        <button className={"bt-toggle" + (compare ? " on" : "")} onClick={() => setCompare((c) => !c)} disabled={!latest || latest < 2} title="Draw v1 beside this version; added components glow green">Compare to v1</button>
        <button className={"bt-toggle" + (follow ? " on" : "")} onClick={() => setFollow((f) => !f)} title="Jump to the newest version when the gate promotes one">Follow live</button>
        <button className={"bt-toggle" + (showEvidence ? " on" : "")} onClick={() => setShowEvidence((s) => !s)}>Evidence edges</button>
        <span className="bt-chips"><button className={layout === "graph" ? "on" : ""} onClick={() => setLayout("graph")} title="Force-directed nodes and edges; drag, pan, wheel to zoom">Graph</button><button className={layout === "tree" ? "on" : ""} onClick={() => setLayout("tree")}>Tree</button></span>
        <span className="bt-legend">
          <i style={{ background: KIND_COLOR.rule }} />rule <i style={{ background: KIND_COLOR.guardrail }} />guardrail <i style={{ background: KIND_COLOR.context_policy }} />context policy <i style={{ background: KIND_COLOR.tool_grant }} />tool grant
          {counts && <b>· {counts.comps} components{counts.added ? ` · ${counts.added} added` : ""}{counts.retired ? ` · ${counts.retired} retired` : ""}</b>}
        </span>
        <span className={"bt-live" + (live ? " on" : "")}>{live ? "● live" : "○ offline"}</span>
      </div>
      {entry?.hypothesis && <div className="brain-hyp">v{entry.version}: {entry.hypothesis}{entry.heldout_passed ? " · held-out agreed" : ""}</div>}
      <div className={"brain-canvas" + (compare ? " split" : "")}>
        {compare && graphV1 && <div className="brain-pane"><div className="pane-h">v1 · the integrator's first-day brain</div>{layout === "graph" ? <ForceGraph g={graphV1} pulses={pulses.current} selected={selected?.node.id ?? null} onSelect={onSelectNode} seedKey="v1" /> : <Tree g={graphV1} pulses={pulses.current} onHover={() => {}} onSelect={onSelect} selected={selected?.node.id ?? null} showEvidence={false} caption={new Map()} />}</div>}
        <div className="brain-pane">
          {compare && <div className="pane-h">v{shown} · what the robot changed about itself</div>}
          {graph ? (layout === "graph"
            ? <ForceGraph g={graph} pulses={pulses.current} selected={selected?.node.id ?? null} onSelect={onSelectNode} caption={captions.current}
                onHover={(n, e) => setHover(n && e ? { p: { node: n, x: 0, y: 0, w: 0, h: 0, row: 0, zone: null }, x: e.clientX, y: e.clientY } : null)} />
            : <Tree g={graph} pulses={pulses.current} onHover={(p, e) => setHover(p && e ? { p, x: e.clientX, y: e.clientY } : null)} onSelect={onSelect} selected={selected?.node.id ?? null} showEvidence={showEvidence} caption={captions.current} />)
            : <div className="hint" style={{ padding: 24 }}>{latest === null ? `Waiting for the harness at ${API}…` : "Loading graph…"}</div>}
        </div>
        {selected && (
          <aside className="brain-card">
            <header><b>{selected.node.kind.replace("_", " ")}</b><button className="icon-btn" onClick={() => setSelected(null)}>✕</button></header>
            <div className="card-title">{selected.node.label}</div>
            <div className="card-id">{selected.node.id}</div>
            {selected.node.key && <div className="kv"><span className="k">sets</span><span className="v">{selected.node.key} = {String(selected.node.value)}</span></div>}
            {selected.node.since && <div className="kv"><span className="k">since</span><span className="v">v{selected.node.since}{selected.node.until ? ` until v${selected.node.until}` : " (active)"}</span></div>}
            {comp && typeof comp.when === "string" && <div className="kv"><span className="k">when</span><span className="v">{String(comp.when)}</span></div>}
            {comp && typeof comp.then === "string" && <div className="kv"><span className="k">then</span><span className="v">{String(comp.then)}</span></div>}
            {habit && <div className="card-sec"><div className="k">Human habit</div><div>{String(habit.text ?? habit._id)}</div>{(habit.clip as Record<string, unknown> | undefined)?.uri ? <a href={String((habit.clip as Record<string, unknown>).uri)} target="_blank" rel="noreferrer">clip ↗</a> : null}</div>}
            {gateRun && <div className="card-sec"><div className="k">Gate run</div><div>{String(gateRun._id ?? "")} · {String(gateRun.verdict ?? "")}</div><div className="muted">{String(gateRun.reason ?? "")}</div></div>}
            {episodes.length > 0 && <div className="card-sec"><div className="k">Failure episodes ({episodes.length})</div>{episodes.slice(0, 4).map((e, i) => <div key={i} className="muted">{String(e.type ?? "")} · zone {String(e.zone ?? "?")} · {String(e.detail ?? "").slice(0, 70)}</div>)}</div>}
            {ex?.heldout_passed !== undefined && ex?.heldout_passed !== null && <div className="kv"><span className="k">held-out</span><span className="v" style={{ color: ex.heldout_passed ? "var(--green)" : "var(--red)" }}>{ex.heldout_passed ? "agreed" : "disagreed"}</span></div>}
            {ex?.markdown && !comp && <div className="muted" style={{ marginTop: 8 }}>{ex.markdown}</div>}
          </aside>
        )}
      </div>
      {hover && !selected && (
        <div className="brain-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <b>{hover.p.node.label}</b>
          {hover.p.node.key && <div>{hover.p.node.key} = {String(hover.p.node.value)}</div>}
          {hover.p.node.since && <div className="muted">since v{hover.p.node.since}{hover.p.node.until ? `, retired v${hover.p.node.until}` : ""}</div>}
          {hover.p.node.status === "skeleton" && scores?.zones && hover.p.zone && hover.p.node.kind === "zone" && <div className="muted">score {Math.round((scores.zones[hover.p.zone] ?? 0) * 100)}</div>}
        </div>
      )}
    </div>
  );
}


/** Sidebar version: the same tree, scrollable, lit by the same brain-read events. "Open" jumps to the BRAIN tab. */
export function BrainMini() {
  const { versions } = useBrainSnapshot();
  const latest = versions?.latest ?? null;
  const [epoch, setEpoch] = useState(0);
  const [, tick] = useState(0);
  const pulses = useRef(new Map<string, number>());
  const captions = useRef(new Map<string, string>());
  const pulseBrain = useStore((s) => s.pulseBrain);
  const setViewTab = useStore((s) => s.setViewTab);
  const graph = useBrainGraph(latest, latest && latest > 1 ? latest - 1 : null, epoch);
  const onEvent = useCallback((e: Ev) => {
    if (e.kind === "brain_read") {
      const t = Date.now();
      for (const id of [...((e.scope as string[]) ?? []), ...((e.component_ids as string[]) ?? []), String(e.node_id ?? "")]) if (id) pulses.current.set(id, t);
      const reader = String(e.reader ?? "");
      if (e.node_id) { captions.current.set(String(e.node_id), `read by ${reader || "agent"}`); window.setTimeout(() => { captions.current.delete(String(e.node_id)); tick((n) => n + 1); }, 1700); }
      if (/^R\d+$/.test(reader)) pulseBrain(reader);
      tick((n) => n + 1);
    } else if (e.kind === "promoted" || e.kind === "round_end") { invalidateGraphs(); setEpoch((n) => n + 1); refreshBrain(); }
  }, [pulseBrain]);
  useBrainEvents(onEvent);
  useEffect(() => { const id = window.setInterval(() => { const now = Date.now(); for (const t of pulses.current.values()) if (now - t < 1700) { tick((n) => n + 1); break; } }, 400); return () => window.clearInterval(id); }, []);
  const [zoom, setZoom] = useState(0.5);
  return (
    <section className="panel grow brain-mini">
      <header className="panel-h"><span>Knowledge graph{latest ? ` · v${latest}` : ""}</span>
        <span className="mini-zoom"><input type="range" min={0.3} max={1.4} step={0.05} value={zoom} onChange={(e) => setZoom(+e.target.value)} title="Zoom" /><button className="link" onClick={() => setViewTab("BRAIN")}>Open ↗</button></span></header>
      <div className="panel-b brain-mini-b fg-mini" style={{ ["--mini-w" as string]: `${Math.round(1240 * zoom)}px` }}>
        {graph ? <ForceGraph g={graph} pulses={pulses.current} selected={null} onSelect={() => setViewTab("BRAIN")} caption={captions.current} seedKey="mini" />
          : <div className="hint">Waiting for the harness…</div>}
      </div>
    </section>
  );
}
