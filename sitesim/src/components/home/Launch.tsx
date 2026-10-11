/**
 * Launch screen: before the dashboard opens the operator chooses how many
 * HUM-1 robots start the shift and what task each one is allotted. The choice
 * is carried in the URL (see state/launch.ts) and the console reloads with it,
 * which is how this app switches configuration (engine, grids and scene all
 * derive from the URL at module load).
 */
import { useEffect, useMemo, useState } from "react";
import { SPECS } from "../../spec/registry";
import { ANY, launchConfig, serializeLaunch } from "../../state/launch";

const API = import.meta.env.VITE_HARNESS_API ?? "http://localhost:8000";
const SPEC_KEY = "warehouse";
const MAX_AGENTS = 20;
const DEFAULT_AGENTS = 8;

interface Scores { version: number; zones: Record<string, number>; worst_zone?: string }

const TYPE_COLOR: Record<string, string> = { PICK: "#22c55e", REPLENISH: "#eab308", TRANSPORT: "#3b82f6", RETURN: "#a855f7" };

export function Launch() {
  const spec = SPECS[SPEC_KEY];
  const spawns = spec.fleet.spawns.slice(0, MAX_AGENTS);
  const types = spec.tasks.types;
  const typeIds = useMemo(() => types.map((t) => t.id), [types]);
  const specMix = useMemo(() => types.map((t) => t.weight), [types]);

  // Initial values: whatever the URL already carries (deep link / reload), else defaults.
  const [agents, setAgents] = useState(() => Math.min(MAX_AGENTS, Math.max(1, launchConfig.agents ?? DEFAULT_AGENTS)));
  const [seed, setSeed] = useState(() => launchConfig.seed);
  const worker = true; // every worker consults the brain at exception points
  const mix = specMix; // task generation follows the spec; what each agent takes is the allotment
  const [allot, setAllot] = useState<Record<string, string>>(() =>
    Object.fromEntries(spawns.map((sp) => [sp.id, launchConfig.allotment?.[sp.id]?.[0] ?? ANY])));

  const [scores, setScores] = useState<Scores | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`${API}/api/scores`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Scores | null) => { if (j && typeof j.version === "number") setScores(j); })
      .catch(() => { /* harness down: degrade silently */ });
    return () => ctl.abort();
  }, []);

  const deployed = spawns.slice(0, agents);
  const setOne = (id: string, t: string) => setAllot((a) => ({ ...a, [id]: t }));
  const preset = (fn: (sp: (typeof spawns)[number], i: number) => string) =>
    setAllot((a) => ({ ...a, ...Object.fromEntries(deployed.map((sp, i) => [sp.id, fn(sp, i)])) }));

  const launch = () => {
    const url = new URL(window.location.href);
    url.search = serializeLaunch({
      spec: SPEC_KEY, agents, seed, worker, mix,
      allot: Object.fromEntries(deployed.map((sp) => [sp.id, allot[sp.id] ?? ANY])),
    });
    window.location.assign(url.toString());
  };

  const zoneKeys = Object.keys(scores?.zones ?? {}).sort();
  const version = scores?.version;

  return (
    <div className="launch">
      <div className="launch-inner">
        <header className="launch-head">
          <div>
            <div className="brand big"><span className="ai">Site</span><span>Sim</span></div>
            <h1 className="launch-title">Deploy the fleet</h1>
            <p className="launch-sub">Choose how many HUM-1 robots start the shift and what each one is allotted; the brain they run is v{version ?? "?"} from the harness.</p>
          </div>
          <div className="launch-brain" title={scores ? `Harness brain v${scores.version}` : "Harness API offline"}>
            <div className="launch-brain-v">Brain v{version ?? "?"}</div>
            <div className="launch-brain-z">
              {(zoneKeys.length ? zoneKeys : ["A", "B", "C", "D", "M"]).map((z) => (
                <span key={z} className={"lz" + (scores?.worst_zone === z ? " worst" : "")}>
                  <b>{z}</b>{scores && scores.zones[z] !== undefined ? Math.round(scores.zones[z] * 100) : "–"}
                </span>
              ))}
            </div>
          </div>
        </header>

        <div className="launch-grid">
          {/* ── Left: agents, mix, seed, worker ── */}
          <section className="launch-card">
            <h3>Agents</h3>
            <div className="stepper">
              <button className="btn" onClick={() => setAgents((n) => Math.max(1, n - 1))} aria-label="Fewer agents">−</button>
              <input className="stepper-num" type="number" min={1} max={MAX_AGENTS} value={agents}
                onChange={(e) => setAgents(Math.min(MAX_AGENTS, Math.max(1, Math.floor(Number(e.target.value) || 1))))} />
              <button className="btn" onClick={() => setAgents((n) => Math.min(MAX_AGENTS, n + 1))} aria-label="More agents">+</button>
              <span className="stepper-of">of {spawns.length} HUM-1</span>
            </div>
            <div className="launch-hint">{deployed.filter((s) => (s.floor ?? 1) === 1).length} on the ground floor · {deployed.filter((s) => (s.floor ?? 1) === 2).length} on the mezzanine</div>


            <h3>Run</h3>
            <div className="run-row">
              <label className="run-field">
                <span>Seed</span>
                <input type="number" value={seed} min={0} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
              </label>
            </div>
            <button className="btn primary launch-go" onClick={launch}>Launch shift →</button>
            <a className="launch-alt" href="?home=1">Other environments</a>
          </section>

          {/* ── Right: allotment grid ── */}
          <section className="launch-card allot-card">
            <div className="allot-head">
              <h3>Allotment <span className="h-sub">{agents} robot{agents > 1 ? "s" : ""}</span></h3>
              <div className="allot-presets">
                <button className="btn" onClick={() => preset(() => ANY)}>Balanced</button>
                <button className="btn" onClick={() => preset((sp) => ((sp.floor ?? 1) === 2 ? "PICK" : ANY))}>By zone</button>
                <button className="btn" onClick={() => preset((_, i) => (i % 2 === 0 ? "PICK" : "TRANSPORT"))}>Pickers &amp; movers</button>
              </div>
            </div>
            <div className="allot-rows">
              {deployed.map((sp) => {
                const cur = allot[sp.id] ?? ANY;
                return (
                  <div key={sp.id} className="allot-row">
                    <span className="allot-id">{sp.id}</span>
                    <span className="allot-floor">{(sp.floor ?? 1) === 2 ? "Mezz" : "Ground"}</span>
                    <div className="seg">
                      {[...typeIds, ANY].map((t) => (
                        <button key={t} className={"seg-b" + (cur === t ? " on" : "")}
                          style={cur === t && t !== ANY ? { borderColor: TYPE_COLOR[t], color: TYPE_COLOR[t] } : undefined}
                          onClick={() => setOne(sp.id, t)}>{t === ANY ? "Any" : t}</button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
