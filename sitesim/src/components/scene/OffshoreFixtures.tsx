import { useRef } from "react";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { site } from "../../state/store";
import type {
  AnchorFixture, CraneFixture, CrewQuartersFixture, DerrickFixture, FireStationFixture, FlareStackFixture,
  HelideckFixture, LaydownFixture, LifeboatFixture, ManifoldFixture, PipeRackFixture,
  RiserFixture, StairsFixture, StorageTankFixture, SubseaPipelineFixture, UmbilicalFixture, WellheadFixture,
} from "../../spec/types";

const steel = "#334155";
const accent = "#22d3ee";

function Wellhead({ f }: { f: WellheadFixture }) {
  return (
    <group position={f.position}>
      <mesh position={[0, 0.35, 0]} castShadow><cylinderGeometry args={[0.7, 0.8, 0.7, 12]} /><meshStandardMaterial color="#374151" metalness={0.75} roughness={0.35} /></mesh>
      <mesh position={[0, 0.9, 0]}><cylinderGeometry args={[0.52, 0.52, 0.25, 8]} /><meshStandardMaterial color="#111827" metalness={0.8} roughness={0.3} /></mesh>
      {[0.35, 0.75, 1.15].map((y, i) => (
        <group key={i} position={[0, y, 0]} rotation-y={i * 0.4}>
          <mesh><cylinderGeometry args={[0.18, 0.18, 0.95, 8]} /><meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.3} /></mesh>
          <mesh rotation-z={Math.PI / 2}><cylinderGeometry args={[0.12, 0.12, 0.8, 8]} /><meshStandardMaterial color="#94a3b8" metalness={0.75} roughness={0.3} /></mesh>
        </group>
      ))}
      <mesh position={[0, 1.55, 0]}><sphereGeometry args={[0.12, 8, 8]} /><meshBasicMaterial color="#f59e0b" /></mesh>
    </group>
  );
}

function FlareStack({ f }: { f: FlareStackFixture }) {
  const flame = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => {
    if (!flame.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 8) * 0.12;
    flame.current.scale.set(pulse, 0.85 + Math.sin(clock.elapsedTime * 11) * 0.16, pulse);
  });
  return (
    <group position={f.position}>
      <mesh position={[0, f.height / 2, 0]} castShadow><cylinderGeometry args={[0.35, 0.9, f.height, 8]} /><meshStandardMaterial color="#475569" metalness={0.7} roughness={0.45} /></mesh>
      {[0.8, 1.5, 2.2].map((y, i) => <mesh key={i} position={[0, y * f.height / 3, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.04, 0.04, 1.7, 6]} /><meshStandardMaterial color="#64748b" metalness={0.75} /></mesh>)}
      <group ref={flame} position={[0, f.height + 0.45, 0]}>
        <mesh><coneGeometry args={[0.42, 0.9, 8]} /><meshStandardMaterial color="#f97316" emissive="#ef4444" emissiveIntensity={2.2} /></mesh>
        <pointLight color="#fb923c" intensity={1.8} distance={8} />
      </group>
      <Html position={[0, f.height + 1.2, 0]} center zIndexRange={[2, 0]} style={{ pointerEvents: "none" }}><div className="sign-lbl" style={{ color: "#fb923c", borderColor: "#c2410c" }}>FLARE</div></Html>
    </group>
  );
}

