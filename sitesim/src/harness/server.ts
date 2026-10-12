/**
 * The sim server: the runner contract the kg package calls (GET /health, POST /run_shift, POST /validate_brain,
 * GET /settings) plus the worker bridge the dashboard uses at exception points.
 *
 *   npm run serve            # http://localhost:8790
 *   PORT=8790 SPEC=warehouse npx tsx src/harness/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvSpec } from "../spec/types";
import { compileBrain } from "./brain";
import type { BrainRejection, HealthResponse, RunShiftRequest, SettingsResponse, ValidateBrainResponse } from "./contract";
import { BrainRejectedError, runShift, specHash } from "./run";
import { SETTINGS } from "./settings";
import { WorkerBridge } from "./worker_bridge";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8790);
const SPEC_NAME = process.env.SPEC ?? "warehouse";
const spec: EnvSpec = JSON.parse(readFileSync(join(here, `../specs/${SPEC_NAME}.json`), "utf8"));

function engineSha(): string {
  try {
    const root = join(here, "../..");
    const sha = execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain -- sitesim/src", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    return sha + (dirty ? "-dirty" : "");
  } catch { return "unknown"; }
}
const ENGINE_SHA = engineSha();
const bridge = new WorkerBridge();

export interface SettingsResponseFull extends SettingsResponse { settings: Array<(typeof SETTINGS)[number]> }

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => { const c: Buffer[] = []; req.on("data", (x) => c.push(x)); req.on("end", () => resolve(Buffer.concat(c).toString("utf8"))); req.on("error", reject); });
}

export function health(): HealthResponse { return { ok: true, engine_sha: ENGINE_SHA, spec_id: spec.meta.id, spec_hash: specHash(spec), mode: "real" }; }

export function validate(body: { brain: RunShiftRequest["brain"] }): ValidateBrainResponse {
  const c = compileBrain(body.brain);
  return { ok: c.ok, spec_hash: specHash(spec), patch: c.patch, patch_hash: c.patch_hash, effective: c.effective, warnings: c.warnings, locked_edits: c.locked_edits, rejected: c.rejected };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, health());
    if (req.method === "GET" && url.pathname === "/settings") return send(res, 200, { spec_id: spec.meta.id, spec_hash: specHash(spec), settings: SETTINGS } satisfies SettingsResponse);
    if (req.method === "POST" && url.pathname === "/validate_brain") return send(res, 200, validate(JSON.parse(await readBody(req))));
    if (req.method === "POST" && url.pathname === "/run_shift") {
      const body = JSON.parse(await readBody(req)) as RunShiftRequest;
      try {
        const out = runShift(spec, body.brain, body.seeds, {
          ticks: body.ticks, profile: body.scenario_profile, allowLocked: body.allow_locked, heldOut: body.held_out, engineSha: ENGINE_SHA,
          onEngine: body.worker_hook ? (e, seed) => bridge.attach(e, seed) : undefined,
        });
        console.error(`[run_shift] v${body.brain.version} ${body.seeds.length} seeds ${out.ticks} ticks ${out.scenario_profile}${body.held_out ? " held-out" : ""} patch ${out.patch_hash} in ${out.wall_ms} ms`);
        return send(res, 200, out);
      } catch (e) {
        if (e instanceof BrainRejectedError) {
          const c = e.compiled;
          return send(res, 422, { error: c.rejected.length ? "brain_rejected" : "needs_approval", message: e.message, locked_edits: c.locked_edits, rejected: c.rejected, warnings: c.warnings } satisfies BrainRejection);
        }
        throw e;
      }
    }
    // Worker bridge (demo): the browser engine posts exception points, the worker answers with an action.
    if (url.pathname.startsWith("/worker/")) return bridge.handle(req, res, url, send, readBody);
    return send(res, 404, { error: "not_found", message: `${req.method} ${url.pathname}` });
  } catch (e) {
    return send(res, 400, { error: "bad_request", message: String(e), locked_edits: [], rejected: [], warnings: [] });
  }
});

server.listen(PORT, () => console.error(`sim server on http://localhost:${PORT} (${spec.meta.id}, engine ${ENGINE_SHA}, spec ${specHash(spec)})`));
