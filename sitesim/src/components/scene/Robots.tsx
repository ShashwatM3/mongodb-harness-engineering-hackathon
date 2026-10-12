import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { STATUS_COLOR, spec, useStore } from "../../state/store";
import { FLOOR_ELEV } from "./Mezzanine";
import type { RobotState } from "../../schema/twin_state";

const RSCALE = spec.theme.robot_scale ?? 1;
const explodeY = (floor: number, af: ReturnType<typeof useStore.getState>["activeFloor"]) => (af === "exploded" && floor !== 1 ? 5 : 0);

/** Procedural AMR: chassis, dark top cover, four wheels, blue front light bar, status lamp; carries a box when loaded */
export function RobotMesh({ r, selected, onSelect, showLabel, lite, smooth = true }: { r: RobotState; selected: boolean; onSelect: () => void; showLabel: boolean; lite?: boolean; smooth?: boolean }) {
  const color = STATUS_COLOR[r.status];
  const ringRef = useRef<THREE.Mesh>(null!);
  const lampRef = useRef<THREE.MeshBasicMaterial>(null!);
  const groupRef = useRef<THREE.Group>(null!);
  const wheelsRef = useRef<THREE.Group>(null!);
  // Transforms are only given a stable initial value; per-frame smoothing owns them afterwards.
  // (Otherwise every 10 Hz re-render would snap lift riders back to the wrong height.)
  const init = useRef<{ p: [number, number, number]; h: number } | null>(null);
  if (!init.current) {
    const L0 = r.lift_id ? useStore.getState().twin.lifts[r.lift_id] : null;
    init.current = { p: [r.position[0], L0 ? L0.y : FLOOR_ELEV[r.floor] ?? 0, r.position[2]], h: -r.heading };
  }
  // Sim updates at 10 Hz, frames at 60 Hz: exponential smoothing keeps motion continuous
  useFrame(({ clock }, dt) => {
    const g = groupRef.current;
    if (g) {
      const k = smooth ? 1 - Math.pow(0.0005, dt) : 1;
      g.position.x += (r.position[0] - g.position.x) * k;
      g.position.z += (r.position[2] - g.position.z) * k;
      const st = useStore.getState();
      const lift = r.lift_id ? st.twin.lifts[r.lift_id] : null;
      const explode = !lite && !r.lift_id ? explodeY(r.floor, st.activeFloor) : 0;
      const ty = (lift ? lift.y : FLOOR_ELEV[r.floor] ?? 0) + explode;
      // While riding, use the exact smoothing factor of the platform so the robot sticks to it
      const ky = lift ? 1 - Math.pow(0.02, dt) : smooth ? 1 - Math.pow(0.25, dt) : 1;
      g.position.y += (ty - g.position.y) * ky;
      let dh = -r.heading - g.rotation.y; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      g.rotation.y += dh * k;
      if (wheelsRef.current && r.velocity > 0.05) wheelsRef.current.rotation.z -= (r.velocity / 0.12) * dt;
    }
    if (ringRef.current) { const s = 1 + Math.sin(clock.elapsedTime * 3) * 0.08; ringRef.current.scale.set(s, s, s); }
    if (lampRef.current && (r.status === "ERROR" || r.status === "WARNING")) lampRef.current.opacity = 0.5 + Math.sin(clock.elapsedTime * 8) * 0.5;
  });
  const loaded = r.load.current > 0;
  return (
    <group ref={groupRef} position={init.current.p} rotation-y={init.current.h}>
      <group scale={RSCALE} onClick={(e) => { e.stopPropagation(); onSelect(); }} onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
        {/* Chassis */}
        <mesh position={[0, 0.22, 0]} castShadow>
          <boxGeometry args={[0.95, 0.32, 0.68]} />
          <meshStandardMaterial color="#d7dce6" roughness={0.35} metalness={0.5} />
        </mesh>
        {/* Dark top cover */}
        <mesh position={[0, 0.42, 0]} castShadow>
          <boxGeometry args={[0.8, 0.1, 0.58]} />
          <meshStandardMaterial color="#111827" roughness={0.5} metalness={0.3} />
        </mesh>
        {/* Lift platter */}
        <mesh position={[0, 0.5, 0]}>
          <cylinderGeometry args={[0.3, 0.3, 0.06, 20]} />
          <meshStandardMaterial color="#1f2937" roughness={0.6} metalness={0.4} />
        </mesh>
        {/* Front light bar */}
        <mesh position={[0.485, 0.22, 0]}>
          <boxGeometry args={[0.02, 0.08, 0.5]} />
          <meshBasicMaterial color="#60a5fa" />
        </mesh>
        {/* Hazard stripes */}
        {[-0.35, 0.35].map((z) => (
          <mesh key={z} position={[0, 0.1, z]}>
            <boxGeometry args={[0.95, 0.06, 0.02]} />
            <meshBasicMaterial color="#facc15" />
          </mesh>
        ))}
        {/* Wheels */}
        <group ref={wheelsRef}>
          {[[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]].map(([x, z], i) => (
            <mesh key={i} position={[x, 0.12, z]} rotation-x={Math.PI / 2}>
              <cylinderGeometry args={[0.12, 0.12, 0.1, 14]} />
              <meshStandardMaterial color="#0f172a" roughness={0.9} />
            </mesh>
          ))}
        </group>
        {/* Status lamp */}
        <mesh position={[-0.33, 0.5, 0]}>
          <sphereGeometry args={[0.07, 10, 10]} />
          <meshBasicMaterial ref={lampRef} color={color} transparent />
        </mesh>
        {/* Cargo */}
        {loaded && (
          <mesh position={[0, 0.85, 0]} castShadow>
            <boxGeometry args={[0.78, 0.6, 0.62]} />
            <meshStandardMaterial color="#c49a6c" roughness={0.9} />
          </mesh>
        )}
      </group>
      {/* Virtual LiDAR visualization: fan + rays when selected; red arc when stopped by perception */}
      {!lite && selected && <PerceptionGizmo r={r} />}
      {!lite && !selected && r.perception?.state === "STOPPED" && (
        <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.95, 1.12, 24, 1, -Math.PI / 6, Math.PI / 3]} /><meshBasicMaterial color="#ef4444" transparent opacity={0.9} side={THREE.DoubleSide} /></mesh>
      )}
      {/* Ground halo */}
      <mesh ref={ringRef} position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.58, 0.74, 40]} />
        <meshBasicMaterial color={selected ? "#60a5fa" : color} transparent opacity={selected ? 0.9 : 0.45} side={THREE.DoubleSide} />
      </mesh>
      {selected && <mesh position={[0, 0.015, 0]} rotation-x={-Math.PI / 2}><circleGeometry args={[1.1, 40]} /><meshBasicMaterial color="#3b82f6" transparent opacity={0.18} /></mesh>}
      {!lite && (r.status === "ERROR") && <pointLight position={[0, 1, 0]} color="#ef4444" intensity={4} distance={5} />}
      {showLabel && (
        <Html position={[0, 1.5, 0]} zIndexRange={[10, 0]}>
          <div className={"lbl" + (selected ? " sel" : r.status === "ERROR" ? " err" : r.status === "CHARGING" ? " chg" : "")} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
            {r.status === "ERROR" ? "⚠ " : ""}{r.id}
          </div>
        </Html>
      )}
    </group>
  );
}