function PipeRack({ f }: { f: PipeRackFixture }) {
  const pipes = Array.from({ length: Math.max(1, f.pipe_count) });
  return (
    <group>
      {f.path.slice(0, -1).map((a, i) => {
        const b = f.path[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        return (
          <group key={i} position={[(a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2]} rotation-y={-ang}>
            {pipes.map((_, p) => <mesh key={p} position={[0, 1.35 + (p % 2) * 0.2, (p - (pipes.length - 1) / 2) * Math.min(0.35, f.width / Math.max(1, pipes.length))]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.1, 0.1, len, 8]} /><meshStandardMaterial color={p % 3 === 0 ? "#d97706" : steel} metalness={0.75} roughness={0.35} /></mesh>)}
            {[-1, 1].map((x) => <mesh key={x} position={[x * (len / 2 - 0.3), 0.65, 0]}><boxGeometry args={[0.3, 1.3, f.width]} /><meshStandardMaterial color="#475569" metalness={0.65} roughness={0.45} /></mesh>)}
          </group>
        );
      })}
    </group>
  );
}

function Manifold({ f }: { f: ManifoldFixture }) {
  const [x0, z0, x1, z1] = f.rect;
  return <group position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}>
    <mesh position={[0, 0.45, 0]} castShadow><boxGeometry args={[x1 - x0, 0.9, z1 - z0]} /><meshStandardMaterial color="#374151" metalness={0.7} roughness={0.4} /></mesh>
    {Array.from({ length: 4 }, (_, i) => <mesh key={i} position={[-(x1 - x0) / 2 + 0.8 + (i % 2) * (x1 - x0 - 1.6), 1.25, -(z1 - z0) / 2 + 0.8 + Math.floor(i / 2) * (z1 - z0 - 1.6)]}><cylinderGeometry args={[0.18, 0.18, 0.6, 8]} /><meshStandardMaterial color="#eab308" metalness={0.65} /></mesh>)}
  </group>;
}

function StorageTank({ f }: { f: StorageTankFixture }) {
  return <group position={f.position}>
    <mesh position={[0, f.height / 2, 0]} castShadow><cylinderGeometry args={[f.radius, f.radius * 1.04, f.height, 16]} /><meshStandardMaterial color="#64748b" metalness={0.7} roughness={0.45} /></mesh>
    <mesh position={[0, f.height + 0.03, 0]} rotation-x={-Math.PI / 2}><circleGeometry args={[f.radius * 0.94, 16]} /><meshStandardMaterial color="#1e293b" metalness={0.55} roughness={0.4} /></mesh>
    <mesh position={[0, f.height + 0.3, 0]}><cylinderGeometry args={[0.12, 0.12, 0.6, 8]} /><meshStandardMaterial color="#94a3b8" metalness={0.8} /></mesh>
  </group>;
}

function Riser({ f }: { f: RiserFixture }) {
  return <group position={f.position}>
    <mesh position={[0, 1.4, 0]} castShadow><cylinderGeometry args={[0.28, 0.34, 2.8, 10]} /><meshStandardMaterial color="#f59e0b" metalness={0.75} roughness={0.35} /></mesh>
    <mesh position={[0, 0.15, 0]}><torusGeometry args={[0.45, 0.08, 6, 12]} /><meshStandardMaterial color="#64748b" metalness={0.7} /></mesh>
  </group>;
}

function Helideck({ f }: { f: HelideckFixture }) {
  const r = f.radius;
  return <group position={f.position}>
    <mesh rotation-x={-Math.PI / 2} receiveShadow><cylinderGeometry args={[r, r, 0.18, 8]} /><meshStandardMaterial color="#475569" metalness={0.45} roughness={0.75} /></mesh>
    {[-1, 1].map((s) => <mesh key={s} position={[s * r * 0.3, 0.11, 0]} rotation-x={-Math.PI / 2}><boxGeometry args={[0.2, r * 0.9, 0.05]} /><meshBasicMaterial color="#f8fafc" /></mesh>)}
    <mesh position={[0, 0.11, 0]} rotation-x={-Math.PI / 2}><boxGeometry args={[r * 0.6 - 0.2, 0.2, 0.05]} /><meshBasicMaterial color="#f8fafc" /></mesh>
    {Array.from({ length: 8 }, (_, i) => <mesh key={i} position={[Math.cos(i * Math.PI / 4) * r, 0.35, Math.sin(i * Math.PI / 4) * r]}><cylinderGeometry args={[0.04, 0.04, 0.48, 6]} /><meshStandardMaterial color="#eab308" /></mesh>)}
  </group>;
}

