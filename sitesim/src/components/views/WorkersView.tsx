/**
 * Workers view v2: one tile per deployed robot, each showing the task it was allotted at launch, what it is doing
 * now, and a vertically scrolling trajectory feed (engine events merged with worker decisions from the sim-server
 * mailbox, polled once for the whole view).
 *
 * A full lite scene render per tile kills the frame rate at 20 robots, so only the busiest LIVE_CAM_BUDGET tiles get a
 * real on-robot Canvas; the rest draw a cheap 2D mini-map SVG (zone outline + remaining path + heading) in the same
 * visual language as MapView2D. Selecting a robot promotes it to a live camera. The header toggle forces live cams on
 * every tile for users who accept the frame-rate cost.
 */
import { useEffect, useMemo, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { STATUS_COLOR, spec, tickToClock, useStore } from "../../state/store";
import { launchConfig } from "../../state/launch";
import { SceneContent } from "../scene/Scene3D";
import { FLOOR_ELEV } from "../scene/Mezzanine";
import { prettyLoc } from "../panels/BottomPanels";
import type { RobotState, TaskState } from "../../schema/twin_state";

const LIVE_CAM_BUDGET = 6;
const FEED_ROWS = 6;
/** Half-extents (m) of the mini-map window around the robot */
const MAP_HW = 18, MAP_HH = 12;

/** One row of a worker's trajectory feed. `tick` null = wall-clock only (sorted to the top). */
interface FeedRow { key: string; tick: number | null; t: string; msg: string; dec: boolean }

interface LogRecord {
  id: string; at: string; tick: number | null; robot_id: string; kind: string;
  decision: { action: string; rationale?: string } | null;
}

/** Allotted task types for a robot: from the launch allotment, or ANY when not listed. */
function allottedOf(id: string): string {
  const a = launchConfig.allotment?.[id];
  return a && a.length ? a.join("/") : "ANY";
}

function colsFor(n: number): number {
  return n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 5;
}

/** Activity score used to pick which tiles earn a live camera. */
function activity(r: RobotState, selected: string | null): number {
  return (r.id === selected ? 1e9 : 0) + (r.fsm === "PICKING" || r.fsm === "DELIVERING" ? 500 : 0) + (r.current_task_id ? 100 : 0) + (r.lift_id ? 50 : 0) + r.velocity;
}

function pointInPoly(x: number, z: number, poly: ReadonlyArray<readonly [number, number]> | number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Camera mounted on the robot's head, looking the way it faces */
function OnRobotCamera({ id }: { id: string }) {
  const { camera } = useThree();
  const target = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const r = useStore.getState().twin.robots[id]; if (!r) return;
    const y = (r.lift_id ? useStore.getState().twin.lifts[r.lift_id]?.y ?? 0 : FLOOR_ELEV[r.floor] ?? 0) + 1.35;
    const k = 1 - Math.pow(0.001, dt);
    const back = 1.6;
    const px = r.position[0] - Math.cos(r.heading) * back, pz = r.position[2] - Math.sin(r.heading) * back;
    camera.position.x += (px - camera.position.x) * k; camera.position.y += (y + 0.5 - camera.position.y) * k; camera.position.z += (pz - camera.position.z) * k;
    target.set(r.position[0] + Math.cos(r.heading) * 6, y - 0.6, r.position[2] + Math.sin(r.heading) * 6);
    camera.lookAt(target);
  });
  return null;
}

