import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const urlPath = resolve(process.cwd(), ".procura-cloudflare-url");
const baseUrl = (await readFile(urlPath, "utf8")).trim().replace(/\/$/, "");
let lastFailure = "No health response was received.";

for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch(baseUrl + "/health", { headers: { accept: "application/json" } });
    const payload = await response.json();
    if (response.ok && payload.status === "ok" && payload.service === "Procura" && payload.database && payload.file_store) {
      console.log("Procura health check passed: " + baseUrl + "/health");
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          "## Procura deployed\n\nLive app: " + baseUrl + "\n\nHealth check: database and file storage are connected.\n",
          "utf8",
        );
      }
      process.exit(0);
    }
    lastFailure = "Health endpoint returned " + response.status + " with status " + String(payload.status || "unknown") + ".";
  } catch (error) {
    lastFailure = error.message;
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
}

throw new Error("Procura did not become healthy after deployment: " + lastFailure);
