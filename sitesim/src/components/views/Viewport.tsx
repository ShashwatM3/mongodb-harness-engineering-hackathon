import { spec, useStore, type ViewTab, type SceneTool } from "../../state/store";
import { Icon } from "../ui/primitives";
import { Scene3D } from "../scene/Scene3D";
import { MapView2D } from "./MapView2D";
import { WorkersView } from "./WorkersView";

const TABS: Array<[ViewTab, string]> = [["3D", "3D VIEW"], ["WORKERS", "WORKERS"], ["MAP", "MAP VIEW"], ["TRAFFIC", "TRAFFIC VIEW"], ["HEATMAP", "HEATMAP"]];

export function Viewport() {
  const tab = useStore((s) => s.viewTab);
  const setTab = useStore((s) => s.setViewTab);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const showPaths = useStore((s) => s.showPaths);
  const showLabels = useStore((s) => s.showLabels);
  const togglePaths = useStore((s) => s.togglePaths);
  const toggleLabels = useStore((s) => s.toggleLabels);
  const focus = useStore((s) => s.focus);
  const activeFloor = useStore((s) => s.activeFloor);
  const setActiveFloor = useStore((s) => s.setActiveFloor);
  const { width: W, depth: D } = spec.site.size;
  const homeFocus: [number, number, number] = [W / 2, 0, D / 2 - 4];
  const upper = spec.floors.filter((f) => f.id !== 1);
  const toolBtn = (t: SceneTool, icon: JSX.Element, title: string, on = tool === t, onClick = () => setTool(t)) => (
    <button className={on ? "on" : ""} title={title} onClick={onClick}>{icon}</button>
  );
  return (
    <div className="viewport">
      <div className="view-tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="vp-toolbar">
        {upper.length > 0 && (
          <select className="sel" title="Floor" value={String(activeFloor)} onChange={(e) => {
            const v = e.target.value === "all" || e.target.value === "exploded" ? e.target.value as "all" | "exploded" : Number(e.target.value);
            setActiveFloor(v);
            if (typeof v === "number" && v !== 1) {
              const f = upper.find((x) => x.id === v);
              const xs = f?.footprint?.map((p) => p[0]) ?? [0, W], zs = f?.footprint?.map((p) => p[1]) ?? [0, D];
              focus([(Math.min(...xs) + Math.max(...xs)) / 2, f?.elevation ?? 0, (Math.min(...zs) + Math.max(...zs)) / 2]);
            } else focus(homeFocus);
          }}>
            <option value="all">All floors</option>
            <option value="1">Floor 1</option>
            {upper.map((f) => <option key={f.id} value={f.id}>Floor {f.id}</option>)}
            <option value="exploded">Exploded</option>
          </select>
        )}
        <button className="icon-btn" title="Reset camera" onClick={() => focus(homeFocus)}>{Icon.expand}</button>
        <button className="icon-btn" title="Viewport settings">{Icon.gear}</button>
      </div>
      {tab === "3D" ? <Scene3D /> : tab === "WORKERS" ? <WorkersView /> : <MapView2D mode={tab} />}
      {tab === "3D" && (
        <div className="scene-toolbar">
          {toolBtn("select", Icon.cursor, "Select")}
          {toolBtn("pan", Icon.hand, "Pan (left-drag)")}
          {toolBtn("paths", Icon.path, "Toggle paths", showPaths, togglePaths)}
          {toolBtn("labels", Icon.tag, "Toggle labels", showLabels, toggleLabels)}
          {toolBtn("measure", Icon.ruler, "Measure (later phase)", false, () => {})}
        </div>
      )}
    </div>
  );
}
