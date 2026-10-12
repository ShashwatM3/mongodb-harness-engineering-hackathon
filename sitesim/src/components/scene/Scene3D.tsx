import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer, Bloom, N8AO, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { spec, useStore } from "../../state/store";
import { SiteShell } from "./SiteShell";
import { RackInstances } from "./RackInstances";
import { Fixtures } from "./Fixtures";
import { ZoneOverlay } from "./ZoneOverlay";
import { Robots } from "./Robots";
import { CameraGizmos } from "./Cameras";
import { People } from "./People";
import { Mezzanines, FLOOR_ELEV } from "./Mezzanine";
import { Marine } from "./Marine";

const W = spec.site.size.width, D = spec.site.size.depth;

/** Smoothly retarget the OrbitControls when focusTarget changes */
function CameraRig({ controls }: { controls: React.RefObject<OrbitControlsImpl> }) {
  const focusTarget = useStore((s) => s.focusTarget);
  const focus = useStore((s) => s.focus);
  const selected = useStore((s) => s.selectedRobot);
  const robots = useStore((s) => s.twin.robots);
  const goal = useRef<THREE.Vector3 | null>(null);
  const camGoal = useRef<THREE.Vector3 | null>(null);
  const prevSel = useRef(selected);
  useEffect(() => {
    if (focusTarget) { goal.current = new THREE.Vector3(...focusTarget); camGoal.current = new THREE.Vector3(focusTarget[0], 28, focusTarget[2] + 26); }
  }, [focusTarget]);
  useEffect(() => {
    if (selected && selected !== prevSel.current) {
      const r = robots[selected];
      if (r) { const ey = r.flight ? r.position[1] : FLOOR_ELEV[r.floor] ?? 0;
        goal.current = new THREE.Vector3(r.position[0], ey + 0.5, r.position[2]);
        camGoal.current = new THREE.Vector3(r.position[0] + 16, ey + 11, r.position[2] + 2.5); }
    }
    prevSel.current = selected;
  }, [selected, robots]);
  useFrame(({ camera }, dt) => {
    const c = controls.current; if (!c || !goal.current) return;
    const k = 1 - Math.pow(0.001, dt);
    c.target.lerp(goal.current, k);
    if (camGoal.current) camera.position.lerp(camGoal.current, k);
    c.update();
    if (c.target.distanceTo(goal.current) < 0.05) { goal.current = null; camGoal.current = null; focus(null); }
  });
  return null;
}

/** Time-of-day lighting presets (visual only; the sim clock is independent) */
const TOD = {
  day: { amb: 0.35, ambC: "#b9c6e0", hemi: 0.45, hemiSky: "#9db4e0", sun: 1.6, sunC: "#e8eefc", sunPos: [W * 0.3, 60, D * 0.2] as [number, number, number] },
  dusk: { amb: 0.22, ambC: "#e8b48a", hemi: 0.3, hemiSky: "#f0a868", sun: 0.9, sunC: "#fb923c", sunPos: [-W * 0.4, 18, D * 0.6] as [number, number, number] },
  night: { amb: 0.1, ambC: "#42506e", hemi: 0.14, hemiSky: "#334155", sun: 0.28, sunC: "#93a8d4", sunPos: [W * 0.2, 45, -D * 0.3] as [number, number, number] },
};

function Lights({ quality }: { quality: string }) {
  const shadows = quality !== "low";
  const tod = useStore((s) => s.timeOfDay);
  const t = TOD[tod];
  return (
    <>
      <ambientLight intensity={t.amb} color={t.ambC} />
      <hemisphereLight args={[t.hemiSky, "#1a2233", t.hemi]} />
      <directionalLight
        position={t.sunPos} intensity={t.sun} color={t.sunC} castShadow={shadows}
        shadow-mapSize={quality === "high" ? [4096, 4096] : [2048, 2048]} shadow-bias={-0.0004}
        shadow-camera-left={-W * 0.7} shadow-camera-right={W * 0.7} shadow-camera-top={D * 0.7} shadow-camera-bottom={-D * 0.7} shadow-camera-near={10} shadow-camera-far={160}
      />
      {spec.theme.accent_lights.map(([x, y, z, color], i) => (
        <pointLight key={i} position={[x, y, z]} intensity={(i === 0 ? 0.6 : 1.2) * (tod === "night" ? 2 : tod === "dusk" ? 1.4 : 1)} color={color} distance={i === 0 ? 80 : 25} decay={i === 0 ? 1 : 1.5} />
      ))}
    </>
  );
}

function FpsCounter({ onFps }: { onFps: (v: number) => void }) {
  const acc = useRef({ t: 0, n: 0 });
  useFrame((_, dt) => { acc.current.t += dt; acc.current.n++; if (acc.current.t >= 0.5) { onFps(Math.round(acc.current.n / acc.current.t)); acc.current = { t: 0, n: 0 }; } });
  return null;
}

