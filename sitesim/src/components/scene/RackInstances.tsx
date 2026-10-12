import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { site } from "../../state/store";
import { mulberry32 } from "../../engine/rng";
import type { RackFixture } from "../../spec/types";

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/** Parametric storage models the library knows. Anything else falls back to "pallet". */
const MODELS: Record<string, { post: string; beam: string; palette: string[]; fill: number }> = {
  pallet: { post: "#2f3a4a", beam: "#e07a1f", palette: ["#b8834a", "#c99a63", "#a87440", "#d2a874", "#9c6b3c"], fill: 0.72 },
  gondola: { post: "#3a4354", beam: "#94a3b8", palette: ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#f97316", "#e2e8f0"], fill: 0.85 },
  cold_case: { post: "#c7d4e0", beam: "#dce6f0", palette: ["#bfdbfe", "#a7f3d0", "#e0f2fe", "#fef9c3"], fill: 0.8 },
};

/**
 * Every storage fixture in the site, three instanced draw calls per model:
 * posts, beams/shelves, and seed-stable random cargo fill.
 */
export function RackInstances({ castShadow = true, floor = 1, yOffset = 0 }: { castShadow?: boolean; floor?: number; yOffset?: number }) {
  const groups = useMemo(() => {
    const byModel = new Map<string, RackFixture[]>();
    for (const r of site.racks) {
      if ((r.floor ?? 1) !== floor) continue;
      const m = r.model && MODELS[r.model] ? r.model : "pallet";
      (byModel.get(m) ?? byModel.set(m, []).get(m)!).push(r);
    }
    return [...byModel.entries()];
  }, [floor]);
  return (
    <group position-y={yOffset}>
      {groups.map(([model, racks]) => <RackModelInstances key={model} model={model} racks={racks} castShadow={castShadow} />)}
    </group>
  );
}

function RackModelInstances({ model, racks, castShadow }: { model: string; racks: RackFixture[]; castShadow: boolean }) {
  const postRef = useRef<THREE.InstancedMesh>(null!);
  const beamRef = useRef<THREE.InstancedMesh>(null!);
  const boxRef = useRef<THREE.InstancedMesh>(null!);
  const M = MODELS[model];

  const data = useMemo(() => {
    const rnd = mulberry32(1234);
    const posts: THREE.Matrix4[] = [], beams: THREE.Matrix4[] = [];
    const boxes: { m: THREE.Matrix4; c: string }[] = [];
    for (const r of racks) {
      const [x, , z] = r.position; const [w, h, d] = r.size;
      const levelH = h / r.levels;
      const postW = model === "gondola" ? 0.07 : 0.1;
      for (const [dx, dz] of [[0, 0], [w, 0], [0, d], [w, d]]) {
        dummy.position.set(x + dx, h / 2, z + dz); dummy.scale.set(postW, h, postW); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
        posts.push(dummy.matrix.clone());
      }
      for (let l = 0; l < r.levels; l++) {
        const y = l * levelH + 0.05;
        for (const dz of [0.02, d - 0.02]) {
          dummy.position.set(x + w / 2, y, z + dz); dummy.scale.set(w, 0.1, 0.08); dummy.updateMatrix(); beams.push(dummy.matrix.clone());
        }
        dummy.position.set(x + w / 2, y - 0.02, z + d / 2); dummy.scale.set(w, 0.04, d); dummy.updateMatrix(); beams.push(dummy.matrix.clone());
        // Cargo: 2 slots per level, seed-stable fill and slightly random size
        const slotW = w / 2;
        for (let s = 0; s < 2; s++) {
          if (rnd() > M.fill) continue;
          const bw = slotW * (0.7 + rnd() * 0.2), bh = Math.min(levelH - 0.25, 0.5 + rnd() * levelH * 0.55), bd = d - 0.2;
          dummy.position.set(x + slotW / 2 + s * slotW, y + bh / 2 + 0.03, z + d / 2);
          dummy.scale.set(bw, bh, bd); dummy.rotation.set(0, (rnd() - 0.5) * 0.08, 0); dummy.updateMatrix();
          boxes.push({ m: dummy.matrix.clone(), c: M.palette[Math.floor(rnd() * M.palette.length)] });
        }
      }
    }
    return { posts, beams, boxes };
  }, [racks, model, M]);

  useLayoutEffect(() => {
    data.posts.forEach((m, i) => postRef.current.setMatrixAt(i, m));
    data.beams.forEach((m, i) => beamRef.current.setMatrixAt(i, m));
    data.boxes.forEach((b, i) => { boxRef.current.setMatrixAt(i, b.m); boxRef.current.setColorAt(i, color.set(b.c)); });
    postRef.current.instanceMatrix.needsUpdate = true;
    beamRef.current.instanceMatrix.needsUpdate = true;
    boxRef.current.instanceMatrix.needsUpdate = true;
    if (boxRef.current.instanceColor) boxRef.current.instanceColor.needsUpdate = true;
    [postRef, beamRef, boxRef].forEach((r) => r.current.computeBoundingSphere());
  }, [data]);

  return (
    <group>
      <instancedMesh ref={postRef} args={[undefined, undefined, data.posts.length]} castShadow={castShadow} receiveShadow frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial color={M.post} roughness={0.6} metalness={0.6} />
      </instancedMesh>
      <instancedMesh ref={beamRef} args={[undefined, undefined, data.beams.length]} frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial color={M.beam} roughness={0.5} metalness={0.5} />
      </instancedMesh>
      <instancedMesh ref={boxRef} args={[undefined, undefined, data.boxes.length]} castShadow={castShadow} receiveShadow frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial roughness={0.9} metalness={0} />
      </instancedMesh>
    </group>
  );
}
