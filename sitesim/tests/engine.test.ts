/**
 * Engine + compiler contract tests. Everything here runs against BOTH bundled
 * specs — the whole point of the platform is that the deterministic core is
 * environment-agnostic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvSpec } from "../src/spec/types";
import { compileSite, validateSpec } from "../src/compiler/compile";
import { astar, isWalkable, toCell } from "../src/engine/astar";
import { SimEngine } from "../src/engine/engine";

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): EnvSpec => JSON.parse(readFileSync(join(here, `../src/specs/${name}.json`), "utf8"));
const warehouse = load("warehouse");
const retail = load("retail");
const offshore = load("offshore");
const SPECS: Array<[string, EnvSpec]> = [["warehouse", warehouse], ["retail", retail], ["offshore", offshore]];

describe("spec validation", () => {
  for (const [name, spec] of SPECS) {
    it(`${name} spec is structurally valid`, () => {
      expect(validateSpec(spec)).toEqual([]);
    });
  }
  it("warehouse spec has no capability gaps", () => {
    expect(compileSite(warehouse).gaps).toEqual([]);
  });
  it("retail spec surfaces its unknown fixture kinds as gaps", () => {
    const kinds = compileSite(retail).gaps.map((g) => g.kind).sort();
    expect(kinds).toEqual(["air_curtain", "cart_wash"]);
  });
});

describe("compiler / navgrid", () => {
  for (const [name, spec] of SPECS) {
    const site = compileSite(spec);
    it(`${name}: robots spawn on walkable cells`, () => {
      for (const sp of spec.fleet.spawns) {
        const grid = site.grids[sp.floor ?? 1];
        const c = toCell(sp.position[0], sp.position[2]);
        expect(isWalkable(grid, c[0], c[1]), `${sp.id} at ${c}`).toBe(true);
      }
    });
    it(`${name}: lift queue slots and shaft blocking are consistent`, () => {
      for (const l of spec.lifts) {
        for (const f of l.floors) {
          const grid = site.grids[f];
          // shaft cell itself is blocked
          expect(isWalkable(grid, l.cell[0], l.cell[1])).toBe(false);
          // first queue slot (cell − 4) is approachable
          expect(isWalkable(grid, l.cell[0] - 4, l.cell[1])).toBe(true);
        }
      }
    });
    it(`${name}: every location access point resolves to a reachable cell near a spawn`, () => {
      const grid1 = site.grids[1];
      const start = toCell(spec.fleet.spawns.find((s) => (s.floor ?? 1) === 1)!.position[0], spec.fleet.spawns.find((s) => (s.floor ?? 1) === 1)!.position[2]);
      let reachable = 0, total = 0;
      for (const loc of spec.locations) {
        if ((loc.floor ?? 1) !== 1) continue;
        total++;
        // access point may sit on a blocked border cell; search its 8-neighborhood like the engine does
        const c = toCell(loc.access_point[0], loc.access_point[1]);
        const candidates = [c, ...[[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dc, dr]) => [c[0] + dc, c[1] + dr] as [number, number])];
        const goal = candidates.find(([cc, rr]) => isWalkable(grid1, cc, rr));
        if (goal && astar(grid1, start, goal) !== null) reachable++;
      }
      expect(reachable / total).toBeGreaterThan(0.99);
    });
  }
});

describe("A*", () => {
  const site = compileSite(warehouse);
  it("finds a path across the site and never crosses blocked cells", () => {
    const p = astar(site.grids[1], [10, 20], [90, 55]);
    expect(p).not.toBeNull();
    for (const [c, r] of p!) expect(site.grids[1].cells[r * site.grids[1].cols + c]).not.toBe(1);
  });
  it("returns null for unreachable goals", () => {
    // goal inside a rack footprint
    const rack = site.racks[0];
    const goal = toCell(rack.position[0] + 0.5, rack.position[2] + 0.5);
    expect(astar(site.grids[1], [10, 20], goal)).toBeNull();
  });
});

describe("engine determinism & behavior", () => {
  for (const [name, spec] of SPECS) {
    const site = compileSite(spec);
    it(`${name}: same seed → identical trajectory`, () => {
      const a = new SimEngine(site, { seed: 42 });
      const b = new SimEngine(site, { seed: 42 });
      for (let i = 0; i < 1200; i++) { a.step(); b.step(); }
      expect(JSON.stringify(a.state)).toEqual(JSON.stringify(b.state));
    });
    it(`${name}: different seed → different trajectory`, () => {
      const a = new SimEngine(site, { seed: 42 });
      const b = new SimEngine(site, { seed: 7 });
      for (let i = 0; i < 1200; i++) { a.step(); b.step(); }
      expect(JSON.stringify(a.state.tasks)).not.toEqual(JSON.stringify(b.state.tasks));
    });
    it(`${name}: tasks get created, assigned and completed`, () => {
      const eng = new SimEngine(site, { seed: 42 });
      for (let i = 0; i < 12000; i++) eng.step(); // 20 sim-minutes
      const tasks = Object.values(eng.state.tasks);
      expect(tasks.length).toBeGreaterThan(0);
      expect(eng.state.kpi.operation.completed_today).toBeGreaterThan(5);
      expect(eng.state.recent_decisions.length).toBeGreaterThan(0);
      const d = eng.state.recent_decisions[0];
      expect(d.candidates.length).toBeGreaterThan(0);
      expect(d.candidates[0].reasons.length).toBeGreaterThan(0);
    });
    it(`${name}: no two robots ever get closer than 0.5 m (10 sim-minutes)`, () => {
      const eng = new SimEngine(site, { seed: 42 });
      let minSep = Infinity;
      for (let i = 0; i < 6000; i++) {
        eng.step();
        const rs = Object.values(eng.state.robots).filter((r) => r.status !== "OFFLINE" && !r.lift_id);
        for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
          if (rs[a].floor !== rs[b].floor) continue;
          const d = Math.hypot(rs[a].position[0] - rs[b].position[0], rs[a].position[2] - rs[b].position[2]);
          if (d < minSep) minSep = d;
        }
      }
      expect(minSep).toBeGreaterThan(0.5);
    });
  }

  it("warehouse: lifts complete cross-floor trips when the brain says lifts only (STAIR_MIN_LIFT_QUEUE 99)", () => {
    const site = compileSite({ ...warehouse, sim: { ...(warehouse.sim ?? {}), STAIR_MIN_LIFT_QUEUE: 99 } });
    const eng = new SimEngine(site, { seed: 42 });
    for (let i = 0; i < 18000; i++) eng.step(); // 30 sim-minutes
    const trips = Object.values(eng.state.lifts).reduce((a, l) => a + l.trips, 0);
    expect(trips).toBeGreaterThan(0);
    expect(eng.harness.stair_trips).toBe(0);
  });

  it("warehouse: legged robots take the west stairs when the lift queue is long enough (engine default 0 = always)", () => {
    const eng = new SimEngine(compileSite(warehouse), { seed: 42 });
    for (let i = 0; i < 12000; i++) eng.step();
    expect(eng.harness.stair_trips).toBeGreaterThan(0);
    expect(Object.values(eng.state.lifts).reduce((a, l) => a + l.trips, 0)).toBe(0);
    expect(eng.harness.time.M?.stairs ?? 0).toBeGreaterThan(0);
  });

  it("robot failure re-queues its task and marks the robot OFFLINE", () => {
    const site = compileSite(warehouse);
    const eng = new SimEngine(site, { seed: 42 });
    for (let i = 0; i < 600; i++) eng.step();
    const busy = Object.values(eng.state.robots).find((r) => r.current_task_id);
    expect(busy).toBeDefined();
    const taskId = busy!.current_task_id!;
    eng.inject({ kind: "ROBOT_FAILURE", robot_id: busy!.id });
    eng.step();
    expect(eng.state.robots[busy!.id].status).toBe("OFFLINE");
    expect(eng.state.tasks[taskId].status).toBe("TRANSFERRED");
    const child = Object.values(eng.state.tasks).find((t) => t.parent_task_id === taskId);
    expect(child).toBeDefined();
    eng.clearInjection("ROBOT_FAILURE", busy!.id);
    expect(eng.state.robots[busy!.id].status).not.toBe("OFFLINE");
  });

  it("human intrusion blocks the zone and later clears", () => {
    const site = compileSite(warehouse);
    const eng = new SimEngine(site, { seed: 42 });
    eng.inject({ kind: "HUMAN_INTRUSION", zone_id: "B", duration_ticks: 100 });
    eng.step();
    expect(eng.state.zones["B"].status).toBe("BLOCKED");
    expect(Object.keys(eng.state.people).length).toBe(1);
    for (let i = 0; i < 120; i++) eng.step();
    expect(eng.state.zones["B"].status).not.toBe("BLOCKED");
    expect(Object.keys(eng.state.people).length).toBe(0);
  });

  it("conveyor failure slows the fed station and flips the subsystem", () => {
    const site = compileSite(warehouse);
    const eng = new SimEngine(site, { seed: 42 });
    eng.inject({ kind: "CONVEYOR_FAILURE", conveyor_id: "CV03" });
    for (let i = 0; i < 11; i++) eng.step();
    expect(eng.state.conveyors["CV03"].status).toBe("ERROR");
    expect(eng.state.subsystems.CONVEYORS).toBe("ERROR");
    eng.clearInjection("CONVEYOR_FAILURE", "CV03");
    for (let i = 0; i < 11; i++) eng.step();
    expect(eng.state.conveyors["CV03"].status).toBe("RUNNING");
  });

  it("battery injection triggers charge scheduling", () => {
    const site = compileSite(warehouse);
    const eng = new SimEngine(site, { seed: 42 });
    for (let i = 0; i < 100; i++) eng.step();
    const idle = Object.values(eng.state.robots).find((r) => r.fsm === "IDLE")!;
    eng.inject({ kind: "ROBOT_BATTERY_SET", robot_id: idle.id, battery: 8 });
    for (let i = 0; i < 50; i++) eng.step();
    const r = eng.state.robots[idle.id];
    expect(["GOING_TO_CHARGE", "CHARGING", "LOW_BATTERY", "TASK_TRANSFER"]).toContain(r.fsm);
  });

  it("manual task validation follows the spec grammar", () => {
    const site = compileSite(warehouse);
    const eng = new SimEngine(site, { seed: 42 });
    expect(() => eng.createTask({ type: "PICK", priority: "NORMAL", source: "CHG-01", destination: "PACK-01" })).toThrow();
    expect(() => eng.createTask({ type: "NOPE", priority: "NORMAL", source: "SHELF-A01", destination: "PACK-01" })).toThrow();
    expect(() => eng.createTask({ type: "PICK", priority: "NORMAL", source: "SHELF-A01", destination: "PACK-01" })).not.toThrow();
  });

  it("offshore assignment explains Ex-zone certification rejection", () => {
    const eng = new SimEngine(compileSite(offshore), { seed: 42 });
    eng.createTask({ type: "INSPECT", priority: "CRITICAL", source: "WH-01", destination: "INSPECT-01" });
    eng.step();
    const decision = eng.state.recent_decisions.find((d) => d.kind === "TASK_ASSIGNMENT");
    const crawler = decision?.candidates.find((c) => c.robot_id === "IL01");
    expect(crawler?.rejected_reason).toContain("not Ex-certified for ZONE 0");
  });

  it("offshore drones enter return-to-home mode on signal loss", () => {
    const eng = new SimEngine(compileSite(offshore), { seed: 42 });
    eng.inject({ kind: "DRONE_SIGNAL_LOST", robot_id: "DR01" });
    eng.step();
    expect(eng.state.robots.DR01.flight?.signal_lost).toBe(true);
    expect(eng.state.robots.DR01.flight?.mode).toBe("RETURNING_HOME");
  });

  it("offshore legged robots can route through stair cells", () => {
    const site = compileSite(offshore);
    const stair = site.grids[2].cells.findIndex((v) => v === 3);
    expect(stair).toBeGreaterThanOrEqual(0);
    const c = stair % site.grids[2].cols, r = Math.floor(stair / site.grids[2].cols);
    expect(astar(site.grids[2], [48, 8], [c, r], { allowStairs: true })).not.toBeNull();
    expect(astar(site.grids[2], [48, 8], [c, r])).toBeNull();
  });

  it("offshore high wind grounds an airborne drone and explains rejection", () => {
    const eng = new SimEngine(compileSite(offshore), { seed: 42 });
    const drone = eng.state.robots.DR01;
    drone.flight!.mode = "OUTBOUND";
    eng.inject({ kind: "HIGH_WIND", wind_mps: 20, duration_ticks: 20 });
    eng.createTask({ type: "INSPECT", priority: "HIGH", source: "WH-01", destination: "INSPECT-01" });
    eng.step();
    expect(drone.flight?.mode).toBe("RETURNING_HOME");
    expect(drone.flight?.return_reason).toBe("high wind");
    const decision = eng.state.recent_decisions.find((d) => d.kind === "TASK_ASSIGNMENT");
    expect(decision?.candidates.find((c) => c.robot_id === "DR01")?.rejected_reason).toContain("grounded: wind 20 m/s exceeds limit");
  });

  it("offshore gas leak creates a critical inspection and rejects uncertified robots", () => {
    const eng = new SimEngine(compileSite(offshore), { seed: 42 });
    eng.inject({ kind: "GAS_LEAK", zone_id: "WELLBAY", duration_ticks: 20 });
    eng.step();
    expect(eng.state.alerts["gas-WELLBAY"]?.severity).toBe("CRITICAL");
    expect(Object.values(eng.state.tasks).some((t) => t.type === "INSPECT" && t.priority === "CRITICAL")).toBe(true);
    const decision = eng.state.recent_decisions.find((d) => d.kind === "TASK_ASSIGNMENT");
    expect(decision?.candidates.some((c) => c.rejected_reason?.includes("not Ex-certified for gas-leak zone WELLBAY"))).toBe(true);
  });

  it("offshore dropped object blocks and then restores a zone", () => {
    const eng = new SimEngine(compileSite(offshore), { seed: 42 });
    eng.inject({ kind: "DROPPED_OBJECT", zone_id: "PROCESS", duration_ticks: 2 });
    eng.step();
    expect(eng.state.zones.PROCESS.status).toBe("BLOCKED");
    expect(eng.state.recent_events.some((e) => e.message.includes("Dropped object"))).toBe(true);
    eng.step(); eng.step();
    expect(eng.state.zones.PROCESS.status).not.toBe("BLOCKED");
    expect(eng.state.alerts["drop-PROCESS"]).toBeUndefined();
  });

  it("offshore comms blackout sends a ground robot home and restores", () => {
    const eng = new SimEngine(compileSite(offshore), { seed: 42 });
    eng.inject({ kind: "COMMS_BLACKOUT", robot_id: "AMR01", duration_ticks: 3 });
    eng.step();
    expect(eng.state.alerts["comms-AMR01"]).toBeDefined();
    expect(eng.state.robots.AMR01.current_task_id).toBeNull();
    for (let i = 0; i < 4; i++) eng.step();
    expect(eng.state.alerts["comms-AMR01"]).toBeUndefined();
    expect(eng.state.recent_events.some((e) => e.message.includes("communications restored"))).toBe(true);
  });

  it("offshore fog and platform motion degrade and restore monitoring confidence", () => {
    const eng = new SimEngine(compileSite(offshore), { seed: 42 });
    eng.inject({ kind: "FOG", level: 0.8, duration_ticks: 3 });
    eng.inject({ kind: "PLATFORM_MOTION", severity: 0.5, duration_ticks: 3 });
    eng.step();
    expect(eng.state.robots.FS01.monitoring?.confidence).toBeCloseTo(0.1);
    expect(eng.state.cameras["CAM-WELL"].confidence).toBeCloseTo(0.1);
    for (let i = 0; i < 4; i++) eng.step();
    expect(eng.state.robots.FS01.monitoring?.confidence).toBe(1);
    expect(eng.state.cameras["CAM-WELL"].confidence).toBe(1);
  });
});
