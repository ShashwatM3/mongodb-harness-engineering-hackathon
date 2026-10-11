/**
 * Compile brain JSON files with TwinForge's own brain compiler (WP-B), without the HTTP runner.
 * The go/no-go check "export_brain(1) compiles to the same patch_hash as brains/v1.json" runs on this.
 *
 *   $TWINFORGE_DIR/node_modules/.bin/tsx kg/tools/compile_check.mts brain1.json brain2.json ...
 *
 * Prints { "<file>": { ok, patch_hash, patch, rejected, locked_edits, warnings } } as JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.TWINFORGE_DIR ?? path.resolve(here, "../../../physical-ai");
const imp = (p: string) => import(pathToFileURL(path.join(dir, p)).href);
const { compileBrain } = await imp("src/harness/brain.ts");
const { humanoidWarehouse } = await imp("src/harness/overlay.ts");
const spec = humanoidWarehouse(JSON.parse(fs.readFileSync(path.join(dir, "src/specs/warehouse.json"), "utf8")));
const out: Record<string, unknown> = {};
for (const f of process.argv.slice(2)) {
  const r = compileBrain(JSON.parse(fs.readFileSync(f, "utf8")), spec);
  out[f] = { ok: r.ok, patch_hash: r.patch_hash, patch: r.patch, rejected: r.rejected, locked_edits: r.locked_edits,
             warnings: r.warnings };
}
process.stdout.write(JSON.stringify(out));
