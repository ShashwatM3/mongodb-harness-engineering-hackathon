/**
 * Shared data layer for the harness "brain" read API.
 *
 * One EventSource for the whole app (ref-counted), one cached copy of /api/brain/versions and
 * /api/scores, and a small graph cache keyed by "v:compare_to". Both BrainPanel (side panel)
 * and BrainGraphView (center tab) consume this module so the harness is never polled twice.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export const API = import.meta.env.VITE_HARNESS_API ?? "http://localhost:8000";

export type Status = "skeleton" | "added" | "unchanged" | "retired" | "evidence";
export interface BNode {
  id: string; kind: string; label: string; parent_id: string | null; status: Status;
  key?: string; value?: unknown; since?: number | null; until?: number | null; evidence?: Record<string, unknown>; lever?: string;
}
export interface BLink { source: string; target: string; kind: "scope" | "evidence" }
export interface Graph { version: number; compare_to: number | null; nodes: BNode[]; links: BLink[] }
export interface VersionEntry {
  version: number; parent: number | null; hypothesis?: string;
  added?: number | string[]; retired?: number | string[]; edits?: unknown[]; habit?: unknown; heldout_passed?: boolean | null;
}
export interface Versions { latest: number; chain: VersionEntry[] }
export interface Scores { version: number; zones: Record<string, number>; worst_zone?: string | null; v1?: Record<string, number> }
export interface Ev { kind: string; at?: string; [k: string]: unknown }
export interface Incident { incident_id: string; open_url: string; plain_summary: string }
export interface Explain {
  component?: Record<string, unknown> & { _id?: string; label?: string; key?: string; value?: unknown; kind?: string; parent_id?: string; since?: number; until?: number | null };
  evidence?: Record<string, unknown>;
  habit?: unknown; episodes?: unknown[]; gate_run?: unknown; heldout_passed?: boolean | null; markdown?: string;
}

export async function getJson<T>(path: string): Promise<T | null> {
  try { const r = await fetch(API + path); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

/** Count of a chain field that the harness may report either as a number or as a list of ids. */
export const countOf = (x: number | string[] | undefined | null) => (Array.isArray(x) ? x.length : typeof x === "number" ? x : 0);

// ── Versions + scores: one cached snapshot, refreshed on demand ───────────────────────────

interface Snap { versions: Versions | null; scores: Scores | null }
let snap: Snap = { versions: null, scores: null };
const snapSubs = new Set<() => void>();
const emitSnap = () => snapSubs.forEach((f) => f());

export async function refreshBrain() {
  const [vs, sc] = await Promise.all([getJson<Versions>("/api/brain/versions"), getJson<Scores>("/api/scores")]);
  snap = { versions: vs ?? snap.versions, scores: sc ?? snap.scores };
  emitSnap();
}

let bootstrapped = false;
export function useBrainSnapshot(): Snap {
  useEffect(() => { if (!bootstrapped) { bootstrapped = true; refreshBrain(); } }, []);
  return useSyncExternalStore((cb) => { snapSubs.add(cb); return () => { snapSubs.delete(cb); }; }, () => snap);
}

// ── Graph fetch with a small cache (invalidated whenever the latest version changes) ──────

const graphCache = new Map<string, Graph>();
export function invalidateGraphs() { graphCache.clear(); }

export function useBrainGraph(v: number | null, compareTo: number | null, epoch: number) {
  const [graph, setGraph] = useState<Graph | null>(null);
  useEffect(() => {
    if (v === null) return;
    const key = `${v}:${compareTo ?? ""}:${epoch}`;
    const hit = graphCache.get(key);
    if (hit) { setGraph(hit); return; }
    let stale = false;
    const q = compareTo !== null && compareTo !== v ? `&compare_to=${compareTo}` : "";
    getJson<Graph>(`/api/brain/graph?v=${v}${q}`).then((g) => { if (g && !stale) { graphCache.set(key, g); setGraph(g); } });
    return () => { stale = true; };
  }, [v, compareTo, epoch]);
  return graph;
}

// ── One EventSource, ref-counted, exponential backoff ──────────────────────────────────────

const evSubs = new Set<(e: Ev) => void>();
const liveSubs = new Set<(live: boolean) => void>();
let es: EventSource | null = null, retryTimer = 0, retryDelay = 1000, isLive = false, refs = 0;

const setLiveState = (l: boolean) => { if (isLive !== l) { isLive = l; liveSubs.forEach((f) => f(l)); } };
function openSource() {
  if (es || refs === 0) return;
  es = new EventSource(API + "/api/events");
  es.onopen = () => { retryDelay = 1000; setLiveState(true); };
  es.onmessage = (m) => {
    let e: Ev; try { e = JSON.parse(m.data) as Ev; } catch { return; }
    // Keep the shared cache honest before fan-out, so every consumer sees fresh data on its refresh.
    if (e.kind === "promoted" || e.kind === "round_end" || e.kind === "evaluated") { invalidateGraphs(); refreshBrain(); }
    evSubs.forEach((f) => { try { f(e); } catch { /* one bad listener must not break the rest */ } });
  };
  es.onerror = () => {
    es?.close(); es = null; setLiveState(false);
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(openSource, retryDelay); retryDelay = Math.min(30000, retryDelay * 2);
  };
}
function closeSource() { es?.close(); es = null; clearTimeout(retryTimer); setLiveState(false); }

/** Subscribe to harness SSE events. The underlying EventSource is shared by every caller. Returns the live flag. */
export function useBrainEvents(onEvent?: (e: Ev) => void): boolean {
  const cb = useRef(onEvent); cb.current = onEvent;
  const [live, setLive] = useState(isLive);
  useEffect(() => {
    const fwd = (e: Ev) => cb.current?.(e);
    evSubs.add(fwd); liveSubs.add(setLive);
    refs++; openSource(); setLive(isLive);
    return () => {
      evSubs.delete(fwd); liveSubs.delete(setLive);
      if (--refs === 0) closeSource();
    };
  }, []);
  return live;
}

// ── Small formatting helpers shared by both views ──────────────────────────────────────────

export const fmtScore = (s: number | undefined) => s === undefined || s === null ? "—" : s <= 1 ? String(Math.round(s * 100)) : String(Math.round(s));
export const fmtDelta = (cur?: number, base?: number) => {
  if (cur === undefined || base === undefined) return null;
  const d = (cur <= 1 ? cur * 100 : cur) - (base <= 1 ? base * 100 : base);
  return { text: `${d >= 0 ? "+" : ""}${Math.round(d)}`, color: d > 0.5 ? "var(--green)" : d < -0.5 ? "var(--red)" : "var(--muted)" };
};
export const fmtVal = (v: unknown) => v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
