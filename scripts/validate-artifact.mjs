import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/worker/index.js");
const pagePath = resolve(projectRoot, "dist/worker/page.js");
await readFile(resolve(projectRoot, "dist/drizzle/0001_procura.sql"), "utf8");
await readFile(resolve(projectRoot, "dist/drizzle/0002_pdf_extraction_method.sql"), "utf8");
for (const file of ["page.js", "extract.js", "analysis.js"]) {
  await readFile(resolve(projectRoot, "dist/worker", file), "utf8");
}
const page = await readFile(pagePath, "utf8");
assert.match(page, /Procura V2 — Evidence-led vendor decisions/, "V2 design title must be included");
assert.match(page, /prefers-reduced-motion:reduce/, "Reduced-motion support must remain available");
const workerModule = await import(pathToFileURL(workerPath).href);
assert.equal(typeof workerModule.default?.fetch, "function", "Worker must export default.fetch");
console.log("Procura V2 artifact is valid ESM, contains its migrations and design, and exports default.fetch.");
