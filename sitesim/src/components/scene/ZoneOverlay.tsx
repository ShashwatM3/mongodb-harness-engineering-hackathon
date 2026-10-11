import { Html, Line } from "@react-three/drei";
import { spec, site, useStore } from "../../state/store";
import { dockInbound } from "./SiteShell";
import { FLOOR_ELEV } from "./Mezzanine";

/** Neon zone borders + floating labels; BLOCKED red, CONGESTED orange */
export function ZoneOverlay({ labels = true }: { labels?: boolean }) {
  const zones = useStore((s) => s.twin.zones);
  const focus = useStore((s) => s.focus);
  const af = useStore((s) => s.activeFloor);
  const activeFloor = !labels || af === "exploded" ? "all" : af;
  const { width: W, depth: D } = spec.site.size;
  return (
    <group>
      {spec.zones.filter((z) => activeFloor === "all" || (z.floor ?? 1) === activeFloor).map((z) => {
        const st = zones[z.id]?.status ?? "NORMAL";
        const color = st === "BLOCKED" ? "#ef4444" : st === "CONGESTED" ? "#f97316" : z.color;
        const ey = (FLOOR_ELEV[z.floor ?? 1] ?? 0) + (labels && af === "exploded" && (z.floor ?? 1) !== 1 ? 5 : 0);
        const pts = [...z.polygon, z.polygon[0]].map(([x, zz]) => [x, ey + 0.03, zz] as [number, number, number]);
        const xs = z.polygon.map((p) => p[0]), zs = z.polygon.map((p) => p[1]);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
        const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...zs) - Math.min(...zs);
        // Label just inside the zone's inner-facing edge, clamped away from the site boundary so it never clips the view
        const inset = 7;
        const lx = Math.min(W - inset, Math.max(inset, cx < W / 2 ? Math.min(...xs) + inset : Math.max(...xs) - inset));
        const lz = Math.min(D - 3, Math.max(3, cz < D / 2 ? Math.min(...zs) + 2.5 : Math.max(...zs) - 2.5));
        const floor = z.floor ?? 1;
        return (
          <group key={z.id}>
            <Line points={pts} color={color} lineWidth={1.6} transparent opacity={0.9} />
            {st !== "NORMAL" && (
              <mesh position={[cx, ey + 0.02, cz]} rotation-x={-Math.PI / 2}>
                <planeGeometry args={[w, d]} />
                <meshBasicMaterial color={color} transparent opacity={0.08} />
              </mesh>
            )}
            {labels && (
              <Html position={[lx, ey + 1.2, lz]} zIndexRange={[30, 20]}>
                <div className="zone-lbl" style={{ color, borderColor: color }} onClick={() => focus([cx, ey, cz])}>
                  {`${z.name.toUpperCase()} — F${floor}${z.ex_zone !== undefined ? ` · EX ${z.ex_zone === "safe" ? "SAFE" : `ZONE ${z.ex_zone}`}` : ""}`}{st === "CONGESTED" ? " ⚠" : st === "BLOCKED" ? " ⛔" : ""}
                </div>
              </Html>
            )}
          </group>
        );
      })}
      {/* One sign per dock kind */}
      {labels && [...new Set(site.docks.map((d) => d.dock_kind))].map((kind) => {
        const d = site.docks.find((x) => x.dock_kind === kind)!;
        const north = d.door[1] < D / 2;
        const inb = dockInbound(kind);
        return (
          <Html key={kind} position={[(d.rect[0] + d.rect[2]) / 2 + 6, 6.2, north ? 1 : D - 1]} zIndexRange={[30, 20]} style={{ pointerEvents: "none" }}>
            <div className="sign-lbl" style={{ color: inb ? "#86efac" : "#67e8f9", borderColor: inb ? "#15803d" : "#0e7490" }}>{kind}</div>
          </Html>
        );
      })}
    </group>
  );
}