function CrewQuarters({ f }: { f: CrewQuartersFixture }) {
  const [x0, z0, x1, z1] = f.rect, w = x1 - x0, d = z1 - z0;
  return <group position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}>
    <mesh position={[0, f.height / 2, 0]} castShadow><boxGeometry args={[w, f.height, d]} /><meshStandardMaterial color="#334155" metalness={0.55} roughness={0.6} /></mesh>
    {Array.from({ length: Math.max(2, Math.floor(w / 3)) }, (_, i) => <mesh key={i} position={[-w / 2 + 1.4 + i * (w - 2.8) / Math.max(1, Math.floor(w / 3) - 1), f.height * 0.58, d / 2 + 0.01]}><boxGeometry args={[0.9, 0.55, 0.03]} /><meshStandardMaterial color="#67e8f9" emissive="#0e7490" emissiveIntensity={0.6} /></mesh>)}
    <mesh position={[0, f.height + 0.08, 0]}><boxGeometry args={[w + 0.3, 0.16, d + 0.3]} /><meshStandardMaterial color="#1e293b" metalness={0.7} /></mesh>
  </group>;
}

function Stairs({ f }: { f: StairsFixture }) {
  const steps = 8, width = f.rect ? f.rect[2] - f.rect[0] : 1.8, len = f.rect ? f.rect[3] - f.rect[1] : 4;
  return <group position={f.position} rotation-y={-f.rotation}>
    {Array.from({ length: steps }, (_, i) => <mesh key={i} position={[0, i * 0.28, -len / 2 + (i + 0.5) * len / steps]}><boxGeometry args={[width, 0.18, len / steps + 0.04]} /><meshStandardMaterial color={steel} metalness={0.7} roughness={0.55} /></mesh>)}
    <mesh position={[0, 1.3, 0]}><boxGeometry args={[0.06, 2.6, len]} /><meshStandardMaterial color="#94a3b8" metalness={0.75} /></mesh>
  </group>;
}

function Crane({ f }: { f: CraneFixture }) {
  const boom = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => { if (boom.current) boom.current.rotation.y = -f.rotation + Math.sin(clock.elapsedTime * 0.12) * 0.5; });
  const L = f.boom_length;
  return (
    <group position={f.position}>
      <mesh position={[0, 1.4, 0]} castShadow><cylinderGeometry args={[1.1, 1.5, 2.8, 12]} /><meshStandardMaterial color="#b45309" metalness={0.6} roughness={0.4} /></mesh>
      <group ref={boom} position={[0, 2.8, 0]}>
        <mesh position={[0, 1.1, 0]} castShadow><boxGeometry args={[2.4, 2.2, 2.2]} /><meshStandardMaterial color="#d97706" metalness={0.55} roughness={0.45} /></mesh>
        <mesh position={[0.9, 1.5, 1.12]}><boxGeometry args={[1.0, 0.9, 0.06]} /><meshStandardMaterial color="#93c5fd" emissive="#1d4ed8" emissiveIntensity={0.4} /></mesh>
        <group position={[1.2, 2.0, 0]} rotation-z={-0.5}>
          <mesh position={[L / 2, 0, 0]} castShadow><boxGeometry args={[L, 0.7, 0.7]} /><meshStandardMaterial color="#f59e0b" metalness={0.5} roughness={0.5} /></mesh>
          {Array.from({ length: Math.max(3, Math.floor(L / 2.2)) }, (_, i) => <mesh key={i} position={[0.8 + i * 2.2, 0, 0]} rotation-x={Math.PI / 4}><boxGeometry args={[0.08, 1.0, 0.08]} /><meshStandardMaterial color="#92400e" /></mesh>)}
          <mesh position={[L - 0.3, -1.6, 0]}><cylinderGeometry args={[0.03, 0.03, 3.2, 6]} /><meshStandardMaterial color="#1e293b" /></mesh>
          <mesh position={[L - 0.3, -3.3, 0]}><boxGeometry args={[0.5, 0.6, 0.5]} /><meshStandardMaterial color="#334155" metalness={0.7} /></mesh>
        </group>
        <mesh position={[-1.6, 1.4, 0]}><boxGeometry args={[1.2, 1.4, 1.6]} /><meshStandardMaterial color="#78350f" metalness={0.5} /></mesh>
      </group>
      <mesh position={[0, 6.6, 0]}><sphereGeometry args={[0.1, 8, 8]} /><meshBasicMaterial color="#ef4444" /></mesh>
    </group>
  );
}

