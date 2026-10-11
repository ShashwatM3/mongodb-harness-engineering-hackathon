/**
 * Failure injection drawer. Every row is available only when the active spec
 * actually contains that kind of asset — the drawer, like everything else,
 * is compiled from the spec, not hardcoded to a vertical.
 */
import { useState, useEffect } from "react";
import { useFocusTrap } from "../ui/useFocusTrap";
import { spec, site, useStore } from "../../state/store";
import { simControl } from "../../simulation/runner";
import type { ScenarioInjection } from "../../schema/twin_state";

export function ScenariosDrawer() {
  const open = useStore((s) => s.drawer === "scenarios");
  const setDrawer = useStore((s) => s.setDrawer);
  const twin = useStore((s) => s.twin);
  const defs = spec.scenarios?.defaults ?? {};
  const [robot, setRobot] = useState(defs.robot ?? spec.fleet.spawns[0]?.id ?? "");
  const [conveyor, setConveyor] = useState(defs.conveyor ?? site.conveyors[0]?.id ?? "");
  const [camera, setCamera] = useState(defs.camera ?? spec.cameras[0]?.id ?? "");
  const [lift, setLift] = useState(defs.lift ?? spec.lifts[0]?.id ?? "");
  const [zone, setZone] = useState(defs.zone ?? spec.zones[0]?.id ?? "");
  const [duration, setDuration] = useState(60);
  const [level, setLevel] = useState(0.8);
  const [wind, setWind] = useState(18);
  const [motion, setMotion] = useState(0.6);
  const [burst, setBurst] = useState(8);
  const trap = useFocusTrap<HTMLElement>(open);
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(null); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, setDrawer]);
  if (!open) return null;

  const fire = (inj: ScenarioInjection) => simControl.inject(inj);
  const robots = Object.values(twin.robots);
  const drones = robots.filter((r) => r.locomotion === "aerial");
  const compound = spec.scenarios?.compound;
  // Active injections derived from state (no extra bookkeeping)
  const active: Array<{ kind: ScenarioInjection["kind"]; target: string; label: string }> = [
    ...robots.filter((r) => r.status === "OFFLINE").map((r) => ({ kind: "ROBOT_FAILURE" as const, target: r.id, label: `${r.id} offline` })),
    ...Object.values(twin.conveyors).filter((c) => c.status === "ERROR").map((c) => ({ kind: "CONVEYOR_FAILURE" as const, target: c.id, label: `${c.id} error` })),
    ...Object.values(twin.cameras).filter((c) => c.status === "OFFLINE").map((c) => ({ kind: "CAMERA_OFFLINE" as const, target: c.id, label: `${c.id} offline` })),
    ...[...new Set(Object.values(twin.people).map((p) => p.zone).filter(Boolean))].map((z) => ({ kind: "HUMAN_INTRUSION" as const, target: z!, label: `Human in Zone ${z}` })),
    ...Object.values(twin.alerts).filter((a) => a.id.startsWith("traffic-")).map((a) => ({ kind: "TRAFFIC_CONGESTION" as const, target: a.zone_id!, label: `Traffic Zone ${a.zone_id}` })),
    ...Object.values(twin.lifts ?? {}).filter((l) => l.fault).map((l) => ({ kind: "LIFT_FAULT" as const, target: l.id, label: `${l.id} fault` })),
    ...drones.filter((r) => r.flight?.signal_lost).map((r) => ({ kind: "DRONE_SIGNAL_LOST" as const, target: r.id, label: `${r.id} signal lost` })),
    ...(twin.alerts.wind ? [{ kind: "HIGH_WIND" as const, target: "HIGH_WIND", label: "High wind" }] : []),
    ...(twin.alerts.motion ? [{ kind: "PLATFORM_MOTION" as const, target: "PLATFORM_MOTION", label: "Platform motion" }] : []),
    ...(twin.alerts.fog ? [{ kind: "FOG" as const, target: "FOG", label: "Fog" }] : []),
    ...Object.values(twin.alerts).filter((a) => a.id.startsWith("gas-")).map((a) => ({ kind: "GAS_LEAK" as const, target: a.zone_id!, label: `Gas leak Zone ${a.zone_id}` })),
    ...Object.values(twin.alerts).filter((a) => a.id.startsWith("drop-")).map((a) => ({ kind: "DROPPED_OBJECT" as const, target: a.zone_id!, label: `Dropped object Zone ${a.zone_id}` })),
    ...Object.values(twin.alerts).filter((a) => a.id.startsWith("comms-")).map((a) => ({ kind: "COMMS_BLACKOUT" as const, target: a.robot_id!, label: `${a.robot_id} comms blackout` })),
  ];

  return (
    <aside className="drawer" role="dialog" aria-label="Scenario Injection" ref={trap} tabIndex={-1}>
      <header className="drawer-h"><span>Scenario Injection</span><button className="icon-btn" aria-label="Close" onClick={() => setDrawer(null)}>✕</button></header>
      <div className="drawer-b">
        <p className="hint">Inject failures into the LIVE simulation and watch the Fleet Manager, A* planner and KPIs react.</p>

        <Row title="Robot Failure" desc="Robot goes offline; its task is re-queued to another robot">
          <select value={robot} onChange={(e) => setRobot(e.target.value)}>{robots.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.status.toLowerCase()} · {Math.round(r.battery)}%</option>)}</select>
          <button className="btn danger" onClick={() => fire({ kind: "ROBOT_FAILURE", robot_id: robot })}>Fail</button>
        </Row>
        <Row title="Low Battery" desc="Set battery to 8% — watch task hand-off and charger scheduling">
          <select value={robot} onChange={(e) => setRobot(e.target.value)}>{robots.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}</select>
          <button className="btn warn" onClick={() => fire({ kind: "ROBOT_BATTERY_SET", robot_id: robot, battery: 8 })}>Set 8%</button>
        </Row>
        {site.conveyors.length > 0 && (
          <Row title="Conveyor Failure" desc="Belt stops; unloading at the station it feeds takes 4× longer → bottleneck">
            <select value={conveyor} onChange={(e) => setConveyor(e.target.value)}>{site.conveyors.map((c) => <option key={c.id} value={c.id}>{c.name}{c.feeds ? ` → ${c.feeds}` : ""}</option>)}</select>
            <button className="btn danger" onClick={() => fire({ kind: "CONVEYOR_FAILURE", conveyor_id: conveyor })}>Stop</button>
          </Row>
        )}
        <Row title="Human Intrusion" desc="A person enters the zone → zone blocked → robots re-plan">
          <select value={zone} onChange={(e) => setZone(e.target.value)}>{spec.zones.map((z) => <option key={z.id} value={z.id}>Zone {z.id}</option>)}</select>
          <input type="number" min={10} max={600} value={duration} onChange={(e) => setDuration(+e.target.value)} title="seconds" /><span className="unit">s</span>
          <button className="btn warn" onClick={() => fire({ kind: "HUMAN_INTRUSION", zone_id: zone, duration_ticks: duration * 10 })}>Inject</button>
        </Row>
        <Row title="Traffic Congestion" desc="Speed limit + higher path cost inside the zone → dynamic re-routing">
          <select value={zone} onChange={(e) => setZone(e.target.value)}>{spec.zones.map((z) => <option key={z.id} value={z.id}>Zone {z.id}</option>)}</select>
          <input type="range" min={0.2} max={1} step={0.1} value={level} onChange={(e) => setLevel(+e.target.value)} title="level" /><span className="unit">{Math.round(level * 100)}%</span>
          <button className="btn warn" onClick={() => fire({ kind: "TRAFFIC_CONGESTION", zone_id: zone, level, duration_ticks: duration * 10 })}>Inject</button>
        </Row>
        {spec.cameras.length > 0 && (
          <Row title="Camera Failure" desc="Camera goes offline; CCTV subsystem degraded">
            <select value={camera} onChange={(e) => setCamera(e.target.value)}>{spec.cameras.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}</select>
            <button className="btn" onClick={() => fire({ kind: "CAMERA_OFFLINE", camera_id: camera })}>Offline</button>
          </Row>
        )}
        {spec.lifts.length > 0 && (
          <Row title="Lift Fault" desc="Freight lift out of service — waiting robots reroute to the other lift; a rider stays aboard until recovery">
            <select value={lift} onChange={(e) => setLift(e.target.value)}>{spec.lifts.map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}</select>
            <button className="btn danger" onClick={() => fire({ kind: "LIFT_FAULT", lift_id: lift })}>Fault</button>
          </Row>
        )}
        {drones.length > 0 && (
          <Row title="Drone signal lost" desc="Drone aborts its route and returns to its home position">
            <select value={robot} onChange={(e) => setRobot(e.target.value)}>{drones.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.flight?.mode ?? "grounded"}</option>)}</select>
            <button className="btn danger" onClick={() => fire({ kind: "DRONE_SIGNAL_LOST", robot_id: robot })}>Inject</button>
          </Row>
        )}
        <Row title="High Wind" desc="Grounds drones above their class wind limit and transfers active work">
          <input type="number" min={0} max={100} value={wind} onChange={(e) => setWind(+e.target.value)} title="wind m/s" /><span className="unit">m/s</span>
          <input type="number" min={10} max={600} value={duration} onChange={(e) => setDuration(+e.target.value)} title="seconds" /><span className="unit">s</span>
          <button className="btn warn" onClick={() => fire({ kind: "HIGH_WIND", wind_mps: wind, duration_ticks: duration * 10 })}>Inject</button>
        </Row>
        <Row title="Platform Motion" desc="Reduces legged speed on the lowest deck and monitoring confidence">
          <input type="range" min={0} max={1} step={0.1} value={motion} onChange={(e) => setMotion(+e.target.value)} title="severity" /><span className="unit">{Math.round(motion * 100)}%</span>
          <input type="number" min={10} max={600} value={duration} onChange={(e) => setDuration(+e.target.value)} title="seconds" /><span className="unit">s</span>
          <button className="btn warn" onClick={() => fire({ kind: "PLATFORM_MOTION", severity: motion, duration_ticks: duration * 10 })}>Inject</button>
        </Row>
        <Row title="Fog" desc="Reduces camera and robot perception confidence">
          <input type="range" min={0} max={1} step={0.1} value={level} onChange={(e) => setLevel(+e.target.value)} title="level" /><span className="unit">{Math.round(level * 100)}%</span>
          <input type="number" min={10} max={600} value={duration} onChange={(e) => setDuration(+e.target.value)} title="seconds" /><span className="unit">s</span>
          <button className="btn warn" onClick={() => fire({ kind: "FOG", level, duration_ticks: duration * 10 })}>Inject</button>
        </Row>
        <Row title="Gas Leak" desc="Treats the selected zone as Ex Zone 0 and dispatches a critical inspection">
          <select value={zone} onChange={(e) => setZone(e.target.value)}>{spec.zones.map((z) => <option key={z.id} value={z.id}>Zone {z.id}</option>)}</select>
          <input type="number" min={10} max={600} value={duration} onChange={(e) => setDuration(+e.target.value)} title="seconds" /><span className="unit">s</span>
          <button className="btn danger" onClick={() => fire({ kind: "GAS_LEAK", zone_id: zone, duration_ticks: duration * 10 })}>Inject</button>
        </Row>
        <Row title="Dropped Object" desc="Blocks every route through the selected zone and triggers replanning">
          <select value={zone} onChange={(e) => setZone(e.target.value)}>{spec.zones.map((z) => <option key={z.id} value={z.id}>Zone {z.id}</option>)}</select>
          <input type="number" min={10} max={600} value={duration} onChange={(e) => setDuration(+e.target.value)} title="seconds" /><span className="unit">s</span>
          <button className="btn danger" onClick={() => fire({ kind: "DROPPED_OBJECT", zone_id: zone, duration_ticks: duration * 10 })}>Inject</button>
        </Row>
        <Row title="Comms Blackout" desc="Mobile robot abandons work and returns to its base until communications recover">
          <select value={robot} onChange={(e) => setRobot(e.target.value)}>{robots.filter((r) => r.locomotion !== "static").map((r) => <option key={r.id} value={r.id}>{r.id} · {r.locomotion}</option>)}</select>
          <input type="number" min={10} max={600} value={duration} onChange={(e) => setDuration(+e.target.value)} title="seconds" /><span className="unit">s</span>
          <button className="btn danger" onClick={() => fire({ kind: "COMMS_BLACKOUT", robot_id: robot, duration_ticks: duration * 10 })}>Inject</button>
        </Row>
        <Row title="Task Burst" desc="Release many tasks at once — watch scheduling and congestion">
          <input type="number" min={1} max={30} value={burst} onChange={(e) => setBurst(+e.target.value)} /><span className="unit">tasks</span>
          <button className="btn" onClick={() => fire({ kind: "TASK_BURST", count: burst, priority: "HIGH" })}>Inject</button>
        </Row>
        {compound && compound.length > 0 && (
          <Row title="Compound Failure" desc={compound.map((c) => c.kind.replace(/_/g, " ").toLowerCase()).join(" + ")}>
            <button className="btn danger" onClick={() => { for (const inj of compound) fire(inj as ScenarioInjection); }}>Run all {compound.length}</button>
          </Row>
        )}

        <h4 className="drawer-sub">Active ({active.length})</h4>
        {active.length === 0 && <div className="hint">None — everything nominal.</div>}
        {active.map((a) => (
          <div key={a.kind + a.target} className="active-row">
            <span className="dot" style={{ background: "var(--red)" }} /><span>{a.label}</span>
            <button className="link" onClick={() => simControl.clearInjection(a.kind, a.target)}>Clear</button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="inj-row">
      <div className="inj-head"><b>{title}</b></div>
      <div className="inj-desc">{desc}</div>
      <div className="inj-ctl">{children}</div>
    </div>
  );
}
