/**
 * Builds specs/offshore.json — "Northstar Offshore Platform".
 *
 * The platform is intentionally authored as data: adding this environment
 * requires only this generator and the registry entry, not engine constants.
 * Run: node scripts/build_offshore_spec.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const W = 100, D = 80, H = 26;
const r2 = (n) => Math.round(n * 100) / 100;
const fixtures = [], locations = [];
const addLocation = (id, kind, zone, floor, access_point, fixture_id = null) => locations.push({ id, kind, zone, floor, fixture_id, level_range: null, access_point });

// ── Open steel decks and vertical access ──────────────────────
for (const [id, floor] of [["WALK-F1", 1], ["WALK-F2", 2], ["WALK-F3", 3]]) {
  fixtures.push({ id, kind: "walkway", floor, polygon: [[3, 3], [97, 3], [97, 77], [3, 77]], robots_allowed: true, speed_limit_mps: 1.1, surface: "grated" });
}
fixtures.push(
  { id: "PARK-OPS", kind: "parking", floor: 1, rect: [10, 70, 30, 77], slots: 12 },
  { id: "STAIR-F1F2", kind: "stairs", floor: 1, position: [42, 0, 60], rotation: 0, from_floor: 1, to_floor: 2, rect: [41, 58, 45, 66], blocks_grid: true },
  { id: "STAIR-F2F3", kind: "stairs", floor: 2, position: [42, 0, 60], rotation: 0, from_floor: 2, to_floor: 3, rect: [41, 58, 45, 66], blocks_grid: true },
);

// ── Wellbay: christmas trees and process equipment ────────────
const wellheads = [[14, 18], [23, 18], [32, 18], [14, 31], [23, 31], [32, 31]];
wellheads.forEach(([x, z], i) => {
  const id = `WH-${String(i + 1).padStart(2, "0")}`;
  fixtures.push({ id, kind: "wellhead", zone: "WELLBAY", floor: 2, position: [x, 0, z], blocks_grid: true });
  addLocation(id, "WELLHEAD", "WELLBAY", 2, [x + 2, z], id);
});
fixtures.push(
  { id: "FLARE-01", kind: "flare_stack", zone: "UTILITIES", floor: 2, position: [89, 0, 52], height: 15, blocks_grid: true },
  { id: "PIPERACK-01", kind: "pipe_rack", zone: "PROCESS", floor: 2, path: [[45, 12], [76, 12]], width: 3.2, pipe_count: 6, blocks_grid: true },
  { id: "MANIFOLD-01", kind: "manifold", zone: "PROCESS", floor: 2, rect: [51, 25, 63, 33], blocks_grid: true },
  { id: "TANK-01", kind: "storage_tank", zone: "UTILITIES", floor: 2, position: [82, 0, 30], radius: 5, height: 8, blocks_grid: true },
  { id: "TANK-02", kind: "storage_tank", zone: "UTILITIES", floor: 2, position: [82, 0, 45], radius: 4, height: 7, blocks_grid: true },
);
addLocation("FLARE-01", "FLARE", "UTILITIES", 2, [86, 52], "FLARE-01");
addLocation("PIPERACK-01", "PIPE_RACK", "PROCESS", 2, [48, 16], "PIPERACK-01");
addLocation("MANIFOLD-01", "MANIFOLD", "PROCESS", 2, [48, 29], "MANIFOLD-01");
addLocation("TANK-01", "TANK", "UTILITIES", 2, [75, 30], "TANK-01");
addLocation("TANK-02", "TANK", "UTILITIES", 2, [75, 45], "TANK-02");

// ── Splash-zone risers, accommodation and helideck ───────────
for (const z of [14, 30, 46, 62]) {
  const id = `RISER-${z}`;
  fixtures.push({ id, kind: "riser", zone: "SPLASH", floor: 1, position: [5, 0, z], blocks_grid: true });
  addLocation(id, "RISER", "SPLASH", 1, [7, z], id);
}
fixtures.push(
  { id: "QUARTERS-01", kind: "crew_quarters", zone: "ACCOMMODATION", floor: 3, rect: [8, 48, 34, 72], height: 7.5, blocks_grid: true },
  { id: "HELIDECK-01", kind: "helideck", zone: "HELIDECK", floor: 3, position: [76, 0, 63], radius: 12, floor: 3 },
);
addLocation("QUARTERS-01", "QUARTERS", "ACCOMMODATION", 3, [36, 60], "QUARTERS-01");
addLocation("HELIDECK-01", "HELIDECK", "HELIDECK", 3, [76, 47], "HELIDECK-01");

// ── Heavy machinery: pedestal crane, drilling derrick, laydown ─
// Crane pedestal ~3 m dia, 22 m lattice boom — typical offshore pedestal crane scale.
fixtures.push(
  { id: "CRANE-01", kind: "crane", zone: "UTILITIES", floor: 2, position: [92, 0, 66], boom_length: 22, rotation: 2.4, blocks_grid: true },
  { id: "DERRICK-01", kind: "derrick", zone: "WELLBAY", floor: 2, position: [23, 0, 24.5], height: 24, base: 7, blocks_grid: true },
  { id: "LAYDOWN-01", kind: "laydown", zone: "OPS", floor: 1, rect: [46, 8, 70, 26], blocks_grid: true },
);
addLocation("CRANE-01", "CRANE", "UTILITIES", 2, [88, 66], "CRANE-01");
addLocation("LAYDOWN-01", "LAYDOWN", "OPS", 1, [46, 28], "LAYDOWN-01");

// ── Safety & emergency response ─
fixtures.push(
  { id: "LIFEBOAT-01", kind: "lifeboat", zone: "ACCOMMODATION", floor: 3, position: [8, 0, 42], rotation: Math.PI / 2, blocks_grid: true },
  { id: "LIFEBOAT-02", kind: "lifeboat", zone: "ACCOMMODATION", floor: 3, position: [20, 0, 42], rotation: Math.PI / 2, blocks_grid: true },
  { id: "FIRE-01", kind: "fire_station", zone: "PROCESS", floor: 2, position: [46, 0, 40], blocks_grid: true },
  { id: "FIRE-02", kind: "fire_station", zone: "OPS", floor: 1, position: [38, 0, 62], blocks_grid: true },
);
addLocation("FIRE-01", "FIRE_STATION", "PROCESS", 2, [48, 42], "FIRE-01");
addLocation("FIRE-02", "FIRE_STATION", "OPS", 1, [40, 64], "FIRE-02");

// ── Subsea assets (render below the waterline; no nav impact) ─
fixtures.push(
  { id: "SUBSEA-PL-01", kind: "subsea_pipeline", zone: "SPLASH", floor: 1, path: [[5, 14], [-30, 20], [-70, 40]], depth: 26 },
  { id: "SUBSEA-PL-02", kind: "subsea_pipeline", zone: "SPLASH", floor: 1, path: [[5, 46], [-25, 60], [-60, 90]], depth: 26 },
  { id: "UMB-01", kind: "umbilical", zone: "SPLASH", floor: 1, position: [5, 0, 30], depth: 26 },
  { id: "UMB-02", kind: "umbilical", zone: "SPLASH", floor: 1, position: [5, 0, 62], depth: 26 },
  { id: "ANCHOR-01", kind: "anchor", zone: "SPLASH", floor: 1, position: [-40, 0, -20], depth: 26 },
  { id: "ANCHOR-02", kind: "anchor", zone: "SPLASH", floor: 1, position: [140, 0, -25], depth: 26 },
  { id: "ANCHOR-03", kind: "anchor", zone: "SPLASH", floor: 1, position: [-45, 0, 105], depth: 26 },
  { id: "ANCHOR-04", kind: "anchor", zone: "SPLASH", floor: 1, position: [145, 0, 100], depth: 26 },
);

// ── Walkable inspection endpoints + charging ──────────────────
for (const [id, kind, x] of [["INSPECT-01", "INSPECTION", 50], ["GAUGE-01", "GAUGE", 58], ["LEAK-01", "LEAK", 66]]) {
  addLocation(id, kind, "OPS", 1, [x, 68]);
}
for (const [id, floor, x, z] of [["CHG-F1A", 1, 12, 70], ["CHG-F1B", 1, 18, 70], ["CHG-F2A", 2, 48, 8], ["CHG-F3A", 3, 48, 8]]) {
  fixtures.push({ id, kind: "charger", zone: floor === 1 ? "OPS" : floor === 2 ? "PROCESS" : "ACCOMMODATION", floor, position: [x, 0, z], heading: Math.PI / 2, power_kw: 4.5, access_point: [x, z - 2] });
  addLocation(id, "CHARGING", floor === 1 ? "OPS" : floor === 2 ? "PROCESS" : "ACCOMMODATION", floor, [x, z - 2], id);
}

const spec = {
  schema_version: "2.0",
  meta: {
    id: "northstar-offshore-v1",
    name: "Northstar Offshore Production Platform",
    vertical: "offshore-oil-gas",
    description: "Three-deck offshore production platform with wellbay, process equipment, utilities, splash-zone risers, accommodation and helideck.",
  },
  site: { units: "m", size: { width: W, depth: D, height: H }, grid: { cell_size: 1, cols: W, rows: D } },
  floors: [
    { id: 1, name: "Lower Deck · Splash Zone", elevation: 0 },
    { id: 2, name: "Main Deck · Production", elevation: 7, footprint: [[3, 3], [97, 3], [97, 77], [3, 77]] },
    { id: 3, name: "Upper Deck · Accommodation", elevation: 14, footprint: [[3, 3], [97, 3], [97, 77], [3, 77]] },
  ],
  zones: [
    { id: "SPLASH", name: "Splash Zone", color: "#0ea5e9", floor: 1, ex_zone: 0, polygon: [[3, 3], [97, 3], [97, 77], [3, 77]] },
    { id: "WELLBAY", name: "Wellbay", color: "#f97316", floor: 2, ex_zone: 0, polygon: [[7, 10], [41, 10], [41, 46], [7, 46]] },
    { id: "PROCESS", name: "Process Area", color: "#ef4444", floor: 2, ex_zone: 1, polygon: [[43, 8], [78, 8], [78, 46], [43, 46]] },
    { id: "UTILITIES", name: "Utilities", color: "#eab308", floor: 2, ex_zone: 2, polygon: [[79, 8], [96, 8], [96, 58], [79, 58]] },
    { id: "ACCOMMODATION", name: "Accommodation", color: "#22c55e", floor: 3, ex_zone: "safe", polygon: [[6, 46], [38, 46], [38, 75], [6, 75]] },
    { id: "HELIDECK", name: "Helideck", color: "#a78bfa", floor: 3, ex_zone: "safe", polygon: [[61, 49], [92, 49], [92, 77], [61, 77]] },
    { id: "OPS", name: "Operations", color: "#14b8a6", floor: 1, ex_zone: "safe", polygon: [[40, 58], [75, 58], [75, 77], [40, 77]] },
  ],
  fixtures,
  lifts: [
    { id: "LIFT-A", cell: [90, 8], floors: [1, 2, 3], ride_ticks: 65 },
    { id: "LIFT-B", cell: [90, 18], floors: [1, 2, 3], ride_ticks: 65 },
  ],
  locations,
  fleet: {
    classes: [
      { id: "INSP-Q", max_speed: 0.85, capacity: 1, lidar: { range_m: 5, fov_deg: 270 }, locomotion: "legged", can_climb_stairs: true, terrain_tolerance: 1, min_clearance_cells: 1, ex_certified_zones: [0, 1, 2] },
      { id: "INSP-L", max_speed: 1.0, capacity: 2, lidar: { range_m: 4, fov_deg: 240 }, crawler: true, ex_certified_zones: [1] },
      { id: "AMR-M", max_speed: 1.2, capacity: 2, lidar: { range_m: 5, fov_deg: 240 } },
      { id: "DRONE-I", max_speed: 4.5, capacity: 0, lidar: { range_m: 12, fov_deg: 360 }, locomotion: "aerial", flight: { cruise_alt_m: 8, max_flight_ticks: 1600, rth_battery_pct: 25 } },
      { id: "SENSOR-F", max_speed: 0, capacity: 0, lidar: { range_m: 20, fov_deg: 360 }, locomotion: "static" },
    ],
    spawns: [
      { id: "IQ01", class: "INSP-Q", position: [14.5, 0, 70.5], heading: 0, battery: 92, floor: 1 },
      { id: "IQ02", class: "INSP-Q", position: [22.5, 0, 70.5], heading: 0, battery: 86, floor: 1 },
      { id: "IQ03", class: "INSP-Q", position: [48.5, 0, 8.5], heading: 0, battery: 90, floor: 2 },
      { id: "IL01", class: "INSP-L", position: [54.5, 0, 8.5], heading: 0, battery: 78, floor: 3 },
      { id: "AMR01", class: "AMR-M", position: [30.5, 0, 70.5], heading: 0, battery: 88, floor: 1 },
      // Helideck pad surface sits ~0.2 m above deck elevation 14; skid-height spawn keeps the airframe visible
      { id: "DR01", class: "DRONE-I", position: [76.5, 14.2, 63.5], heading: 0, battery: 96, floor: 3 },
      { id: "FS01", class: "SENSOR-F", position: [70.5, 0, 70.5], heading: 0, battery: 100, floor: 1 },
    ],
    static_actors: [
      { kind: "WORKER", position: [34, 0, 68], heading: 0.4 },
      { kind: "WORKER", position: [70, 7, 42], heading: 2.2 },
    ],
  },
  tasks: {
    types: [
      { id: "INSPECT", weight: 0.45, gen_source_kinds: ["WELLHEAD", "PIPE_RACK", "FLARE", "RISER"], gen_dest_kinds: ["INSPECTION"], allowed_source_kinds: ["WELLHEAD", "PIPE_RACK", "FLARE", "RISER"], allowed_dest_kinds: ["INSPECTION", "GAUGE", "LEAK"] },
      { id: "GAUGE_READ", weight: 0.3, gen_source_kinds: ["TANK", "WELLHEAD"], gen_dest_kinds: ["GAUGE"], allowed_source_kinds: ["TANK", "WELLHEAD"], allowed_dest_kinds: ["GAUGE", "INSPECTION"] },
      { id: "LEAK_SCAN", weight: 0.25, gen_source_kinds: ["RISER", "PIPE_RACK", "MANIFOLD"], gen_dest_kinds: ["LEAK"], allowed_source_kinds: ["RISER", "PIPE_RACK", "MANIFOLD"], allowed_dest_kinds: ["LEAK", "INSPECTION"] },
    ],
    interval_ticks: 45,
    max_waiting: 16,
    priority_bands: [[0.12, "HIGH"], [0.04, "CRITICAL"]],
    on_time_limit_ticks: 3000,
  },
  sim: { MAX_SPEED: 1.25, LIFT_TRAVEL_TICKS: 65, LIFT_DOOR_TICKS: 10 },
  kpis: { completed_target: 80, target_per_min: 0.7 },
  scenarios: {
    defaults: { robot: "IQ01", lift: "LIFT-A", camera: "CAM-PROC", zone: "PROCESS" },
    compound: [
      { kind: "ROBOT_BATTERY_SET", robot_id: "IQ01", battery: 8 },
      { kind: "HUMAN_INTRUSION", zone_id: "PROCESS", duration_ticks: 600 },
    ],
  },
  cameras: [
    { id: "CAM-WELL", zone: "WELLBAY", floor: 2, position: [8, 11, 8], look_at: [24, 7.5, 28], fov_deg: 70, range_m: 40 },
    { id: "CAM-PROC", zone: "PROCESS", floor: 2, position: [44, 12, 44], look_at: [62, 7.5, 24], fov_deg: 70, range_m: 36 },
    { id: "CAM-UTIL", zone: "UTILITIES", floor: 2, position: [95, 12, 30], look_at: [83, 7.5, 30], fov_deg: 70, range_m: 30 },
    { id: "CAM-HELIDECK", zone: "HELIDECK", floor: 3, position: [76, 22, 63], look_at: [76, 14, 63], fov_deg: 80, range_m: 30 },
  ],
  sensors: [
    { id: "S-GAS-WELL", kind: "LIDAR", zone: "WELLBAY", position: [24, 9, 28] },
    { id: "S-PRES-PROC", kind: "PRESENCE", zone: "PROCESS", position: [62, 8, 22] },
    { id: "S-TEMP-TANK", kind: "TEMP", zone: "UTILITIES", position: [82, 10, 31] },
  ],
  theme: {
    bg: "#06121a",
    floor: "#1d2a32",
    wall: "#10232b",
    accent: "#22d3ee",
    floor_markings: [[43, 7, 43, 76], [78, 7, 78, 58], [3, 57, 97, 57]],
    accent_lights: [[24, 9, 28, "#f97316"], [62, 9, 22, "#ef4444"], [76, 16, 63, "#a78bfa"]],
    subsystems: [
      { key: "SITE", label: "Platform" },
      { key: "CHARGING", label: "Charging" },
      { key: "CCTV", label: "CCTV" },
      { key: "NETWORK", label: "Telemetry" },
    ],
    robot_scale: 1.5,
    marine: true,
    water_level: -4,
    sim_start_hour: 6,
    sim_date: "2026/08/30",
    location_labels: { WELLHEAD: "Wellhead", PIPE_RACK: "Pipe Rack", FLARE: "Flare", TANK: "Tank", RISER: "Riser", MANIFOLD: "Manifold", INSPECTION: "Inspection", GAUGE: "Gauge", LEAK: "Leak Scan", HELIDECK: "Helideck", QUARTERS: "Quarters", CHARGING: "Charger" },
  },
  provenance: {
    "meta": { src: "research", ref: "offshore production platform terminology and ATEX/IEC Ex zone conventions", conf: 0.8 },
    "zones.WELLBAY.ex_zone": { src: "research", ref: "wellbay hazardous area classification", conf: 0.75 },
    "fixtures[FLARE-01]": { src: "research", ref: "elevated flare stack with tip flame", conf: 0.85 },
    "fixtures[HELIDECK-01]": { src: "research", ref: "offshore helideck safety layout", conf: 0.8 },
    "tasks.types": { src: "research", ref: "inspection, gauge-read and leak-scan patrol workflow", conf: 0.75 },
    "fixtures[CRANE-01]": { src: "research", ref: "offshore pedestal crane, ~20-25 m lattice boom", conf: 0.75 },
    "fixtures[DERRICK-01]": { src: "research", ref: "drilling derrick over wellbay, ~24 m tower", conf: 0.7 },
    "fixtures[LIFEBOAT-01]": { src: "research", ref: "davit-launched enclosed lifeboats at deck edge", conf: 0.8 },
    "theme.marine": { src: "research", ref: "jacket platform above waterline with subsea flowlines/umbilicals/mooring", conf: 0.75 },
  },
};

const out = join(here, "../src/specs/offshore.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(spec, null, 2));
console.log(`wrote ${out}: ${fixtures.length} fixtures, ${locations.length} locations, ${spec.fleet.spawns.length} robots`);
