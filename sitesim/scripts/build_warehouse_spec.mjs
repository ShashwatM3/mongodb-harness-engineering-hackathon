/**
 * Builds specs/warehouse.json — an EnvSpec that reproduces the reference
 * warehouse (WareTwin's synthetic 100×70 m layout) pixel-for-pixel.
 *
 * The reference layout JSON is read from the sibling WareTwin clone at build
 * time; only the generated spec is part of this project. Run:
 *   node scripts/build_warehouse_spec.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, "../../WareTwin/frontend/src/layout/warehouse_layout.json"), "utf8"));

const fixtures = [];
for (const r of ref.racks) fixtures.push({ id: r.id, kind: "rack", zone: r.zone, floor: r.floor ?? 1, position: r.position, size: r.size, rotation: r.rotation, levels: r.levels, model: "pallet", blocks_grid: r.blocks_grid });
for (const c of ref.conveyors) fixtures.push({ id: c.id, kind: "conveyor", zone: c.zone, name: c.name, path: c.path, width: c.width, speed_mps: c.speed_mps, blocks_grid: c.blocks_grid, ...(c.feeds ? { feeds: c.feeds } : {}) });
for (const s of ref.stations) fixtures.push({ id: s.id, kind: "station", zone: s.zone, station_kind: s.kind, rect: s.rect, access_point: s.access_point });
for (const d of ref.docks) fixtures.push({ id: d.id, kind: "dock", zone: d.zone, dock_kind: d.kind, rect: d.rect, door: d.door });
for (const c of ref.charging_stations) fixtures.push({ id: c.id, kind: "charger", zone: c.zone, position: c.position, heading: c.heading, power_kw: c.power_kw, access_point: c.access_point });
for (const p of ref.parking) fixtures.push({ id: p.id, kind: "parking", zone: p.zone, rect: p.rect, slots: p.slots });
for (const r of ref.restricted_areas) fixtures.push({ id: r.id, kind: "restricted", name: r.name, rect: r.rect, robots_allowed: r.robots_allowed });
for (const w of ref.walkways) fixtures.push({ id: w.id, kind: "walkway", polygon: w.polygon, robots_allowed: w.robots_allowed, speed_limit_mps: w.speed_limit_mps });
for (const o of ref.obstacles) fixtures.push({ id: o.id, kind: "obstacle", obstacle_kind: o.kind, rect: o.rect });
ref.columns.forEach((c, i) => fixtures.push({ id: `COL-${String(i + 1).padStart(2, "0")}`, kind: "column", position: c }));

const spec = {
  schema_version: "2.0",
  meta: {
    id: "warehouse-main-v1",
    name: "Main Warehouse (100×70m)",
    vertical: "warehouse",
    description: "Two-floor autonomous warehouse: 20 AMRs, 4 ground zones + mezzanine, 2 freight lifts, conveyors, packing/sorting stations, chargers, CCTV.",
  },
  site: { units: "m", size: ref.size, grid: ref.grid },
  floors: ref.floors,
  zones: ref.zones.map((z) => ({ ...z, ...(z.floor === 2 ? { capacity: 8 } : {}) })),
  fixtures,
  lifts: ref.lifts,
  locations: ref.locations.map((l) => ({ id: l.id, kind: l.kind, zone: l.zone, floor: l.floor ?? 1, fixture_id: l.rack_id ?? (["PACKING", "SORTING", "INBOUND", "OUTBOUND", "CHARGING"].includes(l.kind) ? l.id : null), level_range: l.level_range, access_point: l.access_point })),
  fleet: {
    classes: [{ id: "AMR-L", max_speed: 1.5, capacity: 4, lidar: { range_m: 4, fov_deg: 270 } }],
    spawns: ref.spawn.robots.map((r) => ({ id: r.id, class: "AMR-L", position: r.position, heading: r.heading, battery: r.battery, floor: r.floor ?? 1 })),
    static_actors: [
      { kind: "WORKER", position: [4.5, 0, 4.5], heading: 0 },
      { kind: "WORKER", position: [9.5, 0, 2.5], heading: 1.1 },
      { kind: "WORKER", position: [13.5, 0, 5.5], heading: 2.2 },
      { kind: "WORKER", position: [16, 0, 2.5], heading: 3.3 },
      { kind: "FORKLIFT", position: [8, 0, 4], heading: 0.4 },
    ],
  },
  tasks: {
    types: [
      { id: "PICK", weight: 0.55, gen_source_kinds: ["SHELF"], gen_dest_kinds: ["PACKING", "SORTING"], allowed_source_kinds: ["SHELF"], allowed_dest_kinds: ["PACKING", "SORTING", "OUTBOUND"] },
      { id: "REPLENISH", weight: 0.25, gen_source_kinds: ["INBOUND"], gen_dest_kinds: ["SHELF"], allowed_source_kinds: ["INBOUND"], allowed_dest_kinds: ["SHELF"] },
      { id: "TRANSPORT", weight: 0.2, gen_source_kinds: ["PACKING", "SORTING"], gen_dest_kinds: ["OUTBOUND"], allowed_source_kinds: ["PACKING", "SORTING", "INBOUND", "OUTBOUND"], allowed_dest_kinds: ["PACKING", "SORTING", "INBOUND", "OUTBOUND"] },
      { id: "RETURN", weight: 0, gen_source_kinds: ["PACKING"], gen_dest_kinds: ["SHELF"], allowed_source_kinds: ["PACKING", "SORTING", "OUTBOUND"], allowed_dest_kinds: ["SHELF"] },
    ],
    interval_ticks: 70,
    max_waiting: 12,
    priority_bands: [[0.15, "HIGH"], [0.03, "CRITICAL"]],
    on_time_limit_ticks: 2400,
  },
  kpis: { completed_target: 150, target_per_min: 1.25 },
  scenarios: {
    defaults: { robot: "R07", conveyor: "CV03", camera: "CAM-B03", lift: "LIFT-1", zone: "B" },
    compound: [
      { kind: "ROBOT_BATTERY_SET", robot_id: "R07", battery: 8 },
      { kind: "HUMAN_INTRUSION", zone_id: "B", duration_ticks: 600 },
      { kind: "CONVEYOR_FAILURE", conveyor_id: "CV03" },
    ],
  },
  cameras: ref.cameras,
  sensors: ref.sensors.map((s) => (s.id === "S-CV03" ? { ...s, of: "CV03" } : s)),
  theme: {
    bg: "#05080f",
    floor: "#1b2230",
    wall: "#151c29",
    accent: "#3b82f6",
    floor_markings: [[46.2, 10, 46.2, 62], [53.8, 10, 53.8, 62], [0, 9.8, 100, 9.8], [0, 8.2, 100, 8.2]],
    accent_lights: [[50, 10, 35, "#60a5fa"], [26, 8, 4, "#22c55e"], [74, 8, 4, "#22d3ee"]],
    subsystems: [
      { key: "SITE", label: "Warehouse" },
      { key: "CONVEYORS", label: "Conveyors" },
      { key: "CHARGING", label: "Charging" },
      { key: "CCTV", label: "CCTV" },
      { key: "NETWORK", label: "Network" },
    ],
    sim_start_hour: 8,
    sim_date: "2026/05/20",
    location_labels: { SHELF: "Shelf", PACKING: "Packing", SORTING: "Sorting", CHARGING: "Charger", INBOUND: "Inbound", OUTBOUND: "Outbound" },
  },
  provenance: {
    "site.size": { src: "reference", ref: "WareTwin wh-main-v1 layout", conf: 1 },
    "fixtures[rack]": { src: "reference", ref: "WareTwin wh-main-v1 racks (184)", conf: 1 },
    "fleet.classes[AMR-L]": { src: "reference", ref: "WareTwin AMR-L: 1.5 m/s, 270°/4 m LiDAR", conf: 1 },
    "tasks.types": { src: "reference", ref: "WareTwin task rules (PICK/REPLENISH/TRANSPORT/RETURN)", conf: 1 },
  },
};

const out = join(here, "../src/specs/warehouse.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(spec, null, 2));
console.log(`wrote ${out}: ${fixtures.length} fixtures, ${spec.locations.length} locations, ${spec.fleet.spawns.length} robots`);
