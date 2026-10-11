import { useEffect, useState } from "react";
import { useStore } from "./state/store";
import { TopBar } from "./components/shell/TopBar";
import { useSimulationRunner } from "./simulation/runner";
import { Viewport } from "./components/views/Viewport";
import { AlertsPanel, FleetOverviewPanel, SystemStatusPanel, TaskOverviewPanel } from "./components/panels/LeftPanels";
import { EventLogPanel, LiveCameraPanel, SelectedRobotPanel } from "./components/panels/RightPanels";
import { BrainPanel } from "./components/panels/BrainPanel";
import { RobotStatusPanel, TaskQueuePanel, ThroughputPanel } from "./components/panels/BottomPanels";
import { ScenariosDrawer } from "./components/ops/ScenariosDrawer";
import { OpsDrawer } from "./components/ops/OpsDrawer";
import { Landing } from "./components/home/Landing";

/**
 * The layout is designed at 1536×860 CSS px; smaller windows scale the whole
 * shell down proportionally so every panel stays visible.
 */
const DESIGN_W = 1536, DESIGN_H = 860;
function useFitScale() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const z = Math.min(1, window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
      root.style.setProperty("--ui-scale", z < 0.995 ? z.toFixed(4) : "1");
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
}

function Notice() {
  const notice = useStore((s) => s.notice);
  const setNotice = useStore((s) => s.setNotice);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), Math.max(0, notice.until - Date.now())); return () => clearTimeout(t); }, [notice, setNotice]);
  if (!notice) return null;
  return <div className={"notice " + notice.kind} onClick={() => setNotice(null)}>{notice.text}</div>;
}

/** Desktop ops console; phones would render at ~0.3× and be unreadable. */
const GATE_W = 1024;
function NarrowScreenGate({ children }: { children: React.ReactNode }) {
  const [dismissed, setDismissed] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < GATE_W);
  useEffect(() => { const f = () => setNarrow(window.innerWidth < GATE_W); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  if (narrow && !dismissed) {
    return (
      <div className="narrow-gate">
        <div className="brand"><span className="ai">Twin</span><span>Forge</span></div>
        <h2>Designed for desktop</h2>
        <p>TwinForge is a 3D operations console that works best on screens ≥ 1280 px wide (it still runs, scaled down, from 1024 px). On a phone the interface would shrink to about a quarter of its size and become unreadable.</p>
        <button className="btn" onClick={() => setDismissed(true)}>Continue anyway</button>
      </div>
    );
  }
  return <>{children}</>;
}

function Console() {
  useFitScale();
  useSimulationRunner();
  return (
    <div className="shell">
      <TopBar />
      <div className="shell-body">
        <aside className="col-left">
          <FleetOverviewPanel />
          <TaskOverviewPanel />
          <SystemStatusPanel />
          <AlertsPanel />
        </aside>
        <main className="center"><Viewport /></main>
        <aside className="col-right">
          <BrainPanel />
          <SelectedRobotPanel />
          <LiveCameraPanel />
          <EventLogPanel />
        </aside>
        <footer className="bottom">
          <TaskQueuePanel />
          <ThroughputPanel />
          <RobotStatusPanel />
        </footer>
      </div>
      <ScenariosDrawer />
      <OpsDrawer />
      <Notice />
    </div>
  );
}

export default function App() {
  // Step zero: no ?spec= means the landing page (environment list + create flow).
  const hasSpec = new URLSearchParams(window.location.search).has("spec");
  if (!hasSpec) return <Landing />;
  return <NarrowScreenGate><Console /></NarrowScreenGate>;
}
