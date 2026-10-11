/**
 * Grid A* (8-directional, no corner cutting).
 * - grid.cells: 0 walkable, 1 blocked, 2 walkway (walkable, higher cost)
 * - blocked: transient obstacles (occupied cells, blocked zones) as a "c,r" string set
 * - costMap: optional per-cell extra cost (traffic congestion), length cols*rows
 * Returns the cell sequence excluding the start; null when unreachable.
 * Pure function, no randomness — same inputs, same output (what-if reproducibility).
 */
import type { GridCell } from "../schema/twin_state";
import type { NavGrid } from "../compiler/navgrid";

export type { NavGrid };

const SQRT2 = Math.SQRT2;
const DIRS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

class MinHeap {
  private a: Array<{ k: number; v: number }> = [];
  get size() { return this.a.length; }
  push(k: number, v: number) {
    const a = this.a; a.push({ k, v }); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop(): number {
    const a = this.a; const top = a[0].v; const last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].k < a[m].k) m = l; if (r < a.length && a[r].k < a[m].k) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

export function cellKey(c: number, r: number) { return `${c},${r}`; }

export function isWalkable(grid: NavGrid, c: number, r: number, blocked?: Set<string>): boolean {
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
  if (grid.cells[r * grid.cols + c] === 1) return false;
  if (blocked && blocked.has(cellKey(c, r))) return false;
  return true;
}

export interface AstarOptions {
  blocked?: Set<string>;
  costMap?: Float32Array;
  maxExpand?: number;
  /** Legged robots may enter stair cells (3); legacy callers keep them blocked. */
  allowStairs?: boolean;
  terrainTolerance?: number;
  minClearanceCells?: number;
}

export function astar(grid: NavGrid, start: GridCell, goal: GridCell, opts: AstarOptions = {}): GridCell[] | null {
  const { cols, rows, cells } = grid;
  const { blocked, costMap, maxExpand = 60000, allowStairs = false, terrainTolerance, minClearanceCells } = opts;
  const idx = (c: number, r: number) => r * cols + c;
  const canEnter = (c: number, r: number, transientBlocked = true) => {
    if (!isWalkable(grid, c, r, transientBlocked ? blocked : undefined)) return false;
    const v = cells[idx(c, r)];
    if (v === 3 && !allowStairs) return false;
    if (minClearanceCells && minClearanceCells > 1 && (grid.clearance?.[idx(c, r)] ?? 255) < minClearanceCells) return false;
    return true;
  };
  if (!canEnter(goal[0], goal[1], false)) return null; // wall goals fail fast (blocked set ignored: goal may be transiently occupied)
  const sIdx = idx(start[0], start[1]), gIdx = idx(goal[0], goal[1]);
  if (sIdx === gIdx) return [];
  const g = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const h = (c: number, r: number) => { const dx = Math.abs(c - goal[0]), dz = Math.abs(r - goal[1]); return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz); };
  const open = new MinHeap();
  g[sIdx] = 0; open.push(h(start[0], start[1]), sIdx);
  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (cur === gIdx) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (++expanded > maxExpand) return null;
    const cc = cur % cols, cr = (cur - cc) / cols;
    for (const [dx, dz, base] of DIRS) {
      const nc = cc + dx, nr = cr + dz;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = idx(nc, nr);
      if (closed[ni]) continue;
      const v = cells[ni];
      if (v === 1 || (v === 3 && !allowStairs)) continue;
      if (blocked && ni !== gIdx && blocked.has(cellKey(nc, nr))) continue;
      if (minClearanceCells && minClearanceCells > 1 && (grid.clearance?.[ni] ?? 255) < minClearanceCells) continue;
      // No corner cutting: diagonal moves need both orthogonal neighbors walkable
      if (dx !== 0 && dz !== 0) {
        if (!canEnter(cc + dx, cr) || !canEnter(cc, cr + dz)) continue;
      }
      const walkwayMultiplier = terrainTolerance === undefined ? 1.6 : Math.max(1, 1.6 / Math.max(0.1, terrainTolerance));
      let cost = base * (v === 2 ? walkwayMultiplier : 1);
      if (costMap) cost += costMap[ni];
      const ng = g[cur] + cost;
      if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; open.push(ng + h(nc, nr), ni); }
    }
  }
  if (came[gIdx] === -1) return null;
  const path: GridCell[] = [];
  for (let i = gIdx; i !== sIdx; i = came[i]) { const c = i % cols; path.push([c, (i - c) / cols]); }
  path.reverse();
  return path;
}

/** World → cell */
export function toCell(x: number, z: number, cellSize = 1): GridCell { return [Math.floor(x / cellSize), Math.floor(z / cellSize)]; }
/** Cell center → world */
export function cellCenter(c: GridCell, cellSize = 1): [number, number] { return [(c[0] + 0.5) * cellSize, (c[1] + 0.5) * cellSize]; }

/** Nearest walkable cell to (x,z) — insurance when an access point sits on a wall */
export function nearestWalkable(grid: NavGrid, x: number, z: number, blocked?: Set<string>): GridCell {
  const [c0, r0] = toCell(x, z);
  if (isWalkable(grid, c0, r0, blocked)) return [c0, r0];
  for (let rad = 1; rad < 8; rad++) {
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
      if (isWalkable(grid, c0 + dc, r0 + dr, blocked)) return [c0 + dc, r0 + dr];
    }
  }
  return [c0, r0];
}
