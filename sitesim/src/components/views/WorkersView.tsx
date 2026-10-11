/**
 * Workers view: up to four on-robot cameras (each a full lite scene render, so the count is capped to protect
 * the frame rate) with a scrolling trajectory strip under each: the robot's recent events and worker decisions.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { STATUS_COLOR, tickToClock, useStore } from "../../state/store";
import { SceneContent } from "../scene/Scene3D";
import { FLOOR_ELEV } from "../scene/Mezzanine";
import type { RobotState } from "../../schema/twin_state";

const MAX_TILES = 4;

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

function Tile({ r }: { r: RobotState }) {
  const events = useStore((s) => s.twin.recent_events);
  const task = useStore((s) => (r.current_task_id ? s.twin.tasks[r.current_task_id] : undefined));
  const select = useStore((s) => s.select);
  const mine = events.filter((e) => e.robot_id === r.id).slice(0, 6);
  const [decisions, setDecisions] = useState<Array<{ at: string; kind: string; action: string; rationale: string }>>([]);
  const poll = useRef(0);
  useEffect(() => {
    const url = (import.meta.env.VITE_SIM_SERVER ?? "http://localhost:8790") + "/worker/log";
    const tick = () => fetch(url).then((x) => x.json()).then((d) => setDecisions((d.exceptions ?? []).filter((e: { robot_id: string }) => e.robot_id === r.id).slice(0, 4).map((e: { at: string; kind: string; decision: { action: string; rationale: string } | null }) => ({ at: e.at, kind: e.kind, action: e.decision?.action ?? "…", rationale: e.decision?.rationale ?? "" })))).catch(() => {});
    tick(); poll.current = window.setInterval(tick, 2500);
    return () => window.clearInterval(poll.current);
  }, [r.id]);
  const col = STATUS_COLOR[r.status];
  return (
    <div className="worker-tile">
      <div className="worker-cam">
        <Canvas resize={{ offsetSize: true }} dpr={1} camera={{ position: [r.position[0], 1.8, r.position[2]], fov: 70, near: 0.2, far: 90 }} gl={{ antialias: false, powerPreference: "low-power" }} frameloop="always">
          <SceneContent quality="low" lite />
          <OnRobotCamera id={r.id} />
        </Canvas>
        <span className="tag" style={{ color: col }}>● {r.id} · {r.fsm}{task?.level ? ` · L${task.level}` : ""}</span>
        <span className="live">CAM</span>
      </div>
      <div className="worker-traj">
        <div className="worker-task" onClick={() => select(r.id)}>{task ? `#${task.id} ${task.type}` : "idle"}{task?.level ? ` → shelf level ${task.level}` : ""}</div>
        {decisions.map((d, i) => <div key={"d" + i} className="traj-row dec"><span className="t">worker</span><span><b>{d.action}</b> at {d.kind}{d.rationale ? ` — ${d.rationale}` : ""}</span></div>)}
        {mine.map((e) => <div key={e.id} className="traj-row"><span className="t">{tickToClock(e.tick, 100, true).slice(3, 8)}</span><span>{e.message.replace(r.id + " ", "")}</span></div>)}
      </div>
    </div>
  );
}

export function WorkersView() {
  const robots = useStore((s) => s.twin.robots);
  const selected = useStore((s) => s.selectedRobot);
  // the selected robot first, then the busiest active ones
  const list = useMemo(() => {
    const all = Object.values(robots);
    const score = (r: RobotState) => (r.id === selected ? 1e9 : 0) + (r.fsm === "PICKING" || r.fsm === "DELIVERING" ? 500 : 0) + (r.current_task_id ? 100 : 0) + (r.lift_id ? 50 : 0) + r.velocity;
    return all.sort((a, b) => score(b) - score(a)).slice(0, MAX_TILES);
  }, [robots, selected]);
  return <div className="workers-grid">{list.map((r) => <Tile key={r.id} r={r} />)}</div>;
}
