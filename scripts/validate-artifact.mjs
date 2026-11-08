import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");
const hosting = JSON.parse(await readFile(manifestPath, "utf8"));
assert.ok(hosting.project_id, "A Sites project ID must be saved in the manifest.");
assert.equal(hosting.d1, "DB", "D1 binding must be declared");
assert.equal(hosting.r2, "BUCKET", "R2 binding must be declared");
await readFile(resolve(projectRoot, "dist/.openai/drizzle/0001_procura.sql"), "utf8");
await readFile(resolve(projectRoot, "dist/.openai/drizzle/0002_pdf_extraction_method.sql"), "utf8");
for (const file of ["page.js", "extract.js", "analysis.js"]) {
  await readFile(resolve(projectRoot, "dist/server", file), "utf8");
}
const workerModule = await import(pathToFileURL(workerPath).href);
assert.equal(typeof workerModule.default?.fetch, "function", "Worker must export default.fetch");
console.log("Procura artifact is valid ESM, includes its database migration, and exports default.fetch.");
