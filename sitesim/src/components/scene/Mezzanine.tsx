/**
 * Upper floors + freight lifts — industrial mezzanine renderer.
 *  - 45 cm slab, steel primary/secondary beams, spec-driven column positions
 *    (the ground-floor nav grid blocks the same data — visuals and paths never drift),
 *    yellow/black edge marking, double-rail guardrails + toe boards, shaft openings.
 *  - Lifts: steel shaft + mesh guard + solid platform + sliding doors + status
 *    lights. Platform height reads the engine-authoritative state.lifts[id].y;
 *    this component only interpolates.
 */
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { spec, site, useStore } from "../../state/store";
import type { SpecFloor, SpecLift } from "../../spec/types";
import type { LiftState } from "../../schema/twin_state";

export const FLOOR_ELEV: Record<number, number> = site.floorElev;

/** Shaft geometry (single source of truth) — the engine's gate constants must match */
export const LIFT_SHAFT = { W: 2.8, D: 3.6, LEAF: 1.12 };

const SLAB_T = 0.45;
const SHAFT_HALF = 1.9;

export function Mezzanines({ lite = false }: { lite?: boolean }) {
  return (
    <>
      {spec.floors.filter((f) => f.id !== 1 && f.footprint).map((f) => <MezzanineFloor key={f.id} f={f} lite={lite} />)}
    </>
  );
}

function MezzanineFloor({ f, lite }: { f: SpecFloor; lite: boolean }) {
  const xs = f.footprint!.map((p) => p[0]), zs = f.footprint!.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const w = x1 - x0, d = z1 - z0, y = f.elevation;
  const steel = <meshStandardMaterial color="#39404f" roughness={0.55} metalness={0.6} />;

  // Slab leaves openings for the lift shafts on the edge strip they sit in.
  const lifts = spec.lifts.filter((l) => l.floors.includes(f.id));
  const shaftZs = lifts.map((l) => l.cell[1] + 0.5).sort((a, b) => a - b);
  const stripX = x1 - 4;
  const strips: Array<[number, number]> = [];
  let cur = z0;
  for (const sz of shaftZs) { if (sz - SHAFT_HALF > cur) strips.push([cur, sz - SHAFT_HALF]); cur = sz + SHAFT_HALF; }
  if (cur < z1) strips.push([cur, z1]);

  const columns = site.columns.map((c) => c.position);

  return (
    <group>
      {/* Main slab (west of the shaft strip) */}
      <mesh position={[x0 + (stripX - x0) / 2, y - SLAB_T / 2, z0 + d / 2]} receiveShadow>
        <boxGeometry args={[stripX - x0, SLAB_T, d]} />
        <meshStandardMaterial color="#242d3f" roughness={0.9} metalness={0.1} />
      </mesh>
      {/* East strip segments between shafts */}
      {strips.map(([za, zb], i) => (
        <mesh key={i} position={[stripX + (x1 - stripX) / 2, y - SLAB_T / 2, (za + zb) / 2]} receiveShadow>
          <boxGeometry args={[x1 - stripX, SLAB_T, zb - za]} />
          <meshStandardMaterial color="#242d3f" roughness={0.9} metalness={0.1} />
        </mesh>
      ))}
      {/* Primary beams (x direction, under the slab) */}
      {[z0 + 2, z0 + d / 2, z1 - 2].map((z, i) => (
        <mesh key={"mb" + i} position={[x0 + w / 2, y - SLAB_T - 0.3, z]}>
          <boxGeometry args={[w, 0.6, 0.35]} />{steel}
        </mesh>
      ))}
      {/* Secondary beams (z direction) */}
      {Array.from({ length: Math.floor(w / 6) }, (_, i) => x0 + 3 + i * 6).map((x, i) => (
        <mesh key={"sb" + i} position={[x, y - SLAB_T - 0.22, z0 + d / 2]}>
          <boxGeometry args={[0.22, 0.45, d - 0.5]} />{steel}
        </mesh>
      ))}
      {/* Support columns (spec-driven) */}
      {columns.map(([x, z], i) => (
        <group key={"col" + i} position={[x, 0, z]}>
          <mesh position={[0, (y - SLAB_T) / 2, 0]} castShadow={!lite}>
            <boxGeometry args={[0.5, y - SLAB_T, 0.5]} />
            <meshStandardMaterial color="#2b3446" roughness={0.6} metalness={0.4} />
          </mesh>
          <mesh position={[0, 0.06, 0]}><boxGeometry args={[0.9, 0.12, 0.9]} />{steel}</mesh>
        </group>
      ))}
      {/* Edges: yellow/black marking + double-rail guardrail + toe board (no rail across shaft openings) */}
      {([[x0 + w / 2, z0, w, 0, true], [x0 + w / 2, z1, w, 0, true], [x0, z0 + d / 2, d, 1, true]] as const).map(([cx, cz, len, rot, rail], i) => (
        <Edge key={i} cx={cx} cz={cz} len={len} rot={rot} y={y} rail={rail} />
      ))}
      {strips.map(([za, zb], i) => <Edge key={"e" + i} cx={x1} cz={(za + zb) / 2} len={zb - za} rot={1} y={y} rail />)}
      {!lite && <pointLight position={[x0 + w / 3, y + 5, z0 + d / 2]} intensity={0.7} color="#cfe0ff" distance={30} decay={1.5} />}
      {!lite && <pointLight position={[x0 + w / 2, y - 2.5, z0 + d / 2]} intensity={0.5} color="#93a6c9" distance={24} decay={1.5} />}
      {lifts.map((l) => <Lift key={l.id} l={l} elev={y} lite={lite} />)}
    </group>
  );
}

