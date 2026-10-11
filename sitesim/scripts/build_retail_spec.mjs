/**
 * Builds specs/retail.json — "Aurora Dark Store", a retail fulfilment centre.
 *
 * This spec exists to prove the platform thesis: a structurally *different and
 * at-least-as-complex* environment (6 zones, two robot classes, cross-floor
 * bulk replenishment, 3 belts, 2 lifts, ~300 task endpoints) built purely as
 * data — zero engine or renderer changes. It also ships two fixture kinds the
 * component library does NOT know ("air_curtain", "cart_wash") to exercise the
 * capability-gap → placeholder pipeline.
 *
 * Run: node scripts/build_retail_spec.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const W = 96, D = 64, H = 12;
const F2_ELEV = 6.5;
const F2 = [44, 6, 90, 28]; // mezzanine bulk-storage footprint (x0, z0, x1, z1)

const fixtures = [];
const locations = [];
const r2 = (n) => Math.round(n * 100) / 100;

// ── Gondola shelving, zone G (Grocery Aisles): 6 rows × 11 bays ──
let aisleN = 0;
for (let r = 0; r < 6; r++) {
  const z = 8 + r * 3.6;
  for (let b = 0; b < 11; b++) {
    const x = 5 + b * 3.0;
    const id = `GOND-G${r + 1}${String(b + 1).padStart(2, "0")}`;
    fixtures.push({ id, kind: "rack", zone: "G", floor: 1, position: [x, 0, z], size: [2.5, 2.2, 0.9], rotation: 0, levels: 5, model: "gondola", blocks_grid: true });
    for (const dz of [-1.0, 0.9 + 1.0]) {
      aisleN++;
      locations.push({ id: `AISLE-G${String(aisleN).padStart(3, "0")}`, kind: "AISLE", zone: "G", floor: 1, fixture_id: id, level_range: [1, 5], access_point: [r2(x + 1.25), r2(z + dz)] });
    }
  }
}

// ── Cold cases, zone F (Fresh & Chilled): 4 rows × 9 bays ──
let coldN = 0;
for (let r = 0; r < 4; r++) {
  const z = 36 + r * 4.2;
  for (let b = 0; b < 9; b++) {
    const x = 5 + b * 3.6;
    const id = `COLD-F${r + 1}${String(b + 1).padStart(2, "0")}`;
    fixtures.push({ id, kind: "rack", zone: "F", floor: 1, position: [x, 0, z], size: [3.0, 2.0, 1.1], rotation: 0, levels: 4, model: "cold_case", blocks_grid: true });
    for (const dz of [-1.0, 1.1 + 1.0]) {
      coldN++;
      locations.push({ id: `COLD-${String(coldN).padStart(3, "0")}`, kind: "COLD", zone: "F", floor: 1, fixture_id: id, level_range: [1, 4], access_point: [r2(x + 1.5), r2(z + dz)] });
    }
  }
}

// ── Mezzanine bulk racks, zone M2: 4 rows × 10 bays (pallet racking) ──
let bulkN = 0;
for (let r = 0; r < 4; r++) {
  const z = 9 + r * 4.5;
  for (let b = 0; b < 10; b++) {
    const x = 46 + b * 3.6;
    const id = `BULK-M${r + 1}${String(b + 1).padStart(2, "0")}`;
    fixtures.push({ id, kind: "rack", zone: "M2", floor: 2, position: [x, 0, z], size: [3.0, 4.5, 1.1], rotation: 0, levels: 3, model: "pallet", blocks_grid: true });
    for (const dz of [-1.0, 1.1 + 1.0]) {
      bulkN++;
      locations.push({ id: `BULK-${String(bulkN).padStart(3, "0")}`, kind: "BULK", zone: "M2", floor: 2, fixture_id: id, level_range: [1, 3], access_point: [r2(x + 1.5), r2(z + dz)] });
    }
  }
}

// ── Stations ──
const stations = [
  { id: "PACKOUT-01", station_kind: "PACKOUT", zone: "X", rect: [45, 52, 56, 57], access_point: [50.5, 51] },
  { id: "PACKOUT-02", station_kind: "PACKOUT", zone: "X", rect: [57, 52, 68, 57], access_point: [62.5, 51] },
  { id: "STAGE-01", station_kind: "STAGE", zone: "D", rect: [74, 34, 90, 39], access_point: [82, 40] },
];
for (const s of stations) {
  fixtures.push({ id: s.id, kind: "station", zone: s.zone, station_kind: s.station_kind, rect: s.rect, access_point: s.access_point });
  locations.push({ id: s.id, kind: s.station_kind, zone: s.zone, floor: 1, fixture_id: s.id, level_range: null, access_point: s.access_point });
}

// ── Docks ──
const docks = [
  { id: "RECV-1", dock_kind: "RECEIVING", zone: "R", rect: [46, 0, 58, 6], door: [52, 0], ap: [52, 7] },
  { id: "RECV-2", dock_kind: "RECEIVING", zone: "R", rect: [60, 0, 72, 6], door: [66, 0], ap: [66, 7] },
  { id: "DISP-1", dock_kind: "DISPATCH", zone: "D", rect: [74, 58, 86, 64], door: [80, 64], ap: [80, 57] },
  { id: "DISP-2", dock_kind: "DISPATCH", zone: "D", rect: [61, 58, 73, 64], door: [67, 64], ap: [67, 57] },
];
for (const d of docks) {
  fixtures.push({ id: d.id, kind: "dock", zone: d.zone, dock_kind: d.dock_kind, rect: d.rect, door: d.door });
  locations.push({ id: d.id, kind: d.dock_kind, zone: d.zone, floor: 1, fixture_id: d.id, level_range: null, access_point: d.ap });
}

// ── Conveyors ──
fixtures.push(
  { id: "CV-A", kind: "conveyor", zone: "X", name: "Packout Belt A", path: [[45, 49], [68, 49]], width: 0.9, speed_mps: 0.6, blocks_grid: true, feeds: "PACKOUT-01" },
  { id: "CV-B", kind: "conveyor", zone: "R", name: "Inbound Decant Belt", path: [[48, 30.5], [76, 30.5]], width: 0.9, speed_mps: 0.5, blocks_grid: true, feeds: "PACKOUT-02" },
  { id: "CV-C", kind: "conveyor", zone: "F", name: "Cold Chain Belt", path: [[1.2, 36], [1.2, 58]], width: 0.8, speed_mps: 0.5, blocks_grid: true },
);

// ── Chargers / parking / restricted / walkways ──
for (let i = 0; i < 6; i++) {
  const x = 6 + i * 2.5;
  const id = `CHG-${String(i + 1).padStart(2, "0")}`;
  fixtures.push({ id, kind: "charger", zone: "F", position: [x, 0, 61.6], heading: Math.PI / 2, power_kw: 3.0, access_point: [x, 59.7] });
  locations.push({ id, kind: "CHARGING", zone: "F", floor: 1, fixture_id: id, level_range: null, access_point: [x, 59.7] });
}
fixtures.push(
  { id: "PARK-1", kind: "parking", zone: "F", rect: [24, 59, 44, 63], slots: 12 },
  { id: "RESTRICT-1", kind: "restricted", name: "Plant room", rect: [0, 0, 14, 6], robots_allowed: false },
  { id: "WALK-1", kind: "walkway", polygon: [[0, 28], [96, 28], [96, 34], [0, 34]], robots_allowed: true, speed_limit_mps: 0.8 },
  { id: "WALK-2", kind: "walkway", polygon: [[40, 6], [44, 6], [44, 58], [40, 58]], robots_allowed: true, speed_limit_mps: 1.0 },
);

// ── Structural pillars + mezzanine columns ──
const pillarPts = [];
for (const x of [0, 24, 48, 72, 96]) for (const z of [0, 64]) pillarPts.push([x, z]);
pillarPts.push([0, 32], [96, 32]);
pillarPts.forEach(([x, z], i) => fixtures.push({ id: `PILLAR-${String(i + 1).padStart(2, "0")}`, kind: "obstacle", obstacle_kind: "PILLAR", rect: [r2(x - 0.25), r2(z - 0.25), r2(x + 0.25), r2(z + 0.25)] }));
const cols = [[46, 8], [58, 8], [70, 8], [82, 8], [46, 26], [58, 26], [70, 26], [82, 26], [46, 17], [82, 17]];
cols.forEach((c, i) => fixtures.push({ id: `COL-${String(i + 1).padStart(2, "0")}`, kind: "column", position: c }));
// Belt end equipment footprints (grid must match the visuals)
for (const [x, z] of [[45, 49], [68, 49], [48, 30.5], [76, 30.5], [1.2, 36], [1.2, 58]])
  fixtures.push({ id: `CVEQ-${x}-${z}`, kind: "obstacle", obstacle_kind: "CONVEYOR_EQUIP", rect: [r2(x - 1.4), r2(z - 1.4), r2(x + 1.4), r2(z + 1.4)] });

// ── Capability gaps on purpose: kinds the component library does not know ──
fixtures.push(
  { id: "AIRCURT-01", kind: "air_curtain", zone: "F", rect: [4, 33.2, 12, 34.4], blocks_grid: false, throughput_note: "chilled zone entry" },
  { id: "CARTWASH-01", kind: "cart_wash", zone: "R", rect: [88, 0, 95, 5], blocks_grid: true },
);

// ── Fleet: pickers (AMR-S) + heavier dispatch tugs (AMR-T) ──
const spawns = [];
for (let i = 0; i < 14; i++) spawns.push({ id: `R${String(i + 1).padStart(2, "0")}`, class: "AMR-S", position: [25 + (i % 10) * 2.0, 0, 60 + Math.floor(i / 10) * 2.2], heading: -1.5708, battery: 68 + (i * 9) % 32, floor: 1 });
for (let i = 14; i < 18; i++) spawns.push({ id: `R${String(i + 1).padStart(2, "0")}`, class: "AMR-S", position: [48 + (i - 14) * 6.0, 0, 12], heading: 0, battery: 70 + (i * 7) % 30, floor: 2 });
for (let i = 18; i < 22; i++) spawns.push({ id: `T${String(i - 17).padStart(2, "0")}`, class: "AMR-T", position: [75 + (i - 18) * 2.4, 0, 42], heading: Math.PI / 2, battery: 76 + (i * 5) % 24, floor: 1 });

const spec = {
  schema_version: "2.0",
  meta: {
    id: "retail-darkstore-v1",
    name: "Aurora Dark Store (96×64m)",
    vertical: "retail",
    description: "Retail fulfilment centre: grocery aisles, chilled zone, mezzanine bulk storage over receiving, packout lines, dispatch bays, 22 robots in two classes, 2 freight lifts.",
  },
  site: { units: "m", size: { width: W, depth: D, height: H }, grid: { cell_size: 1.0, cols: W, rows: D } },
  floors: [
    { id: 1, name: "Sales Floor", elevation: 0.0 },
    { id: 2, name: "Mezzanine · Bulk Storage", elevation: F2_ELEV, footprint: [[F2[0], F2[1]], [F2[2], F2[1]], [F2[2], F2[3]], [F2[0], F2[3]]] },
  ],
  zones: [
    { id: "G", name: "Grocery Aisles", color: "#22c55e", floor: 1, polygon: [[4, 6], [40, 6], [40, 28], [4, 28]] },
    { id: "F", name: "Fresh & Chilled", color: "#38bdf8", floor: 1, polygon: [[4, 34], [40, 34], [40, 58], [4, 58]] },
    { id: "R", name: "Receiving", color: "#3b82f6", floor: 1, polygon: [[44, 6], [78, 6], [78, 28], [44, 28]] },
    { id: "X", name: "Checkout & Packout", color: "#a855f7", floor: 1, capacity: 5, polygon: [[44, 34], [68, 34], [68, 58], [44, 58]] },
    { id: "D", name: "Dispatch", color: "#f59e0b", floor: 1, capacity: 8, polygon: [[72, 34], [92, 34], [92, 58], [72, 58]] },
    { id: "M2", name: "Mezzanine Bulk", color: "#14b8a6", floor: 2, capacity: 8, polygon: [[F2[0], F2[1]], [F2[2], F2[1]], [F2[2], F2[3]], [F2[0], F2[3]]] },
  ],
  fixtures,
  lifts: [
    { id: "LIFT-A", cell: [86, 12], floors: [1, 2], ride_ticks: 55 },
    { id: "LIFT-B", cell: [86, 22], floors: [1, 2], ride_ticks: 55 },
  ],
  locations,
  fleet: {
    classes: [
      { id: "AMR-S", max_speed: 1.6, capacity: 2, lidar: { range_m: 3.5, fov_deg: 240 } },
      { id: "AMR-T", max_speed: 1.2, capacity: 6, lidar: { range_m: 4.5, fov_deg: 270 } },
    ],
    spawns,
    static_actors: [
      { kind: "WORKER", position: [3, 0, 3], heading: 0.4 },
      { kind: "WORKER", position: [7, 0, 2.5], heading: 1.6 },
      { kind: "WORKER", position: [11.5, 0, 4.2], heading: 2.6 },
      { kind: "FORKLIFT", position: [9, 0, 3], heading: 0.2 },
    ],
  },
  tasks: {
    types: [
      { id: "ORDER_PICK", weight: 0.5, gen_source_kinds: ["AISLE", "COLD"], gen_dest_kinds: ["PACKOUT"], allowed_source_kinds: ["AISLE", "COLD"], allowed_dest_kinds: ["PACKOUT", "STAGE", "DISPATCH"] },
      { id: "RESTOCK", weight: 0.2, gen_source_kinds: ["RECEIVING"], gen_dest_kinds: ["AISLE", "COLD"], allowed_source_kinds: ["RECEIVING"], allowed_dest_kinds: ["AISLE", "COLD", "BULK"] },
      { id: "BULK_DOWN", weight: 0.15, gen_source_kinds: ["BULK"], gen_dest_kinds: ["AISLE"], allowed_source_kinds: ["BULK"], allowed_dest_kinds: ["AISLE", "COLD"] },
      { id: "DISPATCH_RUN", weight: 0.15, gen_source_kinds: ["PACKOUT", "STAGE"], gen_dest_kinds: ["DISPATCH"], allowed_source_kinds: ["PACKOUT", "STAGE"], allowed_dest_kinds: ["DISPATCH", "STAGE"] },
    ],
    interval_ticks: 60,
    max_waiting: 14,
    priority_bands: [[0.12, "HIGH"], [0.04, "CRITICAL"]],
    on_time_limit_ticks: 2400,
  },
  kpis: { completed_target: 180, target_per_min: 1.5 },
  scenarios: {
    defaults: { robot: "R05", conveyor: "CV-A", camera: "CAM-X01", lift: "LIFT-A", zone: "X" },
    compound: [
      { kind: "ROBOT_BATTERY_SET", robot_id: "R05", battery: 8 },
      { kind: "HUMAN_INTRUSION", zone_id: "X", duration_ticks: 600 },
      { kind: "CONVEYOR_FAILURE", conveyor_id: "CV-A" },
    ],
  },
  cameras: [
    { id: "CAM-G01", zone: "G", floor: 1, position: [4.6, 4.2, 9.5], look_at: [22, 0.5, 9.5], fov_deg: 65, range_m: 28 },
    { id: "CAM-G02", zone: "G", floor: 1, position: [39.4, 4.2, 23.9], look_at: [22, 0.5, 23.9], fov_deg: 65, range_m: 28 },
    { id: "CAM-F01", zone: "F", floor: 1, position: [4.6, 4.2, 37.1], look_at: [22, 0.5, 37.1], fov_deg: 65, range_m: 28 },
    { id: "CAM-F02", zone: "F", floor: 1, position: [39.4, 4.2, 49.7], look_at: [22, 0.5, 49.7], fov_deg: 65, range_m: 28 },
    { id: "CAM-R01", zone: "R", floor: 1, position: [44.6, 4.5, 8.1], look_at: [62, 0.5, 8.1], fov_deg: 65, range_m: 30 },
    { id: "CAM-X01", zone: "X", floor: 1, position: [44.6, 4.2, 50], look_at: [60, 0.5, 50], fov_deg: 65, range_m: 26 },
    { id: "CAM-D01", zone: "D", floor: 1, position: [91.4, 4.2, 44], look_at: [78, 0.5, 44], fov_deg: 65, range_m: 26 },
    { id: "CAM-DOCK-IN", zone: "R", floor: 1, position: [59, 5.5, 2], look_at: [59, 0, 12], fov_deg: 80, range_m: 20 },
    { id: "CAM-DOCK-OUT", zone: "D", floor: 1, position: [73.5, 5.5, 62], look_at: [73.5, 0, 52], fov_deg: 80, range_m: 20 },
    { id: "CAM-M01", zone: "M2", floor: 2, position: [45.0, F2_ELEV + 3.6, 12.5], look_at: [62.0, F2_ELEV + 0.5, 12.5], fov_deg: 65, range_m: 30 },
    { id: "CAM-M02", zone: "M2", floor: 2, position: [89.0, F2_ELEV + 3.6, 20.5], look_at: [70.0, F2_ELEV + 0.5, 20.5], fov_deg: 65, range_m: 30 },
  ],
  sensors: [
    { id: "S-TEMP-F1", kind: "TEMP", zone: "F", position: [8, 2.5, 40] },
    { id: "S-TEMP-F2", kind: "TEMP", zone: "F", position: [30, 2.5, 48] },
    { id: "S-PRES-R1", kind: "PRESENCE", zone: "R", position: [52, 1, 7] },
    { id: "S-PRES-D1", kind: "PRESENCE", zone: "D", position: [80, 1, 56] },
    { id: "S-CVA", kind: "WEIGHT", zone: "X", position: [56, 0.5, 49], of: "CV-A" },
    { id: "S-LIDAR-X", kind: "LIDAR", zone: "X", position: [56, 1, 42] },
  ],
  theme: {
    bg: "#070b12",
    floor: "#1f2733",
    wall: "#182028",
    accent: "#10b981",
    floor_markings: [[40.2, 6, 40.2, 58], [43.8, 6, 43.8, 58], [0, 28.2, 96, 28.2], [0, 33.8, 96, 33.8]],
    accent_lights: [[48, 9, 32, "#34d399"], [80, 8, 61, "#fbbf24"], [59, 8, 3, "#22d3ee"]],
    subsystems: [
      { key: "SITE", label: "Store" },
      { key: "CONVEYORS", label: "Pack Lines" },
      { key: "CHARGING", label: "Charging" },
      { key: "CCTV", label: "CCTV" },
      { key: "NETWORK", label: "Network" },
    ],
    sim_start_hour: 7,
    sim_date: "2026/08/30",
    location_labels: { AISLE: "Aisle", COLD: "Cold Case", BULK: "Bulk", PACKOUT: "Packout", STAGE: "Staging", RECEIVING: "Receiving", DISPATCH: "Dispatch", CHARGING: "Charger" },
  },
  provenance: {
    "zones.F": { src: "interview", ref: "operator: chilled zone must stay ≤ 5°C, dedicated cold cases", conf: 0.9 },
    "fleet.classes[AMR-S].max_speed": { src: "research", ref: "vendor datasheet: compact picker AMR, 1.6 m/s", conf: 0.85 },
    "fixtures[AIRCURT-01]": { src: "blueprint", ref: "chilled-zone entry air curtain — no library component yet", conf: 0.8 },
    "tasks.types[BULK_DOWN]": { src: "interview", ref: "hourly bulk replenishment from mezzanine", conf: 0.9 },
  },
};

const out = join(here, "../src/specs/retail.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(spec, null, 2));
console.log(`wrote ${out}: ${fixtures.length} fixtures, ${locations.length} locations, ${spawns.length} robots`);
