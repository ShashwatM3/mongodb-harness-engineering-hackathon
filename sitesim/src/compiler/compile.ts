import type {
  EnvSpec, Fixture, SpecLocation, RackFixture, ConveyorFixture, StationFixture, DockFixture,
  ChargerFixture, ParkingFixture, RestrictedFixture, WalkwayFixture, ObstacleFixture, ColumnFixture,
} from "../spec/types";
import { buildNavGrid, KNOWN_GRID_KINDS, type NavGrid } from "./navgrid";

/** A fixture kind the component library can't render/simulate yet → Devin ticket. */
export interface CapabilityGap { fixture_id: string; kind: string }

/** Fixture kinds with a bespoke renderer in the component library. */
export const RENDERABLE_KINDS = new Set([...KNOWN_GRID_KINDS]);

export interface CompiledSite {
  spec: EnvSpec;
  grids: Record<number, NavGrid>;
  clearance: Record<number, Uint8Array>;
  /** location id → location */
  locations: Record<string, SpecLocation>;
  /** floor id → elevation */
  floorElev: Record<number, number>;
  /** zone id → color */
  zoneColor: Record<string, string>;
  racks: RackFixture[];
  conveyors: ConveyorFixture[];
  stations: StationFixture[];
  docks: DockFixture[];
  chargers: ChargerFixture[];
  parking: ParkingFixture[];
  restricted: RestrictedFixture[];
  walkways: WalkwayFixture[];
  obstacles: ObstacleFixture[];
  columns: ColumnFixture[];
  /** Fixtures the library has no component for (rendered as placeholders) */
  unknown: Fixture[];
  gaps: CapabilityGap[];
}

/**
 * The deterministic compiler. Pure function of the spec — no randomness, no IO.
 * Everything the engine and the renderer need is precomputed and indexed here.
 */
export function compileSite(spec: EnvSpec): CompiledSite {
  const grids: Record<number, NavGrid> = {};
  for (const f of spec.floors) grids[f.id] = buildNavGrid(spec, f.id);
  const byKind = <T extends Fixture>(kind: string) => spec.fixtures.filter((f) => f.kind === kind) as T[];
  const unknown = spec.fixtures.filter((f) => !RENDERABLE_KINDS.has(f.kind));
  return {
    spec,
    grids,
    clearance: Object.fromEntries(Object.entries(grids).map(([floor, grid]) => [floor, grid.clearance])),
    locations: Object.fromEntries(spec.locations.map((l) => [l.id, l])),
    floorElev: Object.fromEntries(spec.floors.map((f) => [f.id, f.elevation])),
    zoneColor: Object.fromEntries(spec.zones.map((z) => [z.id, z.color])),
    racks: byKind("rack"),
    conveyors: byKind("conveyor"),
    stations: byKind("station"),
    docks: byKind("dock"),
    chargers: byKind("charger"),
    parking: byKind("parking"),
    restricted: byKind("restricted"),
    walkways: byKind("walkway"),
    obstacles: byKind("obstacle"),
    columns: byKind("column"),
    unknown,
    gaps: unknown.map((f) => ({ fixture_id: f.id, kind: f.kind })),
  };
}

/** Structural validation — returns human-readable problems (empty = valid). */
export function validateSpec(spec: EnvSpec): string[] {
  const errs: string[] = [];
  if (spec.schema_version !== "2.0") errs.push(`unsupported schema_version ${spec.schema_version}`);
  const zoneIds = new Set(spec.zones.map((z) => z.id));
  const floorIds = new Set(spec.floors.map((f) => f.id));
  const fixtureIds = new Set<string>();
  for (const f of spec.fixtures) {
    if (fixtureIds.has(f.id)) errs.push(`duplicate fixture id ${f.id}`);
    fixtureIds.add(f.id);
    if (f.zone && !zoneIds.has(f.zone)) errs.push(`fixture ${f.id} references unknown zone ${f.zone}`);
    if (f.floor !== undefined && !floorIds.has(f.floor)) errs.push(`fixture ${f.id} references unknown floor ${f.floor}`);
  }
  const locIds = new Set<string>();
  for (const l of spec.locations) {
    if (locIds.has(l.id)) errs.push(`duplicate location id ${l.id}`);
    locIds.add(l.id);
    if (!zoneIds.has(l.zone)) errs.push(`location ${l.id} references unknown zone ${l.zone}`);
    if (l.fixture_id && !fixtureIds.has(l.fixture_id)) errs.push(`location ${l.id} references unknown fixture ${l.fixture_id}`);
  }
  const classIds = new Set(spec.fleet.classes.map((c) => c.id));
  for (const r of spec.fleet.spawns) if (!classIds.has(r.class)) errs.push(`robot ${r.id} references unknown class ${r.class}`);
  const locKinds = new Set(spec.locations.map((l) => l.kind));
  for (const t of spec.tasks.types) {
    for (const k of [...t.gen_source_kinds, ...t.gen_dest_kinds])
      if (!locKinds.has(k)) errs.push(`task type ${t.id} draws from location kind ${k} but no such location exists`);
  }
  for (const l of spec.lifts) for (const f of l.floors) if (!floorIds.has(f)) errs.push(`lift ${l.id} serves unknown floor ${f}`);
  for (const c of spec.cameras) if (!zoneIds.has(c.zone)) errs.push(`camera ${c.id} references unknown zone ${c.zone}`);
  return errs;
}