type RobotVisualProps = { r: RobotState; selected: boolean; onSelect: () => void; showLabel: boolean; lite?: boolean };
function RobotMarker({ r, selected, onSelect, showLabel, height = 1.3 }: RobotVisualProps & { height?: number }) {
  return showLabel ? <Html position={[0, height, 0]} zIndexRange={[10, 0]}><div className={"lbl" + (selected ? " sel" : r.status === "ERROR" ? " err" : "")} onClick={(e) => { e.stopPropagation(); onSelect(); }}>{r.status === "ERROR" ? "⚠ " : ""}{r.id}</div></Html> : null;
}

function GroundRobotBase({ r, children, selected, onSelect, showLabel }: RobotVisualProps & { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null!);
  const init = useRef<[number, number, number]>([r.position[0], FLOOR_ELEV[r.floor] ?? 0, r.position[2]]);
  useFrame((_, dt) => {
    const g = ref.current; if (!g) return;
    const k = 1 - Math.pow(0.0005, dt);
    g.position.x += (r.position[0] - g.position.x) * k;
    g.position.z += (r.position[2] - g.position.z) * k;
    g.position.y += ((FLOOR_ELEV[r.floor] ?? 0) + explodeY(r.floor, useStore.getState().activeFloor) - g.position.y) * k;
    g.rotation.y += ((-r.heading - g.rotation.y + Math.PI) % (2 * Math.PI)) - Math.PI;
  });
  return <group ref={ref} position={init.current}><group scale={RSCALE} onClick={(e) => { e.stopPropagation(); onSelect(); }}>{children}</group><RobotMarker r={r} selected={selected} onSelect={onSelect} showLabel={showLabel} /></group>;
}