/** Cheap 2D mini-map: the robot's zone outline, remaining path and heading, framed around the robot. */
function MiniMap({ r, selected }: { r: RobotState; selected: boolean }) {
  const zoneStates = useStore((s) => s.twin.zones);
  const { width: W, depth: D } = spec.site.size;
  const [x, , z] = r.position;
  const floorZones = spec.zones.filter((zn) => (zn.floor ?? 1) === r.floor);
  const here = floorZones.find((zn) => zn.id === r.zone) ?? floorZones.find((zn) => pointInPoly(x, z, zn.polygon));
  const rest = r.path.slice(r.path_index);
  const col = STATUS_COLOR[r.status];
  const hx = Math.cos(r.heading), hz = Math.sin(r.heading);
  const gx0 = Math.floor((x - MAP_HW) / 5) * 5, gz0 = Math.floor((z - MAP_HH) / 5) * 5;
  return (
    <svg className="worker-map" viewBox={`${x - MAP_HW} ${z - MAP_HH} ${MAP_HW * 2} ${MAP_HH * 2}`} preserveAspectRatio="xMidYMid slice">
      <rect x={x - MAP_HW - 5} y={z - MAP_HH - 5} width={MAP_HW * 2 + 10} height={MAP_HH * 2 + 10} fill="#0a1020" />
      {Array.from({ length: 10 }, (_, i) => <line key={"v" + i} x1={gx0 + i * 5} x2={gx0 + i * 5} y1={z - MAP_HH - 5} y2={z + MAP_HH + 5} stroke="#16213a" strokeWidth="0.15" />)}
      {Array.from({ length: 8 }, (_, i) => <line key={"h" + i} y1={gz0 + i * 5} y2={gz0 + i * 5} x1={x - MAP_HW - 5} x2={x + MAP_HW + 5} stroke="#16213a" strokeWidth="0.15" />)}
      <rect x="0" y="0" width={W} height={D} fill="none" stroke="#334155" strokeWidth="0.4" />
      {floorZones.map((zn) => {
        const st = zoneStates[zn.id]?.status; const zc = st === "BLOCKED" ? "#ef4444" : st === "CONGESTED" ? "#f97316" : zn.color;
        const on = zn.id === here?.id;
        return <g key={zn.id}>
          <polygon points={zn.polygon.map((p) => p.join(",")).join(" ")} fill={zc} fillOpacity={on ? 0.1 : 0.03} stroke={zc} strokeWidth={on ? 0.45 : 0.2} strokeOpacity={on ? 1 : 0.45} />
          {on && <text x={zn.polygon[0][0] + 1} y={zn.polygon[0][1] - 1} fill={zc} fontSize="2.2" fontWeight="700">{zn.name.toUpperCase()}</text>}
        </g>;
      })}
      {spec.lifts.map((l) => <rect key={l.id} x={l.cell[0] - 0.7} y={l.cell[1] - 0.7} width="2.4" height="2.4" fill="none" stroke="#a78bfa" strokeWidth="0.3" />)}
      {rest.length > 0 && (
        <polyline points={[[x, z], ...rest.map((c) => [c[0] + 0.5, c[1] + 0.5])].map((p) => p.join(",")).join(" ")} fill="none" stroke={selected ? "#fff" : "#22d3ee"} strokeWidth={selected ? 0.5 : 0.3} strokeOpacity={selected ? 1 : 0.7} strokeDasharray="1 0.6" />
      )}
      <g transform={`translate(${x},${z})`}>
        {selected && <circle r="2.2" fill="none" stroke="#60a5fa" strokeWidth="0.3" />}
        <circle r="1" fill={col} stroke="#05080f" strokeWidth="0.25" />
        <line x1="0" y1="0" x2={hx * 2.4} y2={hz * 2.4} stroke="#fff" strokeWidth="0.3" />
        <polygon points={`${hx * 3.2},${hz * 3.2} ${hx * 2.2 - hz * 0.7},${hz * 2.2 + hx * 0.7} ${hx * 2.2 + hz * 0.7},${hz * 2.2 - hx * 0.7}`} fill="#fff" />
      </g>
      {here && <text x={x - MAP_HW + 1} y={z + MAP_HH - 1.2} fill="#8b98ad" fontSize="1.8" fontFamily="JetBrains Mono, monospace">{`${x.toFixed(1)}, ${z.toFixed(1)} m`}</text>}
    </svg>
  );
}

function taskLine(task: TaskState | undefined, locs: ReturnType<typeof useStore.getState>["locations"], allotted: string): string {
  if (!task) return `idle · waiting for a ${allotted} task`;
  return `#${task.id} ${task.type} ${prettyLoc(locs, task.source)} → ${prettyLoc(locs, task.destination)}${task.level ? `, shelf level ${task.level}` : ""}`;
}

function Tile({ r, live, feed, selected }: { r: RobotState; live: boolean; feed: FeedRow[]; selected: boolean }) {
  const task = useStore((s) => (r.current_task_id ? s.twin.tasks[r.current_task_id] : undefined));
  const locs = useStore((s) => s.locations);
  const select = useStore((s) => s.select);
  const allotted = allottedOf(r.id);
  const col = STATUS_COLOR[r.status];
  const floor = r.lift_id ?? `F${r.floor}`;
  const bat = Math.round(r.battery);
  const batCol = bat <= 10 ? "#ef4444" : bat <= 20 ? "#f97316" : "#8b98ad";
  return (
    <div className={"worker-tile v2" + (selected ? " sel" : "")} onClick={() => select(r.id)} title={`Select ${r.id}`}>
      <div className="worker-head">
        <span className="dot" style={{ background: col }} />
        <span className="wid">{r.id}</span>
        <span className="allot" title="Allotted task types">{allotted}</span>
        <span className="fl" title={r.lift_id ? "Riding lift" : "Floor"}>{floor}</span>
        <span className="bat" style={{ color: batCol }}>{bat}%</span>
      </div>
      <div className="worker-cam">
        {live ? (
          <Canvas resize={{ offsetSize: true }} dpr={0.75} camera={{ position: [r.position[0], 1.8, r.position[2]], fov: 70, near: 0.2, far: 90 }} gl={{ antialias: false, powerPreference: "low-power" }} frameloop="always">
            <SceneContent quality="low" lite />
            <OnRobotCamera id={r.id} />
          </Canvas>
        ) : <MiniMap r={r} selected={selected} />}
        <span className="tag" style={{ color: col }}>{r.fsm}{task?.level ? ` · L${task.level}` : ""}</span>
        <span className={"live" + (live ? "" : " map")}>{live ? "LIVE CAM" : "MAP"}</span>
      </div>
      <div className="worker-traj">
        <div className={"worker-task" + (task ? "" : " idle")}>{taskLine(task, locs, allotted)}</div>
        {feed.map((f) => <div key={f.key} className={"traj-row" + (f.dec ? " dec" : "")}><span className="t">{f.t}</span><span>{f.msg}</span></div>)}
      </div>
    </div>
  );
}

