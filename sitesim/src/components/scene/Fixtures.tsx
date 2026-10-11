import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { site, useStore } from "../../state/store";
import type { ConveyorFixture, Fixture, UnknownFixture } from "../../spec/types";
import { OffshoreFixtures } from "./OffshoreFixtures";

/** Belt conveyor along its path; parcels ride the belt while RUNNING, ERROR flashes red */
function Conveyor({ c }: { c: ConveyorFixture }) {
  const status = useStore((s) => s.twin.conveyors[c.id]?.status ?? "RUNNING");
  const beltSpeed = useStore((s) => s.twin.conveyors[c.id]?.speed_mps ?? c.speed_mps);
  const matRef = useRef<THREE.MeshStandardMaterial>(null!);
  const parcelsRef = useRef<THREE.Group>(null!);

  const segsGeo: Array<{ ax: number; az: number; ang: number; len: number; start: number }> = [];
  let total = 0;
  for (let i = 0; i < c.path.length - 1; i++) {
    const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    segsGeo.push({ ax, az, ang: Math.atan2(bz - az, bx - ax), len, start: total });
    total += len;
  }
  const pointAt = (d: number): [number, number, number] => {
    d = ((d % total) + total) % total;
    const seg = segsGeo.find((g) => d >= g.start && d <= g.start + g.len) ?? segsGeo[segsGeo.length - 1];
    const t = d - seg.start;
    return [seg.ax + Math.cos(seg.ang) * t, 1.15, seg.az + Math.sin(seg.ang) * t];
  };
  const N_PARCELS = Math.max(2, Math.floor(total / 5));
  const offsets = useRef<number[]>(Array.from({ length: N_PARCELS }, (_, k) => (k * total) / N_PARCELS));

  useFrame(({ clock }, dt) => {
    if (status === "ERROR" && matRef.current) matRef.current.emissiveIntensity = 0.4 + Math.sin(clock.elapsedTime * 6) * 0.35;
    const st = useStore.getState();
    const v = status === "RUNNING" && !st.paused ? beltSpeed * st.speed : 0;
    const g = parcelsRef.current; if (!g) return;
    for (let k = 0; k < g.children.length; k++) {
      if (v > 0) offsets.current[k] = (offsets.current[k] + v * dt) % total;
      const [x, y, z] = pointAt(offsets.current[k]);
      g.children[k].position.set(x, y, z);
    }
  });

  const segs = [] as JSX.Element[];
  for (let i = 0; i < segsGeo.length; i++) {
    const gseg = segsGeo[i]; const len = gseg.len;
    const [ax, az] = c.path[i], [bx, bz] = c.path[i + 1];
    segs.push(
      <group key={i} position={[(ax + bx) / 2, 0, (az + bz) / 2]} rotation-y={-gseg.ang}>
        <mesh position={[0, 0.8, 0]} castShadow receiveShadow>
          <boxGeometry args={[len, 0.12, c.width]} />
          <meshStandardMaterial ref={i === 0 ? matRef : undefined} color={status === "ERROR" ? "#7f1d1d" : "#1f2937"} roughness={0.7} metalness={0.3} emissive={status === "ERROR" ? "#ef4444" : "#000"} emissiveIntensity={0.6} />
        </mesh>
        {[-1, 1].map((s) => (
          <mesh key={s} position={[0, 0.75, (s * (c.width + 0.12)) / 2]}>
            <boxGeometry args={[len, 0.3, 0.1]} />
            <meshStandardMaterial color="#4b5563" metalness={0.7} roughness={0.4} />
          </mesh>
        ))}
        {Array.from({ length: Math.max(2, Math.floor(len / 3)) }, (_, k) => (
          <mesh key={k} position={[-len / 2 + 1 + k * ((len - 2) / Math.max(1, Math.floor(len / 3) - 1)), 0.37, 0]}>
            <boxGeometry args={[0.12, 0.74, c.width]} />
            <meshStandardMaterial color="#374151" metalness={0.6} roughness={0.5} />
          </mesh>
        ))}
        <mesh position={[0, 0.92, 0]}>
          <boxGeometry args={[len, 0.02, 0.05]} />
          <meshBasicMaterial color={status === "RUNNING" ? "#22d3ee" : status === "ERROR" ? "#ef4444" : "#eab308"} />
        </mesh>
      </group>,
    );
  }
  const parcels = (
    <group ref={parcelsRef}>
      {Array.from({ length: N_PARCELS }, (_, k) => (
        <mesh key={k} castShadow>
          <boxGeometry args={[0.7, 0.5, 0.6]} />
          <meshStandardMaterial color={k % 3 === 0 ? "#b98a5e" : "#c49a6c"} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
  // End equipment: infeed hopper at the start, receiving machine at the end
  const p0 = c.path[0], pN = c.path[c.path.length - 1];
  const endEquip = (
    <group>
      <group position={[p0[0], 0, p0[1]]}>
        <mesh position={[0, 0.75, 0]} castShadow><boxGeometry args={[1.6, 1.5, 1.6]} /><meshStandardMaterial color="#39424f" metalness={0.5} roughness={0.5} /></mesh>
        <mesh position={[0, 1.62, 0]}><boxGeometry args={[1.9, 0.28, 1.9]} /><meshStandardMaterial color="#2a323d" metalness={0.6} roughness={0.4} /></mesh>
      </group>
      <group position={[pN[0], 0, pN[1]]}>
        <mesh position={[0, 0.45, 0]} castShadow><boxGeometry args={[1.7, 0.9, 1.7]} /><meshStandardMaterial color="#39424f" metalness={0.5} roughness={0.5} /></mesh>
        <mesh position={[0, 0.95, 0]} rotation-x={0.35}><boxGeometry args={[1.5, 0.08, 1.3]} /><meshStandardMaterial color="#4a5568" metalness={0.6} roughness={0.35} /></mesh>
        <mesh position={[0, 1.1, 0]}><boxGeometry args={[0.25, 0.5, 0.25]} /><meshStandardMaterial color="#22303f" /></mesh>
        <mesh position={[0, 1.4, 0]}><sphereGeometry args={[0.08, 8, 8]} /><meshBasicMaterial color="#22c55e" /></mesh>
      </group>
    </group>
  );
  return <group>{segs}{parcels}{endEquip}</group>;
}

const STATION_COLOR: Record<string, [string, string, string]> = {
  // station_kind → [floor tint, label color, label border]
  PACKING: ["#1e3a5f", "#93c5fd", "#1d4ed8"],
  PACKOUT: ["#1e3a5f", "#93c5fd", "#1d4ed8"],
  SORTING: ["#3b2a5f", "#d8b4fe", "#7e22ce"],
  STAGE: ["#4a3524", "#fcd34d", "#b45309"],
};

/** Placeholder proxy for a fixture kind the library cannot render yet (capability gap). */
function PlaceholderFixture({ f }: { f: Fixture; lite?: boolean }) {
  const u = f as UnknownFixture;
  let cx: number, cz: number, w = 1.5, d = 1.5, h = 2;
  if (u.rect) { cx = (u.rect[0] + u.rect[2]) / 2; cz = (u.rect[1] + u.rect[3]) / 2; w = u.rect[2] - u.rect[0]; d = u.rect[3] - u.rect[1]; }
  else if (u.position) { cx = u.position[0]; cz = u.position[2]; if (u.size) { w = u.size[0]; h = u.size[1]; d = u.size[2]; } }
  else return null;
  return (
    <group position={[cx, 0, cz]}>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[Math.max(0.4, w), h, Math.max(0.4, d)]} />
        <meshStandardMaterial color="#475569" transparent opacity={0.35} roughness={0.9} />
      </mesh>
      <lineSegments position={[0, h / 2, 0]}>
        <edgesGeometry args={[new THREE.BoxGeometry(Math.max(0.4, w), h, Math.max(0.4, d))]} />
        <lineBasicMaterial color="#94a3b8" />
      </lineSegments>
      <Html position={[0, h + 0.6, 0]} center zIndexRange={[2, 0]} style={{ pointerEvents: "none" }}>
        <div className="sign-lbl gap">{f.kind.replace(/_/g, " ")} · pending</div>
      </Html>
    </group>
  );
}

/** Stations, chargers, parking, restricted areas, walkways, sensors, unknown-kind placeholders */
export function Fixtures({ lite = false, floor = 1 }: { lite?: boolean; floor?: number }) {
  const robots = useStore((s) => s.twin.robots);
  const onFloor = (f: { floor?: number }) => (f.floor ?? 1) === floor;
  return (
    <group position-y={site.floorElev[floor] ?? 0}>
      {site.conveyors.filter(onFloor).map((c) => <Conveyor key={c.id} c={c} />)}

      {site.stations.filter(onFloor).map((s) => {
        const [x0, z0, x1, z1] = s.rect; const w = x1 - x0, d = z1 - z0;
        const [tint, lblColor, lblBorder] = STATION_COLOR[s.station_kind] ?? ["#31435f", "#cbd5e1", "#475569"];
        const armStation = s.station_kind === "PACKING" || s.station_kind === "PACKOUT";
        return (
          <group key={s.id} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}>
            <mesh position={[0, 0.005, 0]} rotation-x={-Math.PI / 2}>
              <planeGeometry args={[w, d]} />
              <meshBasicMaterial color={tint} transparent opacity={0.35} />
            </mesh>
            {Array.from({ length: Math.floor(w / 4) }, (_, i) => (
              <group key={i} position={[-w / 2 + 2 + i * 4, 0, 0]}>
                <mesh position={[0, 0.45, 0]} castShadow><boxGeometry args={[2.4, 0.9, 1.2]} /><meshStandardMaterial color="#334155" metalness={0.4} roughness={0.6} /></mesh>
                <mesh position={[0, 1.15, 0]}><boxGeometry args={[0.8, 0.5, 0.7]} /><meshStandardMaterial color="#c49a6c" /></mesh>
                {armStation && i % 2 === 0 && (
                  <group position={[1.6, 0, 0]}>
                    <mesh position={[0, 0.3, 0]}><cylinderGeometry args={[0.35, 0.45, 0.6, 16]} /><meshStandardMaterial color="#1f2937" metalness={0.7} roughness={0.3} /></mesh>
                    <mesh position={[0, 1.2, 0]} rotation-z={0.35}><boxGeometry args={[0.3, 1.8, 0.3]} /><meshStandardMaterial color="#e5e7eb" metalness={0.5} roughness={0.3} /></mesh>
                    <mesh position={[-0.5, 2.1, 0]} rotation-z={-0.9}><boxGeometry args={[0.25, 1.5, 0.25]} /><meshStandardMaterial color="#e5e7eb" metalness={0.5} roughness={0.3} /></mesh>
                  </group>
                )}
              </group>
            ))}
            {!lite && <Html position={[0, 0.1, d / 2 + 1]} center zIndexRange={[2, 0]} style={{ pointerEvents: "none" }}>
              <div className="sign-lbl" style={{ color: lblColor, borderColor: lblBorder }}>{s.station_kind}</div>
            </Html>}
          </group>
        );
      })}

      {site.chargers.filter(onFloor).map((c) => {
        const occupied = Object.values(robots).some((r) => r.status === "CHARGING" && Math.abs(r.position[0] - c.position[0]) < 1);
        const padDz = c.access_point[1] - c.position[2];
        return (
          <group key={c.id} position={[c.position[0], 0, c.position[2]]}>
            <mesh position={[0, 0.6, 0]} castShadow><boxGeometry args={[0.8, 1.2, 0.4]} /><meshStandardMaterial color="#1f2937" metalness={0.6} roughness={0.4} /></mesh>
            <mesh position={[0, 0.9, 0.21]}><planeGeometry args={[0.5, 0.25]} /><meshBasicMaterial color={occupied ? "#3b82f6" : "#22c55e"} /></mesh>
            <mesh position={[0, 0.01, padDz]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.6, 1.6]} /><meshBasicMaterial color="#1d4ed8" transparent opacity={0.25} /></mesh>
            {occupied && <pointLight position={[0, 1, padDz]} color="#3b82f6" intensity={lite ? 0 : 3} distance={4} />}
          </group>
        );
      })}

      {site.parking.filter(onFloor).map((p) => {
        const [x0, z0, x1, z1] = p.rect;
        return (
          <mesh key={p.id} position={[(x0 + x1) / 2, 0.005, (z0 + z1) / 2]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[x1 - x0, z1 - z0]} />
            <meshBasicMaterial color="#334155" transparent opacity={0.25} />
          </mesh>
        );
      })}

      {site.restricted.filter(onFloor).map((r) => {
        const [x0, z0, x1, z1] = r.rect;
        return (
          <group key={r.id} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}>
            <mesh position={[0, 0.006, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[x1 - x0, z1 - z0]} /><meshBasicMaterial color="#7f1d1d" transparent opacity={0.18} /></mesh>
            <lineSegments position={[0, 0.02, 0]}>
              <edgesGeometry args={[new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2)]} />
              <lineBasicMaterial color="#ef4444" />
            </lineSegments>
          </group>
        );
      })}

      {site.walkways.filter(onFloor).map((w) => {
        const xs = w.polygon.map((p) => p[0]), zs = w.polygon.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
        return (
          <group key={w.id}>
          <mesh position={[(x0 + x1) / 2, 0.004, (z0 + z1) / 2]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[x1 - x0, z1 - z0]} />
            <meshStandardMaterial color={w.surface === "grated" ? "#334155" : "#facc15"} transparent opacity={w.surface === "grated" ? 0.72 : 0.06} metalness={w.surface === "grated" ? 0.65 : 0} roughness={0.65} />
          </mesh>
          {w.surface === "grated" && Array.from({ length: Math.max(2, Math.floor((x1 - x0) / 1.5)) }, (_, i) => (
            <mesh key={`gx${i}`} position={[x0 + 0.75 + i * 1.5, 0.012, (z0 + z1) / 2]} rotation-x={-Math.PI / 2}><planeGeometry args={[0.07, z1 - z0]} /><meshBasicMaterial color="#0f172a" transparent opacity={0.7} /></mesh>
          ))}
          {w.surface === "grated" && Array.from({ length: Math.max(2, Math.floor((z1 - z0) / 1.5)) }, (_, i) => (
            <mesh key={`gz${i}`} position={[(x0 + x1) / 2, 0.013, z0 + 0.75 + i * 1.5]} rotation-x={-Math.PI / 2}><planeGeometry args={[x1 - x0, 0.07]} /><meshBasicMaterial color="#0f172a" transparent opacity={0.7} /></mesh>
          ))}
          </group>
        );
      })}

      {!lite && floor === 1 && site.spec.sensors.map((s) => (
        <mesh key={s.id} position={s.position}>
          <sphereGeometry args={[0.18, 12, 12]} />
          <meshBasicMaterial color="#22d3ee" />
        </mesh>
      ))}

      {/* Capability gaps — unknown fixture kinds degrade to labeled proxies, never blank screens */}
      {!lite && site.unknown.filter(onFloor).map((f) => <PlaceholderFixture key={f.id} f={f} />)}
      <OffshoreFixtures floor={floor} lite={lite} />
    </group>
  );
}
