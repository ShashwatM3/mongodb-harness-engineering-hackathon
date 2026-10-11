import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { STATUS_COLOR, SEVERITY_COLOR, spec, tickToClock, useStore } from "../../state/store";
import { Dot, Panel } from "../ui/primitives";
import { RobotMesh } from "../scene/Robots";
import { SceneContent } from "../scene/Scene3D";
import { prettyLoc } from "./BottomPanels";
import type { RobotState } from "../../schema/twin_state";

function RobotThumb({ status }: { status: string }) {
  const cls = spec.fleet.classes[0];
  const r = useMemo<RobotState>(() => ({ id: "", model: cls.id, locomotion: cls.locomotion ?? "wheeled", floor: 1, lift_id: null, lift_stage: null, position: [0, 0, 0], heading: 0.6, velocity: 0, max_speed: cls.max_speed, battery: 100, status: status as RobotState["status"], fsm: "IDLE", health: 100, current_task_id: null, destination: null, path: [], path_index: 0, load: { current: 0, capacity: cls.capacity }, zone: null, eta_s: null, fsm_since_tick: 0, stats: { distance_m: 0, tasks_completed: 0, energy_wh: 0, busy_ticks: 0, wait_ticks: 0 }, perception: { state: "CLEAR", ahead_m: cls.lidar.range_m, nearest_m: null, obstacles: [], confidence: 1 } }), [status, cls]);
  return (
    <Canvas resize={{ offsetSize: true }} dpr={1} camera={{ position: [2.2, 1.6, 2.2], fov: 32 }} gl={{ alpha: true, antialias: true }} style={{ background: "transparent" }}>
      <ambientLight intensity={0.8} /><directionalLight position={[3, 5, 2]} intensity={2} /><pointLight position={[-2, 1, -2]} color="#60a5fa" intensity={4} />
      <group position={[0, -0.35, 0]}><RobotMesh r={r} selected={false} onSelect={() => {}} showLabel={false} lite smooth={false} /></group>
    </Canvas>
  );
}

/** Lift info panel (shown when a lift is selected) */
function LiftPanel({ id }: { id: string }) {
  const L = useStore((s) => s.twin.lifts[id]);
  const selectLift = useStore((s) => s.selectLift);
  const select = useStore((s) => s.select);
  const focus = useStore((s) => s.focus);
  const lay = spec.lifts.find((l) => l.id === id);
  const tick = useStore((s) => s.twin.sim.tick);
  if (!L || !lay) return null;
  const moving = L.state === "MOVING_UP" || L.state === "MOVING_DOWN";
  const eta = moving ? Math.max(0, (L.until_tick - tick) / 10).toFixed(1) : null;
  const util = tick ? Math.round((L.busy_ticks / tick) * 100) : 0;
  const avgWait = L.wait_n ? ((L.wait_total_ticks / L.wait_n) / 10).toFixed(1) : "—";
  const cite = (rid: string) => <button key={rid} className="cite" onClick={() => select(rid)}>{rid}</button>;
  return (
    <Panel title={id} sub="Freight lift" action={<button className="link" onClick={() => selectLift(null)}>✕</button>}>
      <div className="kv"><span className="k">State</span><span className="v" style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: L.fault ? "#ef4444" : undefined }}>{L.fault ? "FAULT" : L.state.replace(/_/g, " ")}{eta ? ` · ETA ${eta}s` : ""}</span></div>
      <div className="kv"><span className="k">Floor</span><span className="v">{L.floor === null ? `→ F${L.target_floor}` : `F${L.floor}`}</span></div>
      <div className="kv"><span className="k">Occupied by</span><span className="v">{L.occupant ? cite(L.occupant) : "—"}</span></div>
      <div className="kv"><span className="k">Reserved by</span><span className="v">{L.reserved_by ? cite(L.reserved_by) : "—"}</span></div>
      {lay.floors.map((f) => (
        <div className="kv" key={f}><span className="k">F{f} queue</span><span className="v">{L.queue[String(f)]?.length ? L.queue[String(f)].map(cite) : "—"}</span></div>
      ))}
      <div className="kv"><span className="k">Trips</span><span className="v">{L.trips}</span></div>
      <div className="kv"><span className="k">Avg wait</span><span className="v">{avgWait}{L.wait_n ? " s" : ""}</span></div>
      <div className="kv"><span className="k">Utilization</span><span className="v">{util}%</span></div>
      <button className="btn-outline" onClick={() => focus([lay.cell[0] + 0.5, 4, lay.cell[1] + 0.5])}>Focus camera</button>
    </Panel>
  );
}