/** Background, fog, procedural environment map (RoomEnvironment — no HDR download, offline-friendly) */
const TOD_BG: Record<string, string | null> = { day: null, dusk: "#2a1f33", night: "#0a0f1e" };

function Background({ env = true }: { env?: boolean }) {
  const { scene, gl } = useThree();
  const tod = useStore((s) => s.timeOfDay);
  const fogAlert = useStore((s) => { const a = s.twin.alerts["fog"]; return !!a && a.resolved_tick === null; });
  useEffect(() => {
    const bg = TOD_BG[tod] ?? spec.theme.bg;
    scene.background = new THREE.Color(bg);
    scene.fog = fogAlert ? new THREE.Fog(bg, 25, 95) : new THREE.Fog(bg, 120, 260);
  }, [scene, tod, fogAlert]);
  useEffect(() => {
    if (!env) return;
    const pmrem = new THREE.PMREMGenerator(gl);
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = tex; scene.environmentIntensity = 0.35;
    return () => { scene.environment = null; tex.dispose(); pmrem.dispose(); };
  }, [scene, gl, env]);
  return null;
}

export function SceneContent({ quality, lite = false }: { quality: "low" | "medium" | "high"; lite?: boolean }) {
  const af = useStore((s) => s.activeFloor);
  const activeFloor = lite ? "all" : af;
  const upperFloors = spec.floors.filter((f) => f.id !== 1);
  return (
    <>
      <Background env={!lite} />
      <Lights quality={lite ? "low" : quality} />
      <group visible={activeFloor === "all" || activeFloor === "exploded" || activeFloor === 1}>
        <SiteShell lite={lite} />
        <RackInstances castShadow={!lite && quality !== "low"} floor={1} />
        <Fixtures lite={lite} floor={1} />
      </group>
      {upperFloors.map((f) => (
        <group key={f.id} visible={activeFloor === "all" || activeFloor === "exploded" || activeFloor === f.id} position-y={activeFloor === "exploded" ? 5 : 0}>
          <RackInstances castShadow={false} floor={f.id} yOffset={f.elevation} />
          <Fixtures lite={lite} floor={f.id} />
        </group>
      ))}
      {upperFloors.length > 0 && (
        <group visible={activeFloor === "all" || activeFloor === "exploded" || activeFloor !== 1} position-y={activeFloor === "exploded" ? 5 : 0}>
          <Mezzanines lite={lite} />
        </group>
      )}
      <Marine lite={lite} />
      <ZoneOverlay labels={!lite} />
      <People lite={lite} />
      <Robots lite={lite} />
      {!lite && <CameraGizmos />}
      {!lite && quality === "high" && <ContactShadows position={[W / 2, 0.01, D / 2]} scale={[W, D]} blur={2} opacity={0.5} far={4} />}
    </>
  );
}

export function Scene3D() {
  const quality = useStore((s) => s.quality);
  const tool = useStore((s) => s.tool);
  const select = useStore((s) => s.select);
  const controls = useRef<OrbitControlsImpl>(null!);
  const [fps, setFps] = useState(0);
  return (
    <>
      <Canvas
        resize={{ offsetSize: true }}
        shadows={quality !== "low"}
        dpr={quality === "high" ? [1, 2] : quality === "medium" ? [1, 1.5] : 1}
        gl={{ antialias: quality !== "low", powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.15 }}
        camera={{ position: [W / 2 + 4, 58, D + 50], fov: 36, near: 0.5, far: 400 }}
        onPointerMissed={() => tool === "select" && select(null)}
      >
        <SceneContent quality={quality} />
        <OrbitControls ref={controls} target={[W / 2, 0, D / 2 - 2]} maxPolarAngle={Math.PI / 2.15} minDistance={8} maxDistance={200} enableDamping dampingFactor={0.08} enablePan mouseButtons={tool === "pan" ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />
        <CameraRig controls={controls} />
        <FpsCounter onFps={setFps} />
        {quality === "high" && (
          <EffectComposer multisampling={4}>
            <N8AO aoRadius={2} intensity={1.2} distanceFalloff={1} />
            <Bloom luminanceThreshold={0.85} intensity={0.55} mipmapBlur />
            <Vignette eskil={false} offset={0.2} darkness={0.55} />
          </EffectComposer>
        )}
        {quality === "medium" && (
          <EffectComposer multisampling={0}>
            <Bloom luminanceThreshold={0.9} intensity={0.4} mipmapBlur />
          </EffectComposer>
        )}
      </Canvas>
      <div className="fps">{fps} FPS · {quality.toUpperCase()}</div>
    </>
  );
}
