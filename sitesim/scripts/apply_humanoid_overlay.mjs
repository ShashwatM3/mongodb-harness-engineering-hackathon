/**
 * Applies the hackathon's humanoid overlay to specs/warehouse.json in place (idempotent).
 * The base file is generated from WareTwin by build_warehouse_spec.mjs; that generator needs the sibling
 * WareTwin clone, which this repository does not carry, so the overlay is a separate, re-runnable step.
 *
 *   node scripts/apply_humanoid_overlay.mjs
 *
 * What it changes:
 *  - fleet: one class HUM-1, a legged quadruped with one arm (locomotion "legged", can_climb_stairs, capacity 1,
 *    max_speed 1.5); every spawn becomes HUM-1.
 *  - fixtures: the west stairs between floor 1 (zone C) and the mezzanine, one fixture per floor so both nav
 *    grids carry the stair cells (value 3: legged robots only).
 *  - tasks: RETURN gets a nonzero weight so the whole zone × type catalog occurs.
 *  - sim: the frozen stair costs (spec settings, never the brain's).
 *  - meta.id: warehouse-humanoid (the runner's spec_id).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "../src/specs/warehouse.json");
const spec = JSON.parse(readFileSync(path, "utf8"));

spec.meta.id = "warehouse-humanoid";
spec.meta.name = "Main Warehouse (100×70m) · HUM-1 fleet";
spec.meta.description = "Two-floor warehouse run by 20 HUM-1 legged robots (quadruped + arm): 4 ground zones + mezzanine, 2 freight lifts, west stairs, conveyors, packing/sorting, chargers, CCTV.";

const amr = spec.fleet.classes.find((c) => c.id === "AMR-L") ?? spec.fleet.classes[0];
spec.fleet.classes = [{
  id: "HUM-1", max_speed: 1.5, capacity: 1, lidar: amr.lidar,
  locomotion: "legged", can_climb_stairs: true, terrain_tolerance: 1, min_clearance_cells: 1,
}];
for (const r of spec.fleet.spawns) r.class = "HUM-1";

const STAIR_RECT = [8, 48, 10, 50]; // cols 8-9, rows 48-49: clear on both floors, inside zone C and the mezzanine footprint
spec.fixtures = spec.fixtures.filter((f) => f.kind !== "stairs");
spec.fixtures.push(
  { id: "STAIR-W-F1", kind: "stairs", zone: "C", floor: 1, position: [9, 0, 49], rotation: 0, from_floor: 1, to_floor: 2, rect: STAIR_RECT, blocks_grid: true },
  { id: "STAIR-W-F2", kind: "stairs", zone: "M", floor: 2, position: [9, 0, 49], rotation: 0, from_floor: 2, to_floor: 1, rect: STAIR_RECT, blocks_grid: true },
);

for (const t of spec.tasks.types) {
  if (t.id === "PICK") t.weight = 0.5;
  if (t.id === "RETURN") t.weight = 0.1;
}

spec.sim = { ...(spec.sim ?? {}), STAIR_CLIMB_TICKS: 240, STAIR_CAPACITY: 2, STAIR_LOAD_TICKS: 40, BATTERY_STAIR: 0.01 };

spec.theme.location_labels = { ...spec.theme.location_labels };
spec.provenance = {
  ...(spec.provenance ?? {}),
  "fleet.classes[HUM-1]": { src: "interview", ref: "team decision 2026-10-11: legged quadruped with one arm and torso lift; can_climb_stairs", conf: 0.9 },
  "fixtures[STAIR-W-*]": { src: "blueprint", ref: "west stairwell in zone C to the mezzanine, added for the stairs-versus-lift lever", conf: 0.8 },
  "sim.STAIR_*": { src: "research", ref: "stair costs frozen as spec settings; the brain never edits them", conf: 0.7 },
};

writeFileSync(path, JSON.stringify(spec, null, 2));
console.log(`overlay applied: ${spec.fleet.spawns.length} HUM-1 robots, stairs ${JSON.stringify(STAIR_RECT)}, RETURN weight ${spec.tasks.types.find((t) => t.id === "RETURN").weight}`);