export function WorkersView() {
  const robots = useStore((s) => s.twin.robots);
  const events = useStore((s) => s.twin.recent_events);
  const tick = useStore((s) => s.twin.sim.tick);
  const selected = useStore((s) => s.selectedRobot);
  const [allLive, setAllLive] = useState(false);

  // Stable tile order (by id) so promoting a tile to a live cam never shuffles the grid.
  const list = useMemo(() => Object.values(robots).sort((a, b) => a.id.localeCompare(b.id)), [robots]);
  const n = list.length;

  // Live-cam set: recomputed every ~3 s of sim time (or on selection) so cams do not flap between tiles each tick.
  const coarse = Math.floor(tick / 30);
  const liveIds = useMemo(() => {
    const all = Object.values(useStore.getState().twin.robots);
    if (allLive) return new Set(all.map((r) => r.id));
    return new Set(all.sort((a, b) => activity(b, selected) - activity(a, selected)).slice(0, LIVE_CAM_BUDGET).map((r) => r.id));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coarse, selected, allLive, n]);

  // Worker decisions: one poll for the whole view, distributed by robot_id.
  const [log, setLog] = useState<LogRecord[]>([]);
  useEffect(() => {
    const url = (import.meta.env.VITE_SIM_SERVER ?? "http://localhost:8790") + "/worker/log";
    let alive = true;
    const poll = () => fetch(url).then((x) => x.json()).then((d) => { if (alive) setLog((d.exceptions ?? []) as LogRecord[]); }).catch(() => {});
    poll(); const h = window.setInterval(poll, 2500);
    return () => { alive = false; window.clearInterval(h); };
  }, []);

  const feeds = useMemo(() => {
    const by: Record<string, FeedRow[]> = {};
    const push = (id: string, row: FeedRow) => { (by[id] ??= []).push(row); };
    for (const e of log) {
      if (!e.robot_id) continue;
      const t = e.tick != null ? tickToClock(e.tick, 100, true).slice(3, 8) : new Date(e.at).toTimeString().slice(3, 8);
      const msg = e.decision ? `worker: ${e.decision.action} at ${e.kind}${e.decision.rationale ? ` — ${e.decision.rationale}` : ""}` : `worker: deciding ${e.kind}…`;
      push(e.robot_id, { key: "d" + e.id, tick: e.tick, t, msg, dec: true });
    }
    for (const e of events) {
      if (!e.robot_id) continue;
      push(e.robot_id, { key: e.id, tick: e.tick, t: tickToClock(e.tick, 100, true).slice(3, 8), msg: e.message.replace(e.robot_id + " ", ""), dec: false });
    }
    for (const id in by) by[id] = by[id].sort((a, b) => (b.tick ?? Infinity) - (a.tick ?? Infinity)).slice(0, FEED_ROWS);
    return by;
  }, [log, events]);

  const active = list.filter((r) => r.current_task_id).length;
  const liveCount = Math.min(n, allLive ? n : LIVE_CAM_BUDGET);
  return (
    <div className="workers-v2" style={{ ["--cols" as string]: colsFor(n) }}>
      <div className="workers-bar">
        <span><b>{n}</b> worker{n === 1 ? "" : "s"} deployed · <b>{active}</b> active · <b>{n - active}</b> idle</span>
        <span className="sp" />
        <button className={"live-toggle" + (allLive ? " on" : "")} onClick={() => setAllLive((v) => !v)}
          title={allLive ? "Showing a live camera on every tile. Each one is a full WebGL scene render, which costs frame rate — click to go back to the 6 busiest." : `Live cameras on the ${LIVE_CAM_BUDGET} busiest workers, mini-maps on the rest. Click to force live cameras on all ${n} tiles (costs frame rate).`}>
          Live cams: {allLive ? `all ${n}` : `${liveCount} / all`}
        </button>
      </div>
      <div className="workers-grid v2">
        {list.map((r) => <Tile key={r.id} r={r} live={liveIds.has(r.id)} feed={feeds[r.id] ?? []} selected={r.id === selected} />)}
      </div>
    </div>
  );
}