function Derrick({ f }: { f: DerrickFixture }) {
  const H = f.height, B = f.base, top = B * 0.3;
  const legAngle = Math.atan2((B - top) / 2, H);
  return (
    <group position={f.position}>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[sx * (B + top) / 4, H / 2, sz * (B + top) / 4]} rotation-z={-sx * legAngle} rotation-x={sz * legAngle} castShadow>
          <boxGeometry args={[0.3, H / Math.cos(legAngle), 0.3]} /><meshStandardMaterial color="#7c2d12" metalness={0.6} roughness={0.45} />
        </mesh>
      ))}
      {[0.25, 0.5, 0.75].map((t, i) => {
        const w = B - (B - top) * t;
        return <group key={i} position={[0, H * t, 0]}>{[[0, -1], [0, 1], [-1, 0], [1, 0]].map(([sx, sz], j) => <mesh key={j} position={[sx * w / 2, 0, sz * w / 2]} rotation-y={sx ? Math.PI / 2 : 0}><boxGeometry args={[w, 0.18, 0.18]} /><meshStandardMaterial color="#9a3412" metalness={0.6} /></mesh>)}</group>;
      })}
      <mesh position={[0, H + 0.4, 0]}><boxGeometry args={[top + 0.6, 0.8, top + 0.6]} /><meshStandardMaterial color="#57534e" metalness={0.65} /></mesh>
      <mesh position={[0, H * 0.55, 0]}><cylinderGeometry args={[0.14, 0.14, H * 0.9, 8]} /><meshStandardMaterial color="#44403c" metalness={0.75} /></mesh>
      <mesh position={[0, H + 0.95, 0]}><sphereGeometry args={[0.12, 8, 8]} /><meshBasicMaterial color="#ef4444" /></mesh>
      <mesh position={[0, 1.1, 0]} castShadow><boxGeometry args={[B * 0.55, 2.2, B * 0.55]} /><meshStandardMaterial color="#292524" metalness={0.6} roughness={0.5} /></mesh>
    </group>
  );
}

