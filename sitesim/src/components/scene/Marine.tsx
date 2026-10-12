import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { spec, useStore } from "../../state/store";

const W = spec.site.size.width, D = spec.site.size.depth;
const WATER_Y = spec.theme.water_level ?? -4;
const SEABED_Y = WATER_Y - 22;

/** Animated sea surface: vertex-displaced plane with gentle crossing swells */
function Sea() {
  const ref = useRef<THREE.Mesh>(null!);
  const geom = useMemo(() => new THREE.PlaneGeometry(W * 5, D * 5, 96, 96), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, Math.sin(x * 0.06 + t * 0.9) * 0.45 + Math.cos(y * 0.05 + t * 0.6) * 0.35 + Math.sin((x + y) * 0.025 + t * 0.4) * 0.25);
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
  });
  return (
    <mesh ref={ref} geometry={geom} position={[W / 2, WATER_Y, D / 2]} rotation-x={-Math.PI / 2}>
      <meshStandardMaterial color="#0c4a6e" metalness={0.35} roughness={0.25} transparent opacity={0.86} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Deterministic undulating seabed (sand-colored, sin-noise displaced) */
function Seabed() {
  const geom = useMemo(() => {
    const g = new THREE.PlaneGeometry(W * 5, D * 5, 48, 48);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, Math.sin(x * 0.045) * 1.4 + Math.cos(y * 0.06) * 1.1 + Math.sin((x - y) * 0.02) * 1.8);
    }
    g.computeVertexNormals();
    return g;
  }, []);
  return (
    <mesh geometry={geom} position={[W / 2, SEABED_Y, D / 2]} rotation-x={-Math.PI / 2}>
      <meshStandardMaterial color="#7a6a4f" roughness={0.95} metalness={0.05} />
    </mesh>
  );
}

/** Steel jacket: corner legs from deck underside to the seabed with X-bracing */
function Jacket() {
  const legs: Array<[number, number]> = [[6, 6], [W - 6, 6], [6, D - 6], [W - 6, D - 6]];
  const H = -SEABED_Y, midY = SEABED_Y / 2;
  return (
    <group>
      {legs.map(([x, z], i) => (
        <mesh key={i} position={[x, midY, z]} castShadow>
          <cylinderGeometry args={[1.1, 1.5, H, 10]} />
          <meshStandardMaterial color="#57534e" metalness={0.6} roughness={0.55} />
        </mesh>
      ))}
      {/* X-bracing between adjacent legs at two levels */}
      {[[0, 1], [0, 2], [1, 3], [2, 3]].map(([a, b]) =>
        [WATER_Y - 4, WATER_Y - 13].map((y, j) => {
          const [ax, az] = legs[a], [bx, bz] = legs[b];
          const len = Math.hypot(bx - ax, bz - az);
          const ang = Math.atan2(bz - az, bx - ax);
          return (
            <group key={`${a}-${b}-${j}`} position={[(ax + bx) / 2, y, (az + bz) / 2]} rotation-y={-ang}>
              <mesh rotation-z={0.35}><cylinderGeometry args={[0.35, 0.35, len * 1.02, 8]} /><meshStandardMaterial color="#44403c" metalness={0.6} roughness={0.55} /></mesh>
              <mesh rotation-z={-0.35}><cylinderGeometry args={[0.35, 0.35, len * 1.02, 8]} /><meshStandardMaterial color="#44403c" metalness={0.6} roughness={0.55} /></mesh>
            </group>
          );
        }),
      )}
    </group>
  );
}

/** Rain streaks shown while a High Wind alert is active */
function Rain() {
  const ref = useRef<THREE.Points>(null!);
  const N = 900;
  const { geom, speeds } = useMemo(() => {
    const positions = new Float32Array(N * 3);
    const speeds = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // Deterministic scatter (visual only — never feeds the sim)
      const h1 = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(i * 78.233) * 12543.2971) % 1;
      const h3 = Math.abs(Math.sin(i * 39.425) * 26711.9312) % 1;
      positions[i * 3] = h1 * W * 1.4 - W * 0.2;
      positions[i * 3 + 1] = h2 * 55;
      positions[i * 3 + 2] = h3 * D * 1.4 - D * 0.2;
      speeds[i] = 18 + h1 * 14;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return { geom, speeds };
  }, []);
  useFrame((_, dt) => {
    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < N; i++) {
      let y = pos.getY(i) - speeds[i] * dt;
      if (y < WATER_Y) y = 55;
      pos.setY(i, y);
      pos.setX(i, pos.getX(i) + 6 * dt); // wind-driven slant
    }
    pos.needsUpdate = true;
  });
  return (
    <points ref={ref} geometry={geom}>
      <pointsMaterial color="#93c5fd" size={0.18} transparent opacity={0.55} sizeAttenuation />
    </points>
  );
}

/** Marine environment wrapper: sea, seabed, jacket legs, and weather driven by active alerts */
export function Marine({ lite = false }: { lite?: boolean }) {
  const alerts = useStore((s) => s.twin.alerts);
  if (!spec.theme.marine) return null;
  const windActive = !!alerts["wind"] && alerts["wind"].resolved_tick === null;
  return (
    <group>
      <Sea />
      {!lite && <Seabed />}
      {!lite && <Jacket />}
      {!lite && windActive && <Rain />}
    </group>
  );
}
