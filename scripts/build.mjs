import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await mkdir(resolve(dist, ".openai"), { recursive: true });
await cp(resolve(root, "worker"), resolve(dist, "server"), { recursive: true });
await cp(resolve(root, ".openai/hosting.json"), resolve(dist, ".openai/hosting.json"));
await cp(resolve(root, "drizzle"), resolve(dist, ".openai/drizzle"), { recursive: true });
const hosting = JSON.parse(await readFile(resolve(root, ".openai/hosting.json"), "utf8"));
if (!hosting.project_id || hosting.d1 !== "DB" || hosting.r2 !== "BUCKET") {
  throw new Error("The Sites manifest must include its project ID, D1 binding, and R2 binding.");
}
console.log("Built Procura cloud Worker and database migration.");
