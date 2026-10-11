import { create } from "zustand";
import { spec, site } from "../spec/registry";
import type { SpecLocation } from "../spec/types";
import type { TwinState, RobotId } from "../schema/twin_state";
import { launchConfig } from "./launch";

export type ViewTab = "3D" | "BRAIN" | "WORKERS" | "MAP" | "TRAFFIC" | "HEATMAP";
export type Quality = "low" | "medium" | "high";
export type SceneTool = "select" | "pan" | "paths" | "labels" | "measure";
export type TimeOfDay = "day" | "dusk" | "night";

interface Store {
  twin: TwinState;
  locations: Record<string, SpecLocation>;
  selectedRobot: RobotId | null;
  viewTab: ViewTab;
  quality: Quality;
  showPaths: boolean;
  showLabels: boolean;
  tool: SceneTool;
  focusTarget: [number, number, number] | null;
  activeCamera: string;
  select: (id: RobotId | null) => void;
  setViewTab: (t: ViewTab) => void;
  setQuality: (q: Quality) => void;
  setTool: (t: SceneTool) => void;
  togglePaths: () => void;
  toggleLabels: () => void;
  focus: (p: [number, number, number] | null) => void;
  setActiveCamera: (id: string) => void;
  speed: 0 | 1 | 2 | 5 | 10;
  paused: boolean;
  seed: number;
  setSpeed: (v: 0 | 1 | 2 | 5 | 10) => void;
  setPaused: (p: boolean) => void;
  setTwin: (t: TwinState) => void;
  notice: { text: string; kind: "warn" | "info"; until: number } | null;
  setNotice: (text: string | null, kind?: "warn" | "info") => void;
  activeFloor: "all" | "exploded" | number;
  setActiveFloor: (f: "all" | "exploded" | number) => void;
  selectedLift: string | null;
  selectLift: (id: string | null) => void;
  drawer: null | "scenarios" | "ops";
  setDrawer: (d: null | "scenarios" | "ops") => void;
  timeOfDay: TimeOfDay;
  setTimeOfDay: (t: TimeOfDay) => void;
  /** robot id → wall-clock ms of its last brain read (drives the head pulse); "*" = any reader */
  brainPulse: Record<string, number>;
  pulseBrain: (robotId: string) => void;
  /** Brain panel open state (right column) */
  brainPanel: boolean;
  setBrainPanel: (b: boolean) => void;
}

/** Empty initial TwinState (replaced by the engine snapshot as soon as the runner mounts) */
const EMPTY: TwinState = {
  schema_version: "2.0", spec_id: spec.meta.id,
  sim: { tick: 0, tick_ms: 100, speed: 1, mode: "PAUSED", seed: 42, baseline_snapshot_id: null },
  robots: {}, tasks: {}, lifts: {}, zones: {}, conveyors: {}, cameras: {}, sensors: {}, people: {}, alerts: {}, recent_events: [], recent_decisions: [],
  kpi: { tick: 0, fleet: { total: 0, active: 0, charging: 0, idle: 0, warning: 0, error: 0, offline: 0 }, operation: { throughput_per_min: 0, completed_today: 0, completed_target: spec.kpis.completed_target, pending: 0, ongoing: 0, avg_task_time_s: 0, on_time_rate: 1, avg_utilization: 0 }, efficiency: { avg_travel_distance_m: 0, avg_wait_time_s: 0, congestion_index: 0, energy_kwh: 0 }, throughput_series: [], lifts: { trips: 0, utilization: 0, avg_wait_s: 0, faults: 0 } },
  subsystems: Object.fromEntries(spec.theme.subsystems.map((s) => [s.key, "NORMAL" as const])),
};

export const useStore = create<Store>((set) => ({
  twin: EMPTY,
  speed: 1, paused: false, seed: launchConfig.seed,
  notice: null,
  setNotice: (text, kind = "warn") => set({ notice: text ? { text, kind, until: Date.now() + 4000 } : null }),
  activeFloor: "all",
  setActiveFloor: (activeFloor) => set({ activeFloor }),
  selectedLift: null,
  selectLift: (selectedLift) => set(selectedLift ? { selectedLift, selectedRobot: null } : { selectedLift }),
  drawer: null,
  setDrawer: (drawer) => set((st) => ({ drawer: st.drawer === drawer ? null : drawer })),
  timeOfDay: "day",
  setTimeOfDay: (timeOfDay) => set({ timeOfDay }),
  brainPulse: {},
  pulseBrain: (robotId) => set((s) => ({ brainPulse: { ...s.brainPulse, [robotId]: Date.now() } })),
  brainPanel: true,
  setBrainPanel: (brainPanel) => set({ brainPanel }),
  setSpeed: (speed) => set({ speed, paused: speed === 0 }),
  setPaused: (paused) => set({ paused }),
  locations: site.locations,
  selectedRobot: null,
  viewTab: "3D",
  quality: "medium",
  showPaths: true,
  showLabels: true,
  tool: "select",
  focusTarget: null,
  activeCamera: spec.cameras[0]?.id ?? "",
  select: (id) => set(id ? { selectedRobot: id, selectedLift: null } : { selectedRobot: id }),
  setViewTab: (viewTab) => set({ viewTab }),
  setQuality: (quality) => set({ quality }),
  setTool: (tool) => set({ tool }),
  togglePaths: () => set((s) => ({ showPaths: !s.showPaths })),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  focus: (focusTarget) => set({ focusTarget }),
  setActiveCamera: (activeCamera) => set({ activeCamera }),
  setTwin: (twin) => set({ twin }),
}));

/** Status → color, shared app-wide */
export const STATUS_COLOR: Record<string, string> = {
  ACTIVE: "#22c55e", CHARGING: "#3b82f6", IDLE: "#eab308", WARNING: "#f97316", ERROR: "#ef4444", OFFLINE: "#6b7280",
};
export const SEVERITY_COLOR: Record<string, string> = {
  INFO: "#3b82f6", LOW: "#3b82f6", MEDIUM: "#3b82f6", HIGH: "#eab308", CRITICAL: "#ef4444",
};
export const ZONE_COLOR = site.zoneColor;

/** Sim clock: tick 0 = theme.sim_start_hour */
export const SIM_START_S = spec.theme.sim_start_hour * 3600;
export function tickToClock(tick: number, tickMs = 100, withSeconds = false): string {
  const s = Math.max(0, Math.floor(SIM_START_S + (tick * tickMs) / 1000));
  const hh = Math.floor(s / 3600) % 24, mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return withSeconds ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(hh)}:${p(mm)}`;
}

export { spec, site };
