import type {
  EnvSpec, ConveyorFixture, RackFixture, StationFixture, RestrictedFixture, WalkwayFixture, ObstacleFixture,
  ColumnFixture, ChargerFixture, UnknownFixture, Fixture, WellheadFixture, FlareStackFixture, PipeRackFixture,
  ManifoldFixture, StorageTankFixture, RiserFixture, CrewQuartersFixture, StairsFixture,
  CraneFixture, DerrickFixture, LaydownFixture, LifeboatFixture, FireStationFixture,
} from "../spec/types";

export interface NavGrid {
  cols: number;
  rows: number;
  cells: Uint8Array;
  /** Maximum square radius of walkable cells around each cell (including itself). */
  clearance: Uint8Array;
}

/**
 * Deterministic compile step: EnvSpec → per-floor occupancy grid.
 * 0 = walkable, 1 = blocked, 2 = walkway (walkable, higher cost / slower),
 * 3 = stair flight (walkable only to stair-capable legged robots).
 * The renderer draws from the same spec, so what you see is what paths avoid.
 */
export function buildNavGrid(spec: EnvSpec, floor = 1): NavGrid {
  const { cols, rows, cell_size: cs } = spec.site.grid;
  const cells = new Uint8Array(cols * rows);

  const fillRect = (x0: number, z0: number, x1: number, z1: number, v: number) => {
    const c0 = Math.max(0, Math.floor(x0 / cs)), c1 = Math.min(cols - 1, Math.ceil(x1 / cs) - 1);
    const r0 = Math.max(0, Math.floor(z0 / cs)), r1 = Math.min(rows - 1, Math.ceil(z1 / cs) - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = v;
  };

  // Lift shafts (steel frame + mesh guard) are physical obstructions on every
  // floor; boarding/alighting bypasses the grid via the lift state machine.
  // x: ±1.4 (covers 2.8 m shaft), z: ±1.9 (covers 3.6 m depth + swing margin).
  const blockLifts = () => {
    for (const l of spec.lifts) {
      const x = l.cell[0] + 0.5, z = l.cell[1] + 0.5;
      fillRect(x - 1.4, z - 1.9, x + 1.4, z + 1.9, 1);
    }
  };

  const of = <T,>(kind: string) => spec.fixtures.filter((f) => f.kind === kind) as T[];
  const fixtureFloor = (f: Fixture) => f.floor ?? 1;
  const blockPoly = (path: Array<[number, number]>, width: number) => {
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i], [bx, bz] = path[i + 1], hw = width / 2;
      fillRect(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw, 1);
    }
  };
  const blockOffshore = (f: Fixture) => {
    if (f.kind === "wellhead") {
      const x = f as WellheadFixture;
      if (x.blocks_grid) fillRect(x.position[0] - 0.8, x.position[2] - 0.8, x.position[0] + 0.8, x.position[2] + 0.8, 1);
    } else if (f.kind === "flare_stack") {
      const x = f as FlareStackFixture;
      if (x.blocks_grid) fillRect(x.position[0] - 1.2, x.position[2] - 1.2, x.position[0] + 1.2, x.position[2] + 1.2, 1);
    } else if (f.kind === "pipe_rack") {
      const x = f as PipeRackFixture;
      if (x.blocks_grid) blockPoly(x.path, x.width);
    } else if (f.kind === "manifold") {
      const x = f as ManifoldFixture;
      if (x.blocks_grid) fillRect(x.rect[0], x.rect[1], x.rect[2], x.rect[3], 1);
    } else if (f.kind === "storage_tank") {
      const x = f as StorageTankFixture;
      if (x.blocks_grid) fillRect(x.position[0] - x.radius, x.position[2] - x.radius, x.position[0] + x.radius, x.position[2] + x.radius, 1);
    } else if (f.kind === "riser") {
      const x = f as RiserFixture;
      if (x.blocks_grid) fillRect(x.position[0] - 0.5, x.position[2] - 0.5, x.position[0] + 0.5, x.position[2] + 0.5, 1);
    } else if (f.kind === "crew_quarters") {
      const x = f as CrewQuartersFixture;
      if (x.blocks_grid) fillRect(x.rect[0], x.rect[1], x.rect[2], x.rect[3], 1);
    } else if (f.kind === "stairs") {
      const x = f as StairsFixture;
      if (x.blocks_grid) {
        if (x.rect) fillRect(x.rect[0], x.rect[1], x.rect[2], x.rect[3], 3);
        else fillRect(x.position[0] - 1, x.position[2] - 1, x.position[0] + 1, x.position[2] + 1, 3);
      }
    } else if (f.kind === "crane") {
      const x = f as CraneFixture;
      if (x.blocks_grid) fillRect(x.position[0] - 1.6, x.position[2] - 1.6, x.position[0] + 1.6, x.position[2] + 1.6, 1);
    } else if (f.kind === "derrick") {
      const x = f as DerrickFixture;
      if (x.blocks_grid) { const h = x.base / 2; fillRect(x.position[0] - h, x.position[2] - h, x.position[0] + h, x.position[2] + h, 1); }
    } else if (f.kind === "laydown") {
      const x = f as LaydownFixture;
      // Cargo stacks occupy the inner half of the apron; the marked border stays walkable
      if (x.blocks_grid) { const [x0, z0, x1, z1] = x.rect, mx = (x1 - x0) / 4, mz = (z1 - z0) / 4; fillRect(x0 + mx, z0 + mz, x1 - mx, z1 - mz, 1); }
    } else if (f.kind === "lifeboat") {
      const x = f as LifeboatFixture;
      if (x.blocks_grid) fillRect(x.position[0] - 2, x.position[2] - 1.2, x.position[0] + 2, x.position[2] + 1.2, 1);
    } else if (f.kind === "fire_station") {
      const x = f as FireStationFixture;
      if (x.blocks_grid) fillRect(x.position[0] - 0.8, x.position[2] - 0.8, x.position[0] + 0.8, x.position[2] + 0.8, 1);
    }
    // subsea_pipeline / umbilical / anchor render below the waterline — no nav-grid impact
  };

  if (floor !== 1) {
    // Upper floors: outside the slab footprint = void = blocked; inside walkable minus fixtures.
    cells.fill(1);
    const fp = spec.floors.find((f) => f.id === floor)?.footprint;
    if (fp) {
      const xs = fp.map((p) => p[0]), zs = fp.map((p) => p[1]);
      const c0 = Math.max(0, Math.floor(Math.min(...xs) / cs)), c1 = Math.min(cols - 1, Math.ceil(Math.max(...xs) / cs) - 1);
      const r0 = Math.max(0, Math.floor(Math.min(...zs) / cs)), r1 = Math.min(rows - 1, Math.ceil(Math.max(...zs) / cs) - 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c] = 0;
    }
    for (const f of spec.fixtures) {
      if (fixtureFloor(f) !== floor || !["rack", "wellhead", "flare_stack", "pipe_rack", "manifold", "storage_tank", "riser", "crew_quarters", "stairs", "crane", "derrick", "laydown", "lifeboat", "fire_station"].includes(f.kind)) continue;
      if (f.kind === "rack" && (f as RackFixture).blocks_grid) {
        const r = f as RackFixture;
        fillRect(r.position[0], r.position[2], r.position[0] + r.size[0], r.position[2] + r.size[2], 1);
      }
      else blockOffshore(f);
    }
    blockLifts();
    return { cols, rows, cells, clearance: buildClearance(cells, cols, rows) };
  }

  for (const w of of<WalkwayFixture>("walkway")) if ((w.floor ?? 1) === 1) {
    const xs = w.polygon.map((p) => p[0]), zs = w.polygon.map((p) => p[1]);
    fillRect(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), 2);
  }
  for (const r of of<RackFixture>("rack")) if (r.blocks_grid && (r.floor ?? 1) === 1)
    fillRect(r.position[0], r.position[2], r.position[0] + r.size[0], r.position[2] + r.size[2], 1);
  for (const c of of<ConveyorFixture>("conveyor")) if (c.blocks_grid) {
    for (let i = 0; i < c.path.length - 1; i++) {
      const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1], hw = c.width / 2;
      fillRect(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw, 1);
    }
  }
  for (const ra of of<RestrictedFixture>("restricted")) if (!ra.robots_allowed) fillRect(ra.rect[0], ra.rect[1], ra.rect[2], ra.rect[3], 1);
  for (const s of of<StationFixture>("station")) fillRect(s.rect[0], s.rect[1], s.rect[2], s.rect[3], 1);
  for (const col of of<ColumnFixture>("column")) fillRect(col.position[0] - 0.45, col.position[1] - 0.45, col.position[0] + 0.45, col.position[1] + 0.45, 1);
  for (const o of of<ObstacleFixture>("obstacle")) fillRect(o.rect[0], o.rect[1], o.rect[2], o.rect[3], 1);
  // Charger cabinets are physical; the pad in front stays walkable.
  for (const c of of<ChargerFixture>("charger")) fillRect(c.position[0] - 0.45, c.position[2] - 0.4, c.position[0] + 0.45, c.position[2] + 0.5, 1);
  for (const f of spec.fixtures) if (fixtureFloor(f) === 1) blockOffshore(f);
  // Unknown-but-blocking fixtures: safest to block their declared extent so the
  // placeholder proxy is never driven through.
  for (const f of spec.fixtures) {
    if (KNOWN_GRID_KINDS.has(f.kind)) continue;
    const u = f as UnknownFixture;
    if (!u.blocks_grid) continue;
    if (u.rect) fillRect(u.rect[0], u.rect[1], u.rect[2], u.rect[3], 1);
    else if (u.position && u.size) fillRect(u.position[0], u.position[2], u.position[0] + u.size[0], u.position[2] + u.size[2], 1);
  }
  blockLifts();
  return { cols, rows, cells, clearance: buildClearance(cells, cols, rows) };
}

function buildClearance(cells: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(cells.length);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (cells[r * cols + c] === 1) continue;
    let radius = 1;
    for (; radius < 255; radius++) {
      let clear = true;
      for (let dr = -radius; dr <= radius && clear; dr++) for (let dc = -radius; dc <= radius; dc++) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows || cells[rr * cols + cc] === 1) { clear = false; break; }
      }
      if (!clear) break;
    }
    out[r * cols + c] = radius - 1;
  }
  return out;
}

/** Fixture kinds the nav-grid compiler natively understands. */
export const KNOWN_GRID_KINDS = new Set([
  "rack", "conveyor", "station", "dock", "charger", "parking", "restricted", "walkway", "obstacle", "column",
  "wellhead", "flare_stack", "pipe_rack", "manifold", "storage_tank", "riser", "helideck", "crew_quarters", "stairs",
  "crane", "derrick", "laydown", "lifeboat", "fire_station", "subsea_pipeline", "umbilical", "anchor",
]);