/** Shelf level (1-4) → how far the torso rises above its rest height (m). Level 1 is a crouch. */
const TORSO_LIFT = [0, -0.12, 0.1, 0.45, 0.85];

/**
 * HUM-1: a legged quadruped with a vertical torso lift and one two-joint arm with a two-finger gripper.
 * Body, legs, lift column, arm and head are all driven per frame from the robot's FSM phase and its task's
 * shelf level (same lerp pattern as RobotMesh). The head doubles as the status light and pulses when the
 * brain was just read for this robot (store.brainPulse).
 */
function QuadrupedMesh(p: RobotVisualProps) {
  const { r } = p;
  const c = STATUS_COLOR[r.status];
  const torso = useRef<THREE.Group>(null!);
  const shoulder = useRef<THREE.Group>(null!);
  const elbow = useRef<THREE.Group>(null!);
  const fingers = useRef<[THREE.Mesh | null, THREE.Mesh | null]>([null, null]);
  const head = useRef<THREE.MeshStandardMaterial>(null!);
  const legs = useRef<THREE.Group>(null!);
  const task = useStore((s) => (r.current_task_id ? s.twin.tasks[r.current_task_id] : undefined));
  const level = task?.level ?? 1;
  const working = r.fsm === "PICKING" || r.fsm === "DELIVERING";
  const loaded = r.load.current > 0;
  useFrame(({ clock }, dt) => {
    const k = 1 - Math.pow(0.02, dt);
    // Torso lift: rise to the shelf level while picking or delivering, rest otherwise
    const ty = working ? TORSO_LIFT[Math.min(4, Math.max(1, level))] : 0;
    if (torso.current) torso.current.position.y += (ty - torso.current.position.y) * k;
    // Arm: folded while travelling, reaching forward while working, slightly raised while carrying
    const sh = working ? -0.35 : loaded ? -0.9 : -1.35;
    const el = working ? 0.5 : loaded ? 1.6 : 2.3;
    if (shoulder.current) shoulder.current.rotation.z += (sh - shoulder.current.rotation.z) * k;
    if (elbow.current) elbow.current.rotation.z += (el - elbow.current.rotation.z) * k;
    // Gripper: open when reaching, closed on the box when loaded
    const gap = loaded ? 0.06 : working ? 0.16 : 0.1;
    fingers.current.forEach((f, i) => { if (f) f.position.z += ((i ? gap : -gap) - f.position.z) * k; });
    // Legs: a small gait bob while walking
    if (legs.current) legs.current.position.y = r.velocity > 0.05 ? Math.abs(Math.sin(clock.elapsedTime * 9)) * 0.02 : 0;
    // Head: brain read pulse
    if (head.current) {
      const pulse = useStore.getState().brainPulse[r.id];
      const active = pulse !== undefined && Date.now() - pulse < 1800;
      head.current.emissiveIntensity = active ? 1.2 + Math.sin(clock.elapsedTime * 14) * 0.8 : 0.3;
      head.current.emissive.set(active ? "#60a5fa" : c);
    }
  });
  const steel = <meshStandardMaterial color="#475569" metalness={0.6} roughness={0.4} />;
  return (
    <GroundRobotBase {...p}>
      {/* Legs */}
      <group ref={legs}>
        {[[-0.26, -0.16], [0.26, -0.16], [-0.26, 0.16], [0.26, 0.16]].map(([x, z], i) => (
          <group key={i} position={[x, 0.3, z]}>
            <mesh rotation-z={i % 2 ? -0.12 : 0.12}><boxGeometry args={[0.1, 0.48, 0.1]} />{steel}</mesh>
            <mesh position={[0, -0.23, 0]}><boxGeometry args={[0.16, 0.08, 0.18]} /><meshStandardMaterial color="#1e293b" /></mesh>
          </group>
        ))}
      </group>
      {/* Body */}
      <mesh position={[0, 0.52, 0]} castShadow><boxGeometry args={[0.72, 0.3, 0.42]} /><meshStandardMaterial color="#d1d5db" metalness={0.5} /></mesh>
      {/* Lift column (fixed) + torso (rises) */}
      <mesh position={[-0.12, 0.78, 0]}><boxGeometry args={[0.12, 0.24, 0.12]} /><meshStandardMaterial color="#1f2937" metalness={0.7} /></mesh>
      <group ref={torso} position={[0, 0, 0]}>
        <mesh position={[-0.12, 1.0, 0]} castShadow><boxGeometry args={[0.3, 0.3, 0.3]} /><meshStandardMaterial color="#e5e7eb" metalness={0.45} roughness={0.4} /></mesh>
        {/* Head / sensor pod = status light */}
        <mesh position={[0.02, 1.22, 0]}><sphereGeometry args={[0.11, 12, 8]} /><meshStandardMaterial ref={head} color={c} emissive={c} emissiveIntensity={0.3} /></mesh>
        {/* Arm: shoulder → upper arm → elbow → forearm → gripper */}
        <group ref={shoulder} position={[0.04, 1.08, 0]} rotation-z={-1.35}>
          <mesh position={[0.2, 0, 0]}><boxGeometry args={[0.4, 0.08, 0.08]} />{steel}</mesh>
          <group ref={elbow} position={[0.4, 0, 0]} rotation-z={2.3}>
            <mesh position={[0.18, 0, 0]}><boxGeometry args={[0.36, 0.07, 0.07]} /><meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.35} /></mesh>
            <group position={[0.38, 0, 0]}>
              <mesh><boxGeometry args={[0.06, 0.06, 0.2]} /><meshStandardMaterial color="#1f2937" /></mesh>
              <mesh ref={(m) => { fingers.current[0] = m; }} position={[0.07, 0, -0.1]}><boxGeometry args={[0.12, 0.04, 0.03]} /><meshStandardMaterial color="#facc15" /></mesh>
              <mesh ref={(m) => { fingers.current[1] = m; }} position={[0.07, 0, 0.1]}><boxGeometry args={[0.12, 0.04, 0.03]} /><meshStandardMaterial color="#facc15" /></mesh>
              {loaded && <mesh position={[0.17, 0, 0]} castShadow><boxGeometry args={[0.26, 0.22, 0.26]} /><meshStandardMaterial color="#c49a6c" roughness={0.9} /></mesh>}
            </group>
          </group>
        </group>
      </group>
    </GroundRobotBase>
  );
}

