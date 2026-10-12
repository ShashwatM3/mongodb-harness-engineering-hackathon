/**
 * Worker bridge: a small mailbox between the engine's exception points and the worker agent.
 *
 *   POST /worker/exceptions         engine → {robot_id, kind, ctx, shift_id?}      → {id}
 *   GET  /worker/exceptions?wait=ms worker long-polls for unanswered exceptions   → {exceptions: [...]}
 *   POST /worker/decisions          worker → {id, action, args?, rationale?}       → {ok}
 *   GET  /worker/decisions/:id      engine polls for the answer                     → {decision | null}
 *   GET  /worker/log                dashboard: the last 200 exceptions with their decisions
 *
 * The browser engine applies the returned action through SimEngine.applyDecision; if no decision arrives
 * within its timeout it falls back to the deterministic default, so a slow worker never stalls a shift.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SimEngine } from "../engine/engine";
import type { RobotState } from "../schema/twin_state";

export const WORKER_ACTIONS = ["move_to", "pick", "place", "wait_at_holding_point", "reroute", "swap_task", "go_charge", "take_stairs", "take_lift", "continue"] as const;
export type WorkerAction = (typeof WORKER_ACTIONS)[number];

export interface ExceptionRecord {
  id: string; at: string; tick: number | null; shift_id: string | null;
  robot_id: string; kind: string; ctx: Record<string, unknown>;
  decision: { action: WorkerAction; args?: Record<string, unknown>; rationale?: string; by?: string; at: string } | null;
}

export class WorkerBridge {
  private log: ExceptionRecord[] = [];
  private seq = 0;
  private waiters: Array<() => void> = [];

  attach(engine: SimEngine, seed: number) {
    engine.onException = (r: RobotState, kind, ctx) => { this.record(r.id, kind, { ...ctx, seed }, engine.state.sim.tick, `seed:${seed}`); };
  }

  record(robot_id: string, kind: string, ctx: Record<string, unknown>, tick: number | null, shift_id: string | null): ExceptionRecord {
    const rec: ExceptionRecord = { id: `ex-${++this.seq}`, at: new Date().toISOString(), tick, shift_id, robot_id, kind, ctx, decision: null };
    this.log.push(rec); if (this.log.length > 200) this.log.shift();
    for (const w of this.waiters.splice(0)) w();
    return rec;
  }

  pending(): ExceptionRecord[] { return this.log.filter((e) => e.decision === null); }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, send: (res: ServerResponse, code: number, body: unknown) => void, readBody: (req: IncomingMessage) => Promise<string>) {
    const p = url.pathname;
    if (req.method === "POST" && p === "/worker/exceptions") {
      const b = JSON.parse(await readBody(req));
      const rec = this.record(String(b.robot_id), String(b.kind), b.ctx ?? {}, b.tick ?? null, b.shift_id ?? null);
      return send(res, 201, { id: rec.id });
    }
    if (req.method === "GET" && p === "/worker/exceptions") {
      const wait = Math.min(30000, Number(url.searchParams.get("wait") ?? 0));
      if (!this.pending().length && wait > 0) await new Promise<void>((r) => { const t = setTimeout(r, wait); this.waiters.push(() => { clearTimeout(t); r(); }); });
      return send(res, 200, { exceptions: this.pending() });
    }
    if (req.method === "POST" && p === "/worker/decisions") {
      const b = JSON.parse(await readBody(req));
      const rec = this.log.find((e) => e.id === b.id);
      if (!rec) return send(res, 404, { error: "not_found", message: `no exception ${b.id}` });
      if (!WORKER_ACTIONS.includes(b.action)) return send(res, 400, { error: "bad_action", message: `action must be one of ${WORKER_ACTIONS.join(", ")}` });
      rec.decision = { action: b.action, args: b.args ?? {}, rationale: b.rationale ?? "", by: b.by ?? "worker", at: new Date().toISOString() };
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && p.startsWith("/worker/decisions/")) {
      const rec = this.log.find((e) => e.id === p.slice("/worker/decisions/".length));
      return send(res, rec ? 200 : 404, { decision: rec?.decision ?? null });
    }
    if (req.method === "GET" && p === "/worker/log") return send(res, 200, { exceptions: this.log.slice(-200).reverse() });
    return send(res, 404, { error: "not_found", message: p });
  }
}
