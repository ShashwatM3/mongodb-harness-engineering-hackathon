/**
 * Runs TwinForge's fake runner (physical-ai src/harness/fake.ts) from outside the
 * TwinForge repo, so the KG can be built and tested before the HTTP runner (WP-R).
 *
 *   tsx kg/tools/fake_runner.mts --stdin < request.json      one RunShiftRequest → RunShiftResponse
 *   tsx kg/tools/fake_runner.mts --serve 8787                 the contract's endpoints, fake mode
 *
 * TWINFORGE_DIR points at the physical-ai checkout (default: ../physical-ai next to this repo).
 * Use tsx from that checkout: $TWINFORGE_DIR/node_modules/.bin/tsx. Once WP-R lands,
 * `npm run serve -- --fake` in physical-ai replaces --serve.
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.TWINFORGE_DIR ?? path.resolve(here, "../../../physical-ai");
const { fakeRunShift } = await import(pathToFileURL(path.join(dir, "src/harness/fake.ts")).href);

const HEALTH = { ok: true, engine_sha: "fake", spec_id: "warehouse-humanoid", spec_hash: "fake", mode: "fake" };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const mode = process.argv[2];
if (mode === "--stdin") {
  process.stdout.write(JSON.stringify(fakeRunShift(JSON.parse(await readStdin()))));
} else if (mode === "--serve") {
  const port = Number(process.argv[3] ?? 8787);
  createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, HEALTH);
      if (req.method === "POST" && req.url === "/run_shift") {
        const t0 = Date.now();
        const body = JSON.stringify(fakeRunShift(JSON.parse(await readBody(req))));
        res.writeHead(200, { "content-type": "application/json", "x-wall-ms": String(Date.now() - t0) });
        return res.end(body);
      }
      // No compiler in fake mode: the KG falls back to hashing brains itself.
      return send(404, { error: "not_found", message: `${req.method} ${req.url} is not served by the fake runner` });
    } catch (e) {
      return send(400, { error: "bad_request", message: String(e), locked_edits: [], rejected: [], warnings: [] });
    }
  }).listen(port, () => console.error(`fake runner on http://localhost:${port} (TWINFORGE_DIR=${dir})`));
} else {
  console.error("usage: fake_runner.mts --stdin | --serve [port]");
  process.exit(2);
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