function CrawlerMesh(p: RobotVisualProps) {
  const c = STATUS_COLOR[p.r.status];
  return <GroundRobotBase {...p}><mesh position={[0, 0.28, 0]} castShadow><boxGeometry args={[0.95, 0.32, 0.62]} /><meshStandardMaterial color="#64748b" metalness={0.7} /></mesh>{[-0.39, 0.39].map((x) => <mesh key={x} position={[x, 0.2, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.2, 0.2, 0.16, 12]} /><meshStandardMaterial color="#111827" /></mesh>)}<mesh position={[0, 0.52, 0]}><boxGeometry args={[0.6, 0.12, 0.4]} /><meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.25} /></mesh></GroundRobotBase>;
}

function StaticSensorMesh(p: RobotVisualProps) {
  return <GroundRobotBase {...p}><mesh position={[0, 0.65, 0]}><cylinderGeometry args={[0.09, 0.13, 1.2, 10]} /><meshStandardMaterial color="#94a3b8" metalness={0.7} /></mesh><mesh position={[0, 1.32, 0]}><sphereGeometry args={[0.18, 12, 8]} /><meshStandardMaterial color="#38bdf8" emissive="#0284c7" emissiveIntensity={0.8} /></mesh></GroundRobotBase>;
}

function DroneMesh({ r, selected, onSelect, showLabel }: RobotVisualProps) {
  const ref = useRef<THREE.Group>(null!);
  const rotors = useRef<THREE.Group>(null!);
  const init = useRef<[number, number, number]>([r.position[0], r.position[1], r.position[2]]);
  useFrame(({ clock }, dt) => {
    const g = ref.current; if (!g) return;
    const k = 1 - Math.pow(0.0005, dt);
    const flying = r.flight && r.flight.mode !== "GROUNDED" && r.flight.mode !== "LANDED";
    const bob = flying ? Math.sin(clock.elapsedTime * 2.2) * 0.18 : 0;
    const ty = r.position[1] + bob + explodeY(r.floor, useStore.getState().activeFloor);
    g.position.x += (r.position[0] - g.position.x) * k; g.position.y += (ty - g.position.y) * k; g.position.z += (r.position[2] - g.position.z) * k;
    if (rotors.current) rotors.current.rotation.y += dt * (flying ? 26 : 6);
  });
  const c = STATUS_COLOR[r.status];
  return <group ref={ref} position={init.current}><group scale={RSCALE} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
    {/* Body raised on landing skids so the airframe sits above the deck surface */}
    <group position={[0, 0.42, 0]}>
      <mesh castShadow><boxGeometry args={[0.5, 0.18, 0.5]} /><meshStandardMaterial color="#e5e7eb" metalness={0.5} /></mesh>
      <mesh position={[0, -0.13, 0]}><sphereGeometry args={[0.12, 10, 8]} /><meshStandardMaterial color="#0f172a" metalness={0.6} /></mesh>
      {[[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([x, z], i) => <mesh key={"arm" + i} position={[x * 0.55, 0.02, z * 0.55]} rotation-y={Math.atan2(z, x)}><boxGeometry args={[0.55, 0.05, 0.08]} /><meshStandardMaterial color="#475569" metalness={0.6} /></mesh>)}
      <group ref={rotors}>{[[-0.55, 0, -0.55], [0.55, 0, -0.55], [-0.55, 0, 0.55], [0.55, 0, 0.55]].map(([x, y, z], i) => <group key={i} position={[x, y, z]}><mesh><cylinderGeometry args={[0.045, 0.045, 0.2, 8]} /><meshStandardMaterial color="#334155" /></mesh><mesh position={[0, 0.12, 0]}><boxGeometry args={[0.55, 0.03, 0.09]} /><meshStandardMaterial color="#0f172a" /></mesh></group>)}</group>
      <mesh position={[0.26, 0, 0]}><sphereGeometry args={[0.06, 8, 8]} /><meshBasicMaterial color={c} /></mesh>
    </group>
    {/* Landing skids */}
    {[-0.22, 0.22].map((z) => <group key={"skid" + z}><mesh position={[0, 0.02, z]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.025, 0.025, 0.7, 6]} /><meshStandardMaterial color="#64748b" metalness={0.7} /></mesh>{[-0.2, 0.2].map((x) => <mesh key={"leg" + x} position={[x, 0.16, z]}><cylinderGeometry args={[0.02, 0.02, 0.28, 6]} /><meshStandardMaterial color="#64748b" metalness={0.7} /></mesh>)}</group>)}
    <pointLight color={c} intensity={0.8} distance={3} />
  </group><RobotMarker r={r} selected={selected} onSelect={onSelect} showLabel={showLabel} height={1.1} /></group>;
}