function Edge({ cx, cz, len, rot, y, rail }: { cx: number; cz: number; len: number; rot: 0 | 1; y: number; rail: boolean }) {
  return (
    <group position={[cx, y, cz]} rotation-y={rot ? Math.PI / 2 : 0}>
      <mesh position={[0, 0.02, 0]}><boxGeometry args={[len, 0.05, 0.3]} /><meshBasicMaterial color="#eab308" /></mesh>
      {rail && (
        <>
          <mesh position={[0, 0.1, 0]}><boxGeometry args={[len, 0.14, 0.04]} /><meshStandardMaterial color="#b45309" roughness={0.7} /></mesh>
          <mesh position={[0, 0.6, 0]}><boxGeometry args={[len, 0.05, 0.05]} /><meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.4} /></mesh>
          <mesh position={[0, 1.1, 0]}><boxGeometry args={[len, 0.07, 0.07]} /><meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.4} /></mesh>
          {Array.from({ length: Math.max(2, Math.floor(len / 3)) }, (_, k) => (
            <mesh key={k} position={[-len / 2 + 0.5 + k * ((len - 1) / Math.max(1, Math.floor(len / 3) - 1)), 0.55, 0]}>
              <boxGeometry args={[0.06, 1.1, 0.06]} /><meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.4} />
            </mesh>
          ))}
        </>
      )}
    </group>
  );
}

export const LIFT_LIGHT: Record<string, string> = {
  IDLE: "#22c55e", COOLDOWN: "#22c55e",
  MOVING_UP: "#3b82f6", MOVING_DOWN: "#3b82f6", LEVELING: "#3b82f6",
  DOOR_OPENING: "#22d3ee", DOOR_OPENING_AT_DESTINATION: "#22d3ee", BOARDING: "#22d3ee", ALIGHTING: "#22d3ee",
  DOOR_CLOSING: "#f59e0b", DOOR_CLOSING_AFTER_EXIT: "#f59e0b",
  FAULT: "#ef4444",
};

export function liftLabel(L: LiftState | undefined): string {
  if (!L) return "";
  if (L.fault) return "FAULT";
  if (L.state === "MOVING_UP" || L.state === "MOVING_DOWN") return `→ F${L.target_floor} · ${L.occupant ?? "empty"}`;
  const q = Object.values(L.queue).reduce((a, x) => a + x.length, 0);
  if (L.state === "IDLE") return `IDLE AT F${L.floor}${q ? ` · QUEUE ${q}` : ""}`;
  return `${L.state.replace(/_/g, " ")}${L.occupant ? ` · ${L.occupant}` : ""}`;
}

/** Freight lift: VRC-style steel carriage, dual guide rails, overhead drive box,
 *  full-height mesh guard, interlocked double doors per floor, anti-slip deck. */
