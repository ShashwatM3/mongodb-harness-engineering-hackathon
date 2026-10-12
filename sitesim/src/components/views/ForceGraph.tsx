/**
 * Force-directed node-and-edge drawing of the brain (the property-graph view): every node is a circle, every
 * parent/scope and evidence link is an edge, springs plus repulsion settle the layout, and the user can pan,
 * zoom and drag nodes. No dependency: a small simulation in a requestAnimationFrame loop over refs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZONE_COLOR } from "../../state/store";
import type { BNode, Graph } from "../panels/brainApi";

export const KIND_COLOR: Record<string, string> = {
  site: "#e5eaf3", zone: "#94a3b8", task: "#64748b",
  rule: "#60a5fa", guardrail: "#f97316", context_policy: "#a855f7", tool_grant: "#22c55e", preference: "#eab308",
  habit: "#f472b6", episode: "#fb7185", gate_run: "#2dd4bf", signal: "#fbbf24",
};
const RADIUS: Record<string, number> = { site: 30, zone: 22, task: 13, habit: 9, gate_run: 9, episode: 7 };
const radiusOf = (n: BNode) => RADIUS[n.kind] ?? 11;

interface Body { id: string; n: BNode; x: number; y: number; vx: number; vy: number; r: number; zone: string | null; fixed: boolean }
interface Spring { a: Body; b: Body; kind: "scope" | "evidence"; len: number }

const zoneOf = (n: BNode): string | null => { const m = n.id.match(/^(?:zone|task):([^:]+)/); return m ? m[1] : null; };

function colorOf(b: Body): string {
  if (b.n.kind === "zone" || b.n.kind === "task") return (b.zone && ZONE_COLOR[b.zone]) || KIND_COLOR[b.n.kind];
  return KIND_COLOR[b.n.kind] ?? "#94a3b8";
}

function shortLabel(n: BNode): string {
  if (n.kind === "task") return n.id.split(":")[2];
  if (n.kind === "zone") return n.id.split(":")[1];
  if (n.kind === "site") return "site";
  if (n.kind === "gate_run") return n.label?.replace(/^gate run:\s*/, "gate ") ?? "gate run";
  if (n.kind === "habit") return n.id.replace(/^habit:/, "");
  return (n.key ?? n.label ?? n.id).replace(/^(sim|assign|class|zone)\./, "");
}

export interface ForceGraphProps {
  g: Graph;
  pulses: Map<string, number>;
  selected: string | null;
  onSelect: (n: BNode) => void;
  onHover?: (n: BNode | null, e?: React.MouseEvent) => void;
  caption?: Map<string, string>;
  interactive?: boolean;
  seedKey?: string;
}

