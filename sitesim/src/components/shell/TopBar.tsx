import { spec, site, useStore, tickToClock } from "../../state/store";
import { SPECS, specKey, switchSpec } from "../../spec/registry";
import { simControl } from "../../simulation/runner";
import { launchConfig } from "../../state/launch";
import { Icon } from "../ui/primitives";

export function TopBar() {
  const mode = useStore((s) => s.twin.sim.mode);
  const tick = useStore((s) => s.twin.sim.tick);
  const speed = useStore((s) => s.speed);
  const paused = useStore((s) => s.paused);
  const drawer = useStore((s) => s.drawer);
  const setDrawer = useStore((s) => s.setDrawer);
  const alerts = useStore((s) => s.twin.alerts);
  const quality = useStore((s) => s.quality);
  const setQuality = useStore((s) => s.setQuality);
  const timeOfDay = useStore((s) => s.timeOfDay);
  const setTimeOfDay = useStore((s) => s.setTimeOfDay);
  const unack = Object.values(alerts).filter((a) => !a.acknowledged).length;
  return (
    <header className="topbar">
      <div className="brand"><span className="ai">Site</span><span>Sim</span><span className="brand-sub">{spec.meta.name}</span></div>
      <a className="tb-btn" href="/" title="Launch screen: fleet size and allotment" style={{ textDecoration: "none" }}><span>Launch</span></a>
      <select className="spec-picker" title="Active environment spec — a new environment is just a new spec file" value={specKey} onChange={(e) => switchSpec(e.target.value)}>
        {Object.entries(SPECS).map(([k, s]) => <option key={k} value={k}>{s.meta.vertical}: {s.meta.name}</option>)}
      </select>
      <span className="launch-chip" title="Deployed agents · brain version (see Brain panel)">{launchConfig.agents ?? spec.fleet.spawns.length} agents · brain v?</span>
      <span className={"badge-live " + (paused ? "paused" : mode === "WHATIF" ? "whatif" : "live")}>
        <span className="dot" style={{ background: "currentColor", width: 6, height: 6 }} />{paused ? "PAUSED" : mode === "WHATIF" ? "SIMULATION" : "LIVE"}
      </span>
      <span className="badge-src local" title="Deterministic spec-compiled engine running in-browser">
        <span className="dot" style={{ background: "currentColor", width: 6, height: 6 }} />SPEC ENGINE
      </span>
      {site.gaps.length > 0 && (
        <span className="badge-gap" title={`Capability gaps (rendered as placeholders): ${site.gaps.map((g) => `${g.fixture_id} [${g.kind}]`).join(", ")}`}>
          {Icon.warn}<span>{site.gaps.length} GAP{site.gaps.length > 1 ? "S" : ""}</span>
        </span>
      )}
      <div className="topbar-right">
        <div className="sim-controls" title="Simulation controls">
          <button className={!paused ? "on" : ""} title="Play" onClick={() => simControl.play()}>{Icon.play}</button>
          <button className={paused ? "on" : ""} title="Pause" onClick={() => simControl.pause()}>{Icon.pause}</button>
          <button title="Reset (same seed)" onClick={() => simControl.reset()}>{Icon.reset}</button>
          {([1, 2, 5, 10] as const).map((x) => <button key={x} className={speed === x ? "on" : ""} onClick={() => simControl.play(x)}>{x}×</button>)}
        </div>
        <div className="clock" title="Simulation time">
          <div className="t">{tickToClock(tick, 100, true)}</div>
          <div className="d">{spec.theme.sim_date} · T{tick}</div>
        </div>
        <div className="vsep" />
        <button className={"tb-btn" + (drawer === "scenarios" ? " on" : "")} onClick={() => setDrawer("scenarios")} title="Failure injection">{Icon.bolt}<span>Scenarios</span></button>
        <button className={"tb-btn" + (drawer === "ops" ? " on" : "")} onClick={() => setDrawer("ops")} title="AI Operations: KPI + explainable decisions">{Icon.brain}<span>AI Ops</span></button>
        <div className="vsep" />
        <button className="icon-btn" title="Unacknowledged alerts" onClick={() => setDrawer("scenarios")}>{Icon.bell}{unack > 0 && <span className="dot">{unack}</span>}</button>
        <button className="icon-btn" title={`Render quality: ${quality} (click to cycle)`} onClick={() => setQuality(quality === "low" ? "medium" : quality === "medium" ? "high" : "low")}>{Icon.gear}</button>
        <button className="icon-btn" title={`Lighting: ${timeOfDay} (click to cycle day → dusk → night)`} onClick={() => setTimeOfDay(timeOfDay === "day" ? "dusk" : timeOfDay === "dusk" ? "night" : "day")}>{timeOfDay === "night" ? "\u263e" : timeOfDay === "dusk" ? "\u25d1" : "\u2600"}</button>
        <div className="vsep" />
        <div className="user"><span className="avatar">{Icon.user}</span><span>Admin</span>{Icon.chev}</div>
      </div>
    </header>
  );
}
