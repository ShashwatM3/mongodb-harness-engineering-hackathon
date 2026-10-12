/** Runner contract tests: the brain compiler's hash scheme, the envelope, and a deterministic headless shift. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvSpec } from "../src/spec/types";
import { compileBrain } from "../src/harness/brain";
import { runShift, BrainRejectedError, scenarioScript } from "../src/harness/run";
import { SETTINGS } from "../src/harness/settings";
import type { Brain } from "../src/harness/contract";

const here = dirname(fileURLToPath(import.meta.url));
const spec: EnvSpec = JSON.parse(readFileSync(join(here, "../src/specs/warehouse.json"), "utf8"));
const v1: Brain = JSON.parse(readFileSync(join(here, "../brains/v1.json"), "utf8"));
const edit = (target: string, value: number, node = "x"): Brain => ({ version: 2, nodes: [{ node_id: "site:main", parent_id: null, level: "site" }, { node_id: node, parent_id: "site:main", level: "rule", body: { op: "set", target, value } }] });

describe("brain compiler", () => {
  it("v1 compiles to the patch hash the kg package expects", () => {
    const c = compileBrain(v1);
    expect(c.ok).toBe(true);
    expect(c.patch_hash).toBe("59d237854b19a5d2");
    expect(c.patch).toEqual({ sim: { STAIR_MIN_LIFT_QUEUE: 99 }, classes: { "HUM-1": { max_speed: 1.2 } } });
  });
  it("deeper node wins; a tie goes to the later node", () => {
    const b: Brain = { version: 1, nodes: [
      { node_id: "site:main", parent_id: null, level: "site" }, { node_id: "zone:M", parent_id: "site:main", level: "zone" },
      { node_id: "a", parent_id: "site:main", level: "rule", body: { op: "set", target: "sim.STAIR_MIN_LIFT_QUEUE", value: 5 } },
      { node_id: "b", parent_id: "zone:M", level: "rule", body: { op: "set", target: "sim.STAIR_MIN_LIFT_QUEUE", value: 2 } },
      { node_id: "c", parent_id: "site:main", level: "rule", body: { op: "set", target: "sim.WAIT_REPLAN_TICKS", value: 30 } },
      { node_id: "d", parent_id: "site:main", level: "rule", body: { op: "set", target: "sim.WAIT_REPLAN_TICKS", value: 40 } },
    ] };
    const eff = Object.fromEntries(compileBrain(b).effective.map((e) => [e.target, e.value]));
    expect(eff["sim.STAIR_MIN_LIFT_QUEUE"]).toBe(2);
    expect(eff["sim.WAIT_REPLAN_TICKS"]).toBe(40);
  });
  it("enforces the envelope", () => {
    expect(compileBrain(edit("sim.STAIR_MIN_LIFT_QUEUE", 150)).rejected[0].reason).toContain("out of range");
    expect(compileBrain(edit("sim.HUMAN_CLEARANCE_M", 1.5)).rejected[0].reason).toContain("fixed");
    expect(compileBrain(edit("sim.STAIR_CAPACITY", 4)).rejected[0].reason).toContain("spec");
    expect(compileBrain(edit("sim.NOPE", 1)).rejected[0].reason).toContain("unknown");
    expect(compileBrain(edit("sim.WAIT_REPLAN_TICKS", 25.5)).rejected[0].reason).toContain("whole");
    const locked = compileBrain(edit("class.HUM-1.max_speed", 1.35));
    expect(locked.locked_edits.map((l) => l.target)).toContain("class.HUM-1.max_speed");
    const approved = compileBrain({ ...edit("class.HUM-1.max_speed", 1.35), approvals: [{ target: "class.HUM-1.max_speed", value: 1.35, approved_by: "lead" }] });
    expect(approved.locked_edits.find((l) => l.target === "class.HUM-1.max_speed")).toBeUndefined();
  });
  it("warns when a setting whose v1 differs from the engine default is omitted", () => {
    const c = compileBrain({ version: 1, nodes: [{ node_id: "site:main", parent_id: null, level: "site" }] });
    expect(c.warnings.some((w) => w.includes("sim.STAIR_MIN_LIFT_QUEUE omitted"))).toBe(true);
    expect(c.locked_edits.some((l) => l.target === "class.HUM-1.max_speed" && l.node_id === null)).toBe(true);
  });
  it("registry statuses are consistent", () => {
    for (const d of SETTINGS) { expect(d.min).toBeLessThanOrEqual(d.v1); expect(d.v1).toBeLessThanOrEqual(d.max); }
    expect(SETTINGS.filter((d) => d.status === "locked").length).toBe(3);
  });
});

describe("headless runner", () => {
  it("same brain and seed give a byte-identical response; scenario script is seeded", () => {
    const a = runShift(spec, v1, [101], { ticks: 1500, engineSha: "t" });
    const b = runShift(spec, v1, [101], { ticks: 1500, engineSha: "t" });
    delete a.wall_ms; delete b.wall_ms;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.patch_hash).toBe("59d237854b19a5d2");
    expect(Object.keys(a.pooled.zones).sort()).toEqual(["A", "B", "C", "D", "M"]);
    expect(scenarioScript(spec, "standard", 101, 12000)).toEqual(scenarioScript(spec, "standard", 101, 12000));
    expect(scenarioScript(spec, "standard", 101, 12000)).not.toEqual(scenarioScript(spec, "standard", 102, 12000));
  });
  it("refuses locked edits without allow_locked and rejected edits always", () => {
    expect(() => runShift(spec, edit("class.HUM-1.max_speed", 1.4), [101], { ticks: 10, engineSha: "t" })).toThrow(BrainRejectedError);
    expect(runShift(spec, edit("class.HUM-1.max_speed", 1.4), [101], { ticks: 10, engineSha: "t", allowLocked: true }).warnings.join()).toContain("locked");
    expect(() => runShift(spec, edit("sim.STAIR_CAPACITY", 9), [101], { ticks: 10, engineSha: "t", allowLocked: true })).toThrow(BrainRejectedError);
  });
});