export function SelectedRobotPanel() {
  const liftId = useStore((s) => s.selectedLift);
  const id = useStore((s) => s.selectedRobot);
  const r = useStore((s) => (id ? s.twin.robots[id] : undefined));
  const task = useStore((s) => (r?.current_task_id ? s.twin.tasks[r.current_task_id] : undefined));
  const locs = useStore((s) => s.locations);
  if (liftId && !id) return <LiftPanel id={liftId} />;
  if (!r) return <Panel title="Selected Robot"><div style={{ color: "var(--muted)", padding: "12px 0" }}>Click a robot or a lift in the 3D view</div></Panel>;
  const col = STATUS_COLOR[r.status];
  const estH = (r.battery / 100) * 3.1;
  const batteryStr = r.battery.toFixed(r.battery < 10 ? 1 : 0);
  return (
    <Panel title="Selected Robot">
      <div className="robot-head">
        <span className="id">{r.id}</span>
        {(r.floor > 1 || r.lift_id) && <span className="floor-chip">{r.lift_id ? `🛗 ${r.lift_id}` : `F${r.floor}`}</span>}
        <span className="status-text" style={{ color: col }}><Dot color={col} />{r.status[0] + r.status.slice(1).toLowerCase()}</span>
      </div>
      <div className="robot-img"><RobotThumb status={r.status} /></div>
      <div className="battery">
        <span className="bar"><span className="fill" style={{ width: `${r.battery}%`, background: r.battery < 10 ? "#ef4444" : r.battery < 20 ? "#f97316" : "#22c55e" }} /></span>
        <span className="pct">{batteryStr}%</span>
        <span className="est">Estimated {estH.toFixed(1)} h</span>
      </div>
      <div className="kv"><span className="k">State</span><span className="v" style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{r.fsm}{r.velocity > 0.05 ? ` · ${r.velocity.toFixed(2)} m/s` : ""}{r.eta_s ? ` · ETA ${r.eta_s}s` : ""}</span></div>
      <div className="kv"><span className="k">Perception</span><span className="v" style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: PERC_COLOR[r.perception?.state ?? "OFF"] }} title="Virtual LiDAR">{percText(r)}</span></div>
      <div className="kv"><span className="k">Current Task</span><span className="v">{task ? `#${task.id}  ${task.type[0] + task.type.slice(1).toLowerCase().replace(/_/g, " ")}` : "—"}</span></div>
      <div className="kv"><span className="k">From</span><span className="v">{prettyLoc(locs, task?.source)}</span></div>
      <div className="kv"><span className="k">To</span><span className="v">{prettyLoc(locs, task?.destination ?? r.destination)}</span></div>
            <div className="kv"><span className="k">Class</span><span className="v">{r.model}</span></div>
            <div className="kv"><span className="k">Type</span><span className="v">{r.locomotion === "wheeled" && spec.fleet.classes.find((c) => c.id === r.model)?.crawler ? "Crawler" : r.locomotion}</span></div>
            {r.flight && <div className="kv"><span className="k">Altitude</span><span className="v">{r.flight.altitude.toFixed(1)} m · {r.flight.mode}</span></div>}
    </Panel>
  );
}

const PERC_COLOR = { CLEAR: "#22d3ee", SLOWING: "#f59e0b", STOPPED: "#ef4444", OFF: "#64748b" } as const;
export function percText(r: RobotState): string {
  const P = r.perception; if (!P || P.state === "OFF") return "OFF";
  const dyn = P.obstacles.find((o) => o.kind !== "FIXTURE");
  const who = dyn ? ` · ${dyn.id} ${dyn.distance_m.toFixed(1)} m` : "";
  return `${P.state} · ahead ${P.ahead_m.toFixed(1)} m${who}`;
}

export function LiveCameraPanel() {
  const active = useStore((s) => s.activeCamera);
  const setActive = useStore((s) => s.setActiveCamera);
  const camStatus = useStore((s) => s.twin.cameras);
  const cam = spec.cameras.find((c) => c.id === active) ?? spec.cameras[0];
  if (!cam) return null;
  const isDock = cam.id.startsWith("CAM-DOCK");
  const zonesWithCams = [...new Set(spec.cameras.filter((c) => !c.id.startsWith("CAM-DOCK")).map((c) => c.zone))];
  const groups: Array<[string, string]> = [...zonesWithCams.map((z) => [z, z] as [string, string]), ...(spec.cameras.some((c) => c.id.startsWith("CAM-DOCK")) ? [["DOCK", "Dock"] as [string, string]] : [])];
  const camsOf = (g: string) => spec.cameras.filter((c) => (g === "DOCK" ? c.id.startsWith("CAM-DOCK") : !c.id.startsWith("CAM-DOCK") && c.zone === g));
  const curGroup = isDock ? "DOCK" : cam.zone;
  const zoneCams = camsOf(curGroup);
  const offline = camStatus[cam.id]?.status === "OFFLINE";
  return (
    <Panel title={isDock ? "Camera · Dock" : `Camera · Zone ${cam.zone}`} action={
      <span className="cam-tabs">{groups.map(([g, l]) => <button key={g} className={curGroup === g ? "on" : ""} onClick={() => setActive(camsOf(g)[0].id)}>{l}</button>)}</span>
    }>
      <div className="cam-view">
        <Canvas resize={{ offsetSize: true }} dpr={1} camera={{ position: cam.position, fov: cam.fov_deg, near: 0.3, far: 120 }} gl={{ antialias: false, powerPreference: "low-power" }} onCreated={({ camera }) => { camera.lookAt(...cam.look_at); }} key={cam.id} frameloop="always">
          <SceneContent quality="low" lite />
        </Canvas>
        {offline ? <div className="cam-offline">NO SIGNAL<br /><small>{cam.id} offline</small></div> : <span className="live">LIVE</span>}
        <span className="tag">{cam.id}</span>
        <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg, transparent 0 3px, rgba(0,0,0,.12) 3px 4px)", pointerEvents: "none" }} />
      </div>
      <div className="cam-dots">
        {zoneCams.map((c) => <button key={c.id} className={c.id === cam.id ? "on" : ""} onClick={() => setActive(c.id)} title={c.id} />)}
      </div>
    </Panel>
  );
}

export function EventLogPanel() {
  const events = useStore((s) => s.twin.recent_events);
  const select = useStore((s) => s.select);
  return (
    <Panel title="Event Log" grow>
      {events.filter((e) => e.severity !== "LOW").slice(0, 8).map((e) => {
        const col = e.severity === "INFO" || e.severity === "LOW" ? undefined : SEVERITY_COLOR[e.severity];
        return (
          <div key={e.id} className="ev-row" onClick={() => e.robot_id && select(e.robot_id)}>
            <span className="t" style={{ color: col }}>{tickToClock(e.tick, 100, true).slice(0, 8)}</span>
            <span style={{ color: col }}>{e.message}</span>
          </div>
        );
      })}
    </Panel>
  );
}