function Laydown({ f }: { f: LaydownFixture }) {
  const [x0, z0, x1, z1] = f.rect, w = x1 - x0, d = z1 - z0;
  const containers: Array<[number, number, number, string]> = [
    [-w / 4, 0, -d / 5, "#b91c1c"], [-w / 4 + 2.6, 0, -d / 5, "#1d4ed8"], [-w / 4 + 1.3, 1.05, -d / 5, "#15803d"],
    [w / 5, 0, d / 6, "#a16207"], [w / 5 + 2.6, 0, d / 6, "#334155"],
  ];
  return (
    <group position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}>
      <mesh position={[0, 0.006, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[w, d]} /><meshBasicMaterial color="#78716c" transparent opacity={0.22} /></mesh>
      <lineSegments position={[0, 0.02, 0]}><edgesGeometry args={[new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2)]} /><lineBasicMaterial color="#eab308" /></lineSegments>
      {containers.map(([cx, cy, cz, col], i) => (
        <mesh key={i} position={[cx, cy + 0.52, cz]} castShadow><boxGeometry args={[2.4, 1.0, 1.1]} /><meshStandardMaterial color={col} metalness={0.4} roughness={0.6} /></mesh>
      ))}
      {/* Pipe bundle */}
      {Array.from({ length: 5 }, (_, i) => (
        <mesh key={"p" + i} position={[-w / 5, 0.16 + Math.floor(i / 3) * 0.3, d / 4 - 0.4 + (i % 3) * 0.32]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[0.15, 0.15, w * 0.42, 8]} /><meshStandardMaterial color="#64748b" metalness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function Lifeboat({ f }: { f: LifeboatFixture }) {
  return (
    <group position={f.position} rotation-y={-f.rotation}>
      {[-1.3, 1.3].map((x) => <group key={x} position={[x, 0, 0]}><mesh position={[0, 1.5, 0]} rotation-x={-0.5} castShadow><boxGeometry args={[0.22, 3.2, 0.22]} /><meshStandardMaterial color="#475569" metalness={0.7} /></mesh><mesh position={[0, 0.15, 0]}><boxGeometry args={[0.7, 0.3, 0.7]} /><meshStandardMaterial color="#334155" metalness={0.6} /></mesh></group>)}
      <group position={[0, 2.0, -0.9]} rotation-x={-0.35}>
        <mesh castShadow><capsuleGeometry args={[0.55, 2.4, 6, 10]} /><meshStandardMaterial color="#ea580c" metalness={0.3} roughness={0.5} /></mesh>
        <mesh position={[0, 0.35, 0]}><boxGeometry args={[2.0, 0.35, 0.7]} /><meshStandardMaterial color="#f8fafc" roughness={0.5} /></mesh>
      </group>
      <mesh position={[0, 0.02, 1]} rotation-x={-Math.PI / 2}><planeGeometry args={[4.4, 2]} /><meshBasicMaterial color="#16a34a" transparent opacity={0.25} /></mesh>
    </group>
  );
}

function FireStation({ f }: { f: FireStationFixture }) {
  return (
    <group position={f.position}>
      <mesh position={[0, 0.8, 0]} castShadow><boxGeometry args={[1.3, 1.6, 0.6]} /><meshStandardMaterial color="#dc2626" metalness={0.4} roughness={0.5} /></mesh>
      <mesh position={[0, 1.0, 0.31]}><planeGeometry args={[1.0, 0.9]} /><meshStandardMaterial color="#fca5a5" /></mesh>
      <mesh position={[0.9, 0.35, 0]}><torusGeometry args={[0.3, 0.1, 8, 14]} /><meshStandardMaterial color="#7f1d1d" /></mesh>
      <group position={[-0.95, 0, 0]}>
        <mesh position={[0, 0.55, 0]}><cylinderGeometry args={[0.08, 0.1, 1.1, 8]} /><meshStandardMaterial color="#991b1b" metalness={0.6} /></mesh>
        <mesh position={[0.18, 1.12, 0]} rotation-z={-0.8}><cylinderGeometry args={[0.06, 0.09, 0.55, 8]} /><meshStandardMaterial color="#b91c1c" metalness={0.7} /></mesh>
      </group>
      <mesh position={[0, 1.75, 0]}><sphereGeometry args={[0.09, 8, 8]} /><meshBasicMaterial color="#ef4444" /></mesh>
    </group>
  );
}

function SubseaPipeline({ f }: { f: SubseaPipelineFixture }) {
  return (
    <group position={[0, -f.depth, 0]}>
      {f.path.slice(0, -1).map((a, i) => {
        const b = f.path[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        return <mesh key={i} position={[(a[0] + b[0]) / 2, 0.35, (a[1] + b[1]) / 2]} rotation-y={-ang} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.35, 0.35, len, 10]} /><meshStandardMaterial color="#374151" metalness={0.5} roughness={0.7} /></mesh>;
      })}
      {f.path.map(([x, z], i) => <mesh key={"j" + i} position={[x, 0.35, z]}><sphereGeometry args={[0.5, 10, 8]} /><meshStandardMaterial color="#1f2937" metalness={0.5} roughness={0.7} /></mesh>)}
    </group>
  );
}

function Umbilical({ f }: { f: UmbilicalFixture }) {
  const pts = Array.from({ length: 13 }, (_, i) => {
    const t = i / 12;
    return new THREE.Vector3(f.position[0] + Math.sin(t * Math.PI) * 3.5, -t * f.depth, f.position[2] + t * 6);
  });
  const curve = new THREE.CatmullRomCurve3(pts);
  return (
    <mesh>
      <tubeGeometry args={[curve, 24, 0.16, 6]} />
      <meshStandardMaterial color="#facc15" metalness={0.3} roughness={0.6} />
    </mesh>
  );
}

function Anchor({ f }: { f: AnchorFixture }) {
  return (
    <group position={[f.position[0], -f.depth, f.position[2]]}>
      <mesh position={[0, 0.35, 0]} rotation-x={0.3}><boxGeometry args={[1.6, 0.5, 1.0]} /><meshStandardMaterial color="#3f3f46" metalness={0.6} roughness={0.6} /></mesh>
      <mesh position={[0, 0.75, -0.4]} rotation-x={0.9}><boxGeometry args={[0.25, 1.4, 0.25]} /><meshStandardMaterial color="#52525b" metalness={0.6} /></mesh>
      {Array.from({ length: 8 }, (_, i) => <mesh key={i} position={[0.3 + i * 0.55, 0.25 + i * 0.5, 0.5 + i * 0.7]} rotation-x={0.8}><torusGeometry args={[0.22, 0.07, 6, 10]} /><meshStandardMaterial color="#71717a" metalness={0.7} /></mesh>)}
    </group>
  );
}

/** Parametric offshore fixtures, kept separate so the generic fixture dispatcher stays compact. */
export function OffshoreFixtures({ floor = 1, lite = false }: { floor?: number; lite?: boolean }) {
  const fixtures = site.spec.fixtures.filter((f) => (f.floor ?? 1) === floor);
  return <group>
    {fixtures.filter((f): f is WellheadFixture => f.kind === "wellhead").map((f) => <Wellhead key={f.id} f={f} />)}
    {fixtures.filter((f): f is FlareStackFixture => f.kind === "flare_stack").map((f) => <FlareStack key={f.id} f={f} />)}
    {fixtures.filter((f): f is PipeRackFixture => f.kind === "pipe_rack").map((f) => <PipeRack key={f.id} f={f} />)}
    {fixtures.filter((f): f is ManifoldFixture => f.kind === "manifold").map((f) => <Manifold key={f.id} f={f} />)}
    {fixtures.filter((f): f is StorageTankFixture => f.kind === "storage_tank").map((f) => <StorageTank key={f.id} f={f} />)}
    {fixtures.filter((f): f is RiserFixture => f.kind === "riser").map((f) => <Riser key={f.id} f={f} />)}
    {fixtures.filter((f): f is HelideckFixture => f.kind === "helideck").map((f) => <Helideck key={f.id} f={f} />)}
    {fixtures.filter((f): f is CrewQuartersFixture => f.kind === "crew_quarters").map((f) => <CrewQuarters key={f.id} f={f} />)}
    {fixtures.filter((f): f is StairsFixture => f.kind === "stairs").map((f) => <Stairs key={f.id} f={f} />)}
    {fixtures.filter((f): f is CraneFixture => f.kind === "crane").map((f) => <Crane key={f.id} f={f} />)}
    {fixtures.filter((f): f is DerrickFixture => f.kind === "derrick").map((f) => <Derrick key={f.id} f={f} />)}
    {fixtures.filter((f): f is LaydownFixture => f.kind === "laydown").map((f) => <Laydown key={f.id} f={f} />)}
    {fixtures.filter((f): f is LifeboatFixture => f.kind === "lifeboat").map((f) => <Lifeboat key={f.id} f={f} />)}
    {fixtures.filter((f): f is FireStationFixture => f.kind === "fire_station").map((f) => <FireStation key={f.id} f={f} />)}
    {fixtures.filter((f): f is SubseaPipelineFixture => f.kind === "subsea_pipeline").map((f) => <SubseaPipeline key={f.id} f={f} />)}
    {fixtures.filter((f): f is UmbilicalFixture => f.kind === "umbilical").map((f) => <Umbilical key={f.id} f={f} />)}
    {fixtures.filter((f): f is AnchorFixture => f.kind === "anchor").map((f) => <Anchor key={f.id} f={f} />)}
    {!lite && fixtures.some((f) => f.kind === "helideck") && <pointLight position={[0, 3, 0]} color={accent} intensity={0.4} distance={18} />}
  </group>;
}
