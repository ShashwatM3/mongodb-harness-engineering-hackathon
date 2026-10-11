/**
 * Local simulation loop. The engine is authoritative and runs entirely in the
 * browser at a fixed 100 ms tick; rendering interpolates on top.
 */
import { useEffect } from "react";
import { SimEngine, SIM } from "../engine/engine";
import { site, useStore } from "../state/store";
import type { ScenarioInjection, TaskPriority } from "../schema/twin_state";

let engine: SimEngine | null = null;
export function getEngine(): SimEngine {
  if (!engine) { engine = new SimEngine(site, { seed: useStore.getState().seed }); attachWorker(engine); }
  return engine;
}
export function resetEngine(seed?: number) {
  engine = new SimEngine(site, { seed: seed ?? useStore.getState().seed });
  attachWorker(engine);
  useStore.getState().setTwin(engine.snapshot());
  return engine;
}

/**
 * Worker-decision mailbox (only with `?worker=1`): each engine exception point is POSTed to the sim
 * server; if the worker answers within 4 s the decision overrides the deterministic default already applied.
 */
const WORKER_ON = new URLSearchParams(window.location.search).get("worker") === "1";
const SIM_SERVER = import.meta.env.VITE_SIM_SERVER ?? "http://localhost:8790";
function attachWorker(eng: SimEngine) {
  if (!WORKER_ON) return;
  const inflight = new Set<string>(), lastAt: Record<string, number> = {}, seen: Record<string, number> = {};
  eng.onException = (r, kind, ctx) => {
    const now = Date.now(), id = r.id;
    if (inflight.has(id) || now - (lastAt[id] ?? 0) < 3000) return;
    const key = `${id}|${kind}|${String(ctx.blocked_by ?? "")}`;
    if (now - (seen[key] ?? 0) < 30000) return;
    seen[key] = now; lastAt[id] = now; inflight.add(id);
    const tick = eng.state.sim.tick;
    (async () => {
      try {
        const res = await fetch(`${SIM_SERVER}/worker/exceptions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ robot_id: id, kind, ctx, tick }) });
        const { id: exId } = await res.json();
        if (!exId) return;
        for (let i = 0; i < 8; i++) {
          await new Promise((ok) => setTimeout(ok, 500));
          if (engine !== eng) return;
          const d = (await (await fetch(`${SIM_SERVER}/worker/decisions/${exId}`)).json()).decision;
          if (d?.action) { eng.applyDecision(id, d.action, { ...(d.args ?? {}), rationale: d.rationale }); useStore.getState().pulseBrain(id); return; }
        }
      } catch { /* sim server down: deterministic default stands */ }
      finally { inflight.delete(id); }
    })();
  };
}

export const simControl = {
  play(speed?: 1 | 2 | 5 | 10) {
    const st = useStore.getState();
    st.setPaused(false); if (speed) st.setSpeed(speed); else if (st.speed === 0) st.setSpeed(1);
  },
  pause() {
    useStore.getState().setPaused(true);
  },
  reset() {
    resetEngine();
  },
  inject(injection: ScenarioInjection) {
    getEngine().inject(injection);
  },
  createTask(task: { type: string; priority: TaskPriority; source: string; destination: string; load_units?: number }) {
    try { getEngine().createTask(task); } catch (e) { useStore.getState().setNotice(`Task rejected: ${(e as Error).message}`); }
  },
  clearInjection(kind: ScenarioInjection["kind"], target_id: string) {
    getEngine().clearInjection(kind, target_id);
  },
  ackAlert(alert_id: string) {
    getEngine().ackAlert(alert_id);
  },
};

export function useSimulationRunner() {
  useEffect(() => {
    const st = useStore.getState();
    let raf = 0, last = performance.now(), acc = 0;
    const MAX_TICKS_PER_FRAME = 40;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.25, (now - last) / 1000); last = now;
      const s = useStore.getState();
      if (s.paused || s.speed === 0) return;
      const eng = getEngine();
      acc += dt * s.speed;
      let n = 0;
      while (acc >= SIM.TICK_S && n < MAX_TICKS_PER_FRAME) { eng.step(); acc -= SIM.TICK_S; n++; }
      if (n > 0) { eng.state.sim.speed = s.speed; eng.state.sim.mode = "LIVE"; s.setTwin(eng.snapshot()); }
    };

    st.setTwin(getEngine().snapshot());
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}