function RobotVisual(p: RobotVisualProps) {
  switch (p.r.locomotion) {
    case "legged": return <QuadrupedMesh {...p} />;
    case "aerial": return <DroneMesh {...p} />;
    case "static": return <StaticSensorMesh {...p} />;
    case "wheeled": {
      const crawler = spec.fleet.classes.find((c) => c.id === p.r.model)?.crawler;
      return crawler ? <CrawlerMesh {...p} /> : <RobotMesh {...p} smooth />;
    }
    default: return <RobotMesh {...p} smooth />;
  }
}

const PERC_COLOR = { CLEAR: "#22d3ee", SLOWING: "#f59e0b", STOPPED: "#ef4444", OFF: "#475569" } as const;
/** Selected robot's perception layer: FoV fan (color = perception state), clear-ahead line, obstacle rays */
function PerceptionGizmo({ r }: { r: RobotState }) {
  const P = r.perception; if (!P) return null;
  const col = PERC_COLOR[P.state];
  const cls = spec.fleet.classes.find((c) => c.id === r.model);
  const range = cls?.lidar.range_m ?? 4;
  const fov = ((cls?.lidar.fov_deg ?? 270) * Math.PI) / 180;
  return (
    <group>
      <mesh position={[0, 0.025, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.7, range, 48, 1, -fov / 2, fov]} />
        <meshBasicMaterial color={col} transparent opacity={P.state === "STOPPED" ? 0.16 : 0.09} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.03, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[range - 0.05, range, 48, 1, -fov / 2, fov]} />
        <meshBasicMaterial color={col} transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line points={[[0.7, 0.08, 0], [Math.max(0.7, P.ahead_m), 0.08, 0]]} color={col} lineWidth={2} transparent opacity={0.9} />
      {P.obstacles.map((o, i) => {
        const b = (-o.bearing_deg * Math.PI) / 180; const x = o.distance_m * Math.cos(b), z = o.distance_m * Math.sin(b);
        const blocking = o.kind !== "FIXTURE" && P.state !== "CLEAR" && o.distance_m <= P.ahead_m + 0.05;
        const c = o.kind === "FIXTURE" ? "#94a3b8" : blocking ? "#ef4444" : o.kind === "HUMAN" ? "#f97316" : "#fbbf24";
        return (
          <group key={i}>
            <Line points={[[0, 0.1, 0], [x, 0.1, z]]} color={c} lineWidth={blocking ? 2 : 1} dashed={o.kind === "FIXTURE"} dashSize={0.3} gapSize={0.2} transparent opacity={0.85} />
            {o.kind !== "FIXTURE" && <mesh position={[x, 0.1, z]}><sphereGeometry args={[0.12, 8, 8]} /><meshBasicMaterial color={c} /></mesh>}
          </group>
        );
      })}
    </group>
  );
}