export function ForceGraph({ g, pulses, selected, onSelect, onHover, caption, interactive = true, seedKey }: ForceGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const bodies = useRef<Body[]>([]);
  const springs = useRef<Spring[]>([]);
  const byId = useRef(new Map<string, Body>());
  const view = useRef({ x: 0, y: 0, k: 1 });
  const [, tick] = useState(0);
  const drag = useRef<{ body: Body | null; pan: boolean; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const alive = useRef(1);

  // Build bodies/springs when the graph changes, keeping positions of nodes that already existed.
  useMemo(() => {
    const prev = byId.current;
    const map = new Map<string, Body>();
    const W = 1200, H = 800, cx = W / 2, cy = H / 2;
    const zones = g.nodes.filter((n) => n.kind === "zone");
    const zi = new Map(zones.map((z, i) => [z.id, i]));
    g.nodes.forEach((n, i) => {
      const old = prev.get(n.id);
      let x = cx + (Math.random() - 0.5) * 40, y = cy + (Math.random() - 0.5) * 40;
      if (n.kind === "zone") { const a = ((zi.get(n.id) ?? 0) / Math.max(1, zones.length)) * Math.PI * 2; x = cx + Math.cos(a) * 260; y = cy + Math.sin(a) * 200; }
      else if (n.kind === "task" && n.parent_id && zi.has(n.parent_id)) { const a = ((zi.get(n.parent_id) ?? 0) / Math.max(1, zones.length)) * Math.PI * 2 + (i % 4 - 1.5) * 0.25; x = cx + Math.cos(a) * 420; y = cy + Math.sin(a) * 320; }
      else if (n.kind !== "site") { const p = n.parent_id ? map.get(n.parent_id) ?? prev.get(n.parent_id) : null; if (p) { x = p.x + (Math.random() - 0.5) * 120; y = p.y + 70 + (Math.random() - 0.5) * 60; } }
      if (n.kind === "site") { x = cx; y = cy; }
      map.set(n.id, old ? { ...old, n, r: radiusOf(n) } : { id: n.id, n, x, y, vx: 0, vy: 0, r: radiusOf(n), zone: zoneOf(n), fixed: n.kind === "site" });
    });
    const sp: Spring[] = [];
    const seen = new Set<string>();
    const add = (a?: Body, b?: Body, kind: "scope" | "evidence" = "scope") => {
      if (!a || !b || a === b) return; const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id; if (seen.has(key)) return; seen.add(key);
      const len = kind === "evidence" ? 70 : a.n.kind === "site" ? 190 : a.n.kind === "zone" ? 110 : 60;
      sp.push({ a, b, kind, len });
    };
    for (const n of g.nodes) if (n.parent_id) add(map.get(n.parent_id), map.get(n.id));
    for (const l of g.links) add(map.get(l.source), map.get(l.target), l.kind);
    bodies.current = [...map.values()]; springs.current = sp; byId.current = map; alive.current = 1;
  }, [g, seedKey]);

  // Simulation loop
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const bs = bodies.current, sps = springs.current;
      const heat = alive.current;
      if (heat > 0.002) {
        for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
          const a = bs[i], b = bs[j]; let dx = b.x - a.x, dy = b.y - a.y; let d2 = dx * dx + dy * dy; if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const f = (2600 * heat) / d2; const d = Math.sqrt(d2); const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
        for (const s of sps) {
          const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, d = Math.max(1, Math.hypot(dx, dy)); const f = (d - s.len) * 0.035 * heat;
          const fx = (dx / d) * f, fy = (dy / d) * f; s.a.vx += fx; s.a.vy += fy; s.b.vx -= fx; s.b.vy -= fy;
        }
        for (const b of bs) {
          b.vx += (600 - b.x) * 0.0015 * heat; b.vy += (400 - b.y) * 0.0015 * heat;
          if (!b.fixed && drag.current?.body !== b) { b.vx *= 0.82; b.vy *= 0.82; b.x += b.vx; b.y += b.vy; } else { b.vx = 0; b.vy = 0; }
        }
        alive.current = Math.max(0, heat - 0.004);
        tick((n) => n + 1);
      } else {
        // keep rendering at a low rate so pulses fade
        const now = Date.now(); let any = false; for (const t of pulses.values()) if (now - t < 1700) any = true;
        if (any) tick((n) => n + 1);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [pulses]);

  const toLocal = (e: React.MouseEvent | MouseEvent) => {
    const svg = svgRef.current!; const r = svg.getBoundingClientRect(); const v = view.current;
    const sx = (e.clientX - r.left) * (1200 / r.width), sy = (e.clientY - r.top) * (800 / r.height);
    return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k, sx, sy };
  };
  const onDown = (e: React.MouseEvent, b?: Body) => {
    if (!interactive) return;
    const p = toLocal(e);
    drag.current = { body: b ?? null, pan: !b, sx: p.sx, sy: p.sy, ox: b ? b.x : view.current.x, oy: b ? b.y : view.current.y };
    if (b) alive.current = Math.max(alive.current, 0.25);
    e.stopPropagation();
  };
  const onMove = useCallback((e: MouseEvent) => {
    const d = drag.current; if (!d || !svgRef.current) return;
    const p = toLocal(e);
    if (d.body) { d.body.x = d.ox + (p.sx - d.sx) / view.current.k; d.body.y = d.oy + (p.sy - d.sy) / view.current.k; alive.current = Math.max(alive.current, 0.2); }
    else { view.current.x = d.ox + (p.sx - d.sx); view.current.y = d.oy + (p.sy - d.sy); }
    tick((n) => n + 1);
  }, []);
  useEffect(() => {
    const up = () => { drag.current = null; };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", up); };
  }, [onMove]);
  const onWheel = (e: React.WheelEvent) => {
    if (!interactive) return;
    const p = toLocal(e); const v = view.current; const k = Math.min(4, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    v.x = p.sx - (p.sx - v.x) * (k / v.k); v.y = p.sy - (p.sy - v.y) * (k / v.k); v.k = k; tick((n) => n + 1);
  };

  const now = Date.now();
  const lit = (id: string) => { const t = pulses.get(id); return t !== undefined && now - t < 1600; };
  const v = view.current;
  const selSet = useMemo(() => {
    if (!selected) return null; const s = new Set<string>([selected]);
    for (const sp of springs.current) { if (sp.a.id === selected) s.add(sp.b.id); if (sp.b.id === selected) s.add(sp.a.id); }
    return s;
  }, [selected, g]);

  return (
    <svg ref={svgRef} className="fg-svg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid meet" onMouseDown={(e) => onDown(e)} onWheel={onWheel}>
      <defs><filter id="fgglow"><feGaussianBlur stdDeviation="5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
      <g transform={`translate(${v.x},${v.y}) scale(${v.k})`}>
        {springs.current.map((s, i) => {
          const hot = lit(s.a.id) && lit(s.b.id);
          const dim = selSet ? !(selSet.has(s.a.id) && selSet.has(s.b.id)) : false;
          return <line key={i} x1={s.a.x} y1={s.a.y} x2={s.b.x} y2={s.b.y}
            stroke={hot ? "#60a5fa" : s.kind === "evidence" ? "#facc15" : "#334155"} strokeWidth={hot ? 3 : s.kind === "evidence" ? 1.6 : 1.2}
            strokeDasharray={s.kind === "evidence" ? "5 4" : undefined} opacity={dim ? 0.15 : hot ? 1 : s.kind === "evidence" ? 0.8 : 0.7} className={hot ? "edge-hot" : undefined} />;
        })}
        {bodies.current.map((b) => {
          const n = b.n, c = colorOf(b), isLit = lit(b.id), sel = selected === b.id;
          const added = n.status === "added", retired = n.status === "retired", ev = n.status === "evidence";
          const dim = selSet ? !selSet.has(b.id) : false;
          const label = shortLabel(n);
          const big = n.kind === "site" || n.kind === "zone";
          return (
            <g key={b.id} transform={`translate(${b.x},${b.y})`} opacity={dim ? 0.25 : retired ? 0.45 : 1} style={{ cursor: interactive ? "grab" : "pointer" }}
              onMouseDown={(e) => onDown(e, b)} onClick={(e) => { e.stopPropagation(); onSelect(n); }}
              onMouseEnter={(e) => onHover?.(n, e)} onMouseLeave={() => onHover?.(null)}>
              {isLit && <circle r={b.r + 6} fill="none" stroke="#60a5fa" strokeWidth={3} className="pulse-ring" />}
              {isLit && <circle r={b.r + 2} fill="#60a5fa" opacity={0.25} />}
              {added && <circle r={b.r + 4} fill="none" stroke="#22c55e" strokeWidth={2.5} filter="url(#fgglow)" />}
              <circle r={b.r} fill={ev ? "#0b111c" : c} fillOpacity={big ? 0.95 : ev ? 1 : 0.9} stroke={sel ? "#fff" : ev ? c : "#05080f"} strokeWidth={sel ? 3 : ev ? 2 : 1.5} strokeDasharray={retired ? "3 3" : undefined} />
              {n.kind === "site" && <text textAnchor="middle" y={5} fill="#0f172a" fontSize={13} fontWeight={800}>SITE</text>}
              {n.kind === "zone" && <text textAnchor="middle" y={5} fill="#0f172a" fontSize={15} fontWeight={800}>{label}</text>}
              {n.kind !== "site" && n.kind !== "zone" && (
                <text x={0} y={b.r + 13} textAnchor="middle" fill={ev ? c : "#e5eaf3"} fontSize={n.kind === "task" ? 10.5 : 11} fontWeight={n.kind === "task" ? 600 : 700}
                  fontFamily={n.kind === "task" ? "Inter, sans-serif" : "JetBrains Mono, monospace"} style={retired ? { textDecoration: "line-through" } : undefined}>
                  {label.length > 26 ? label.slice(0, 25) + "…" : label}
                </text>
              )}
              {!ev && n.kind !== "site" && n.kind !== "zone" && n.kind !== "task" && n.value !== undefined && (
                <text y={b.r + 25} textAnchor="middle" fill="#8b98ad" fontSize={10} fontFamily="JetBrains Mono, monospace">= {String(n.value)}{n.since ? ` · v${n.since}` : ""}</text>
              )}
              {added && <text y={-b.r - 8} textAnchor="middle" fill="#22c55e" fontSize={11} fontWeight={700}>+v{n.since}</text>}
              {retired && <text y={-b.r - 8} textAnchor="middle" fill="#f87171" fontSize={11} fontWeight={700}>retired v{n.until}</text>}
              {caption?.get(b.id) && <text y={-b.r - 10} textAnchor="middle" fill="#93c5fd" fontSize={12} fontWeight={600} className="read-caption">{caption.get(b.id)}</text>}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