function Lift({ l, elev, lite }: { l: SpecLift; elev: number; lite: boolean }) {
  const platRef = useRef<THREE.Group>(null!);
  const leafRefs = useRef<Record<string, [THREE.Mesh | null, THREE.Mesh | null]>>({});
  const lightRef = useRef<THREE.MeshBasicMaterial>(null!);
  const levelRefs = useRef<Record<string, THREE.MeshBasicMaterial | null>>({});
  const occRef = useRef<THREE.Mesh>(null!);
  const selectLift = useStore((s) => s.selectLift);
  const x = l.cell[0] + 0.5, z = l.cell[1] + 0.5;
  const W = LIFT_SHAFT.W, D = LIFT_SHAFT.D, H = elev + 2.4;
  const LEAF = LIFT_SHAFT.LEAF;
  const steel = <meshStandardMaterial color="#2f3542" roughness={0.5} metalness={0.7} />;
  const frame = <meshStandardMaterial color="#171c26" roughness={0.45} metalness={0.75} />;

  useFrame((state, dt) => {
    const L = useStore.getState().twin.lifts[l.id];
    if (!L) return;
    const k = 1 - Math.pow(0.02, dt);
    if (platRef.current) platRef.current.position.y += (L.y - platRef.current.position.y) * k;
    for (const fid of Object.keys(leafRefs.current)) {
      const open = L.doors[fid] === "OPEN";
      const pair = leafRefs.current[fid];
      pair.forEach((m, i) => {
        if (!m) return;
        const sign = i === 0 ? -1 : 1;
        const base = sign * LEAF / 2;
        m.position.z += ((open ? base + sign * LEAF : base) - m.position.z) * k;
      });
    }
    if (lightRef.current) {
      const c = L.fault ? "#ef4444" : LIFT_LIGHT[L.state] ?? "#22c55e";
      lightRef.current.color.set(c);
      lightRef.current.opacity = L.fault ? 0.5 + Math.sin(state.clock.elapsedTime * 8) * 0.5 : 1;
    }
    for (const fid of Object.keys(levelRefs.current)) {
      const m = levelRefs.current[fid]; if (!m) continue;
      m.color.set(Math.abs(L.y - (FLOOR_ELEV[Number(fid)] ?? 0)) < 0.05 ? "#22c55e" : "#334155");
    }
    if (occRef.current) occRef.current.visible = !!L.occupant;
  });

  const L = useStore((s) => s.twin.lifts[l.id]);
  return (
    <group position={[x, 0, z]} onClick={(e) => { e.stopPropagation(); selectLift(l.id); }}
      onPointerOver={() => (document.body.style.cursor = "pointer")} onPointerOut={() => (document.body.style.cursor = "")}>
      {/* Shaft frame + corner posts */}
      {[[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]].map(([dx, dz], i) => (
        <mesh key={i} position={[dx, H / 2, dz]} castShadow={!lite}><boxGeometry args={[0.24, H, 0.24]} />{frame}</mesh>
      ))}
      {[0.05, elev / 2, elev, H - 0.3].map((hy, i) => (
        <group key={"h" + i}>
          <mesh position={[W / 2, hy, 0]}><boxGeometry args={[0.12, 0.12, D]} />{frame}</mesh>
          <mesh position={[0, hy, -D / 2]}><boxGeometry args={[W, 0.12, 0.12]} />{frame}</mesh>
          <mesh position={[0, hy, D / 2]}><boxGeometry args={[W, 0.12, 0.12]} />{frame}</mesh>
        </group>
      ))}
      {/* Full-height mesh guard (E/N/S; west face is the door) */}
      {([[W / 2 - 0.02, 0, Math.PI / 2, D - 0.2], [0, -D / 2 + 0.02, 0, W - 0.2], [0, D / 2 - 0.02, 0, W - 0.2]] as const).map(([dx, dz, rot, len], i) => (
        <mesh key={"mesh" + i} position={[dx, H / 2 - 0.15, dz]} rotation-y={rot}>
          <planeGeometry args={[len, H - 0.5, Math.round(len * 3), Math.round((H - 0.5) * 2)]} />
          <meshStandardMaterial color="#59a0b8" transparent opacity={0.35} side={THREE.DoubleSide} metalness={0.4} roughness={0.5} wireframe />
        </mesh>
      ))}
      {/* Service door (east face) */}
      <group position={[W / 2 - 0.01, 1.0, D / 2 - 0.9]}>
        <mesh rotation-y={Math.PI / 2}><planeGeometry args={[0.9, 1.9]} /><meshStandardMaterial color="#22303f" transparent opacity={0.85} side={THREE.DoubleSide} /></mesh>
        <mesh position={[0.02, 0, 0]} rotation-y={Math.PI / 2}><ringGeometry args={[0.05, 0.08, 8]} /><meshBasicMaterial color="#eab308" /></mesh>
      </group>
      {/* Guide rails + chain */}
      {[-W / 2 + 0.2, W / 2 - 0.2].map((dx, i) => (
        <group key={"rail" + i}>
          <mesh position={[dx, H / 2, D / 2 - 0.22]}><boxGeometry args={[0.1, H, 0.16]} /><meshStandardMaterial color="#454f61" metalness={0.85} roughness={0.25} /></mesh>
        </group>
      ))}
      <mesh position={[0, H / 2, D / 2 - 0.3]}><cylinderGeometry args={[0.03, 0.03, H - 0.6, 6]} /><meshStandardMaterial color="#0d1118" metalness={0.7} roughness={0.4} /></mesh>
      {/* Platform (anti-slip steel carriage) */}
      <group ref={platRef} position={[0, 0, 0]}>
        <mesh position={[0, 0.14, 0]} castShadow={!lite}><boxGeometry args={[W - 0.5, 0.1, D - 0.5]} /><meshStandardMaterial color="#3d4657" roughness={0.85} metalness={0.35} /></mesh>
        <mesh position={[0, 0.05, 0]}><boxGeometry args={[W - 0.7, 0.08, 0.3]} />{steel}</mesh>
        <mesh position={[0, 0.05, -1.0]}><boxGeometry args={[W - 0.7, 0.08, 0.25]} />{steel}</mesh>
        <mesh position={[0, 0.05, 1.0]}><boxGeometry args={[W - 0.7, 0.08, 0.25]} />{steel}</mesh>
        {[-1, 1].map((sx, i) => <mesh key={"ex" + i} position={[sx * (W - 0.55) / 2, 0.2, 0]}><boxGeometry args={[0.12, 0.03, D - 0.5]} /><meshBasicMaterial color="#eab308" /></mesh>)}
        {[-1, 1].map((sz, i) => <mesh key={"ez" + i} position={[0, 0.2, sz * (D - 0.55) / 2]}><boxGeometry args={[W - 0.5, 0.03, 0.12]} /><meshBasicMaterial color="#eab308" /></mesh>)}
        {[[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]].map(([mx, mz], i) => (
          <mesh key={"dm" + i} position={[mx, 0.2, mz]} rotation-x={-Math.PI / 2}><planeGeometry args={[0.3, 0.06]} /><meshBasicMaterial color="#22d3ee" transparent opacity={0.8} /></mesh>
        ))}
        <mesh ref={occRef} position={[0, 0.21, 0]} rotation-x={-Math.PI / 2} visible={false}>
          <planeGeometry args={[1.5, 1.5]} /><meshBasicMaterial color="#22d3ee" transparent opacity={0.12} />
        </mesh>
        {[-1, 1].map((sx, i) => <mesh key={"b" + i} position={[sx * (W - 0.8) / 2, 0.26, 0]}><boxGeometry args={[0.06, 0.1, D - 0.9]} /><meshStandardMaterial color="#b45309" roughness={0.6} /></mesh>)}
        {[-W / 2 + 0.2, W / 2 - 0.2].map((dx, i) => (
          <mesh key={"c" + i} position={[dx * 0.82, 0.3, D / 2 - 0.45]}><boxGeometry args={[0.35, 0.5, 0.3]} />{steel}</mesh>
        ))}
      </group>
      {/* Interlocked double doors per served floor (west face) + frame, sill, indicator stack */}
      {l.floors.map((fid, fi) => {
        const fy = FLOOR_ELEV[fid] ?? 0;
        return (
          <group key={"door" + fid} position={[-W / 2, fy, 0]}>
            <mesh position={[0, 1.15, -LEAF - 0.12]}><boxGeometry args={[0.18, 2.3, 0.14]} />{frame}</mesh>
            <mesh position={[0, 1.15, LEAF + 0.12]}><boxGeometry args={[0.18, 2.3, 0.14]} />{frame}</mesh>
            <mesh position={[0, 2.36, 0]}><boxGeometry args={[0.18, 0.16, 2.6]} />{frame}</mesh>
            <mesh position={[-0.15, 0.015, 0]}><boxGeometry args={[0.5, 0.03, 2.3]} /><meshStandardMaterial color="#556174" metalness={0.7} roughness={0.35} /></mesh>
            <mesh position={[-0.85, fy === 0 ? 0.015 : 0.02, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.1, 2.4]} /><meshBasicMaterial color="#eab308" transparent opacity={0.18} /></mesh>
            <group position={[0, 0, -LEAF - 0.35]}>
              <mesh position={[0, 1.2, 0]}><boxGeometry args={[0.12, 0.9, 0.18]} /><meshStandardMaterial color="#1c232f" roughness={0.5} /></mesh>
              <mesh position={[-0.02, 1.5, 0]}><boxGeometry args={[0.1, 0.12, 0.12]} /><meshBasicMaterial ref={(m) => { levelRefs.current[String(fid)] = m; }} color="#334155" /></mesh>
              <mesh position={[-0.02, 1.3, 0]}><boxGeometry args={[0.1, 0.12, 0.12]} /><meshBasicMaterial ref={fi === 0 ? lightRef : undefined} color="#22c55e" transparent /></mesh>
              <mesh position={[-0.02, 1.05, 0]}><cylinderGeometry args={[0.05, 0.05, 0.05, 10]} /><meshBasicMaterial color="#dc2626" /></mesh>
            </group>
            <mesh ref={(m) => { (leafRefs.current[String(fid)] ??= [null, null])[0] = m; }} position={[0, 1.12, -LEAF / 2]}>
              <boxGeometry args={[0.07, 2.2, LEAF]} />
              <meshStandardMaterial color="#4a5364" transparent opacity={0.8} metalness={0.6} roughness={0.35} />
            </mesh>
            <mesh ref={(m) => { (leafRefs.current[String(fid)] ??= [null, null])[1] = m; }} position={[0, 1.12, LEAF / 2]}>
              <boxGeometry args={[0.07, 2.2, LEAF]} />
              <meshStandardMaterial color="#4a5364" transparent opacity={0.8} metalness={0.6} roughness={0.35} />
            </mesh>
          </group>
        );
      })}
      {/* Overhead drive box (Motor–Brake–Gearbox) */}
      <group position={[0, H + 0.35, D / 2 - 0.5]}>
        <mesh castShadow={!lite}><boxGeometry args={[1.3, 0.7, 0.9]} /><meshStandardMaterial color="#232a37" roughness={0.5} metalness={0.6} /></mesh>
        {[-0.3, 0, 0.3].map((dz, i) => <mesh key={i} position={[0.66, 0, dz * 0.9]}><boxGeometry args={[0.02, 0.4, 0.06]} /><meshBasicMaterial color="#0b0f16" /></mesh>)}
        <mesh position={[-0.55, 0.15, 0.46]}><sphereGeometry args={[0.06, 8, 8]} /><meshBasicMaterial color="#22c55e" /></mesh>
        <mesh position={[0, 0.15, 0.46]} rotation-x={0}><planeGeometry args={[0.3, 0.26]} /><meshBasicMaterial color="#eab308" /></mesh>
      </group>
      {!lite && (
        <Html position={[0, H + 1.3, 0]} zIndexRange={[9, 0]} center>
          <div className="lift-lbl" onClick={(e) => { e.stopPropagation(); selectLift(l.id); }}>
            <b>{l.id}</b><span>{liftLabel(L)}</span>
            <span className="lift-sign">AUTOMATED MATERIAL LIFT · AMR ONLY · CAP 1</span>
          </div>
        </Html>
      )}
    </group>
  );
}