/** Current A* path (cells → world); thicker when selected; ring at the goal */
function RobotPath({ r, selected }: { r: RobotState; selected: boolean }) {
  const pts = useMemo(() => {
    if (r.path.length === 0 || r.path_index >= r.path.length) return null;
    const y = (FLOOR_ELEV[r.floor] ?? 0) + explodeY(r.floor, useStore.getState().activeFloor) + 0.06;
    const out: [number, number, number][] = [[r.position[0], y, r.position[2]]];
    for (let i = r.path_index; i < r.path.length; i++) out.push([r.path[i][0] + 0.5, y, r.path[i][1] + 0.5]);
    return out;
  }, [r.path, r.path_index, r.position, r.floor]);
  if (!pts) return null;
  const end = pts[pts.length - 1];
  const col = r.fsm === "GOING_TO_CHARGE" ? "#60a5fa" : r.load.current > 0 ? "#f59e0b" : "#22d3ee";
  return (
    <group>
      <Line points={pts} color={selected ? "#ffffff" : col} lineWidth={selected ? 2.4 : 1.1} dashed dashSize={0.7} gapSize={0.4} transparent opacity={selected ? 1 : 0.5} />
      <mesh position={[end[0], end[1] - 0.01, end[2]]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.45, 0.65, 24]} /><meshBasicMaterial color={col} transparent opacity={0.85} /></mesh>
    </group>
  );
}

export function Robots({ lite = false }: { lite?: boolean }) {
  const robots = useStore((s) => s.twin.robots);
  const selected = useStore((s) => s.selectedRobot);
  const select = useStore((s) => s.select);
  const showLabels = useStore((s) => s.showLabels);
  const showPaths = useStore((s) => s.showPaths);
  const af = useStore((s) => s.activeFloor);
  const activeFloor = lite || af === "exploded" ? "all" : af;
  const visible = (r: RobotState) => activeFloor === "all" || r.floor === activeFloor || !!r.lift_id;
  return (
    <group>
      {Object.values(robots).filter(visible).map((r) => (
        <group key={r.id}>
          <RobotVisual r={r} selected={r.id === selected} onSelect={() => select(r.id)} showLabel={showLabels && !lite} lite={lite} />
          {showPaths && !lite && <RobotPath r={r} selected={r.id === selected} />}
        </group>
      ))}
    </group>
  );
}
