import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const accountSuffix = accountId?.slice(0, 6).toLowerCase();
const databaseName = "procura-v2-db";
const bucketName = "procura-v2-files";
const workerName = "procura-v2";

if (!accountId || !apiToken) {
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in GitHub Actions secrets.");
}

async function cloudflare(path, { method = "GET", body, allowNotFound = false } = {}) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      authorization: "Bearer " + apiToken,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok || payload.success === false) {
    const details = (payload.errors || []).map((error) => error.message).filter(Boolean).join("; ");
    throw new Error("Cloudflare API request failed (" + response.status + "): " + (details || method + " " + path));
  }
  return payload.result;
}

async function getOrCreateDatabase() {
  const path = "/accounts/" + encodeURIComponent(accountId) + "/d1/database";
  const matches = await cloudflare(path + "?name=" + encodeURIComponent(databaseName) + "&per_page=100");
  const existing = Array.isArray(matches) ? matches.find((database) => database.name === databaseName) : null;
  if (existing?.uuid) {
    console.log("Using existing D1 database: " + databaseName);
    return existing;
  }
  const created = await cloudflare(path, {
    method: "POST",
    body: { name: databaseName, primary_location_hint: "enam" },
  });
  if (!created?.uuid) throw new Error("Cloudflare created the D1 database but returned no database UUID.");
  console.log("Created D1 database: " + databaseName);
  return created;
}

async function getOrCreateBucket() {
  const path = "/accounts/" + encodeURIComponent(accountId) + "/r2/buckets";
  const response = await cloudflare(path + "?name=" + encodeURIComponent(bucketName) + "&per_page=100");
  const buckets = response?.buckets || [];
  const existing = buckets.find((bucket) => bucket.name === bucketName);
  if (existing) {
    console.log("Using existing R2 bucket: " + bucketName);
    return existing;
  }
  const created = await cloudflare(path, {
    method: "POST",
    body: { name: bucketName, locationHint: "enam" },
  });
  console.log("Created R2 bucket: " + bucketName);
  return created;
}

async function getOrCreateWorkersSubdomain() {
  const path = "/accounts/" + encodeURIComponent(accountId) + "/workers/subdomain";
  const current = await cloudflare(path, { allowNotFound: true });
  if (current?.subdomain) return current.subdomain;

  const candidate = "procura-" + accountSuffix;
  try {
    const created = await cloudflare(path, { method: "PUT", body: { subdomain: candidate } });
    if (!created?.subdomain) throw new Error("Cloudflare returned no workers.dev subdomain.");
    console.log("Created workers.dev subdomain: " + created.subdomain);
    return created.subdomain;
  } catch (error) {
    throw new Error(
      "A workers.dev subdomain is not set for this account. Set one in Cloudflare Workers & Pages, then retry. " +
      "Suggested name: " + candidate + ". Details: " + error.message,
    );
  }
}

const [database, bucket, subdomain] = await Promise.all([
  getOrCreateDatabase(),
  getOrCreateBucket(),
  getOrCreateWorkersSubdomain(),
]);

const config = {
  name: workerName,
  main: "worker/index.js",
  compatibility_date: "2026-11-08",
  account_id: accountId,
  workers_dev: true,
  d1_databases: [{
    binding: "DB",
    database_name: databaseName,
    database_id: database.uuid,
    migrations_dir: "drizzle",
  }],
  r2_buckets: [{
    binding: "BUCKET",
    bucket_name: bucketName,
  }],
};

await writeFile(resolve(process.cwd(), "wrangler.jsonc"), JSON.stringify(config, null, 2) + "\n", "utf8");
const publicUrl = "https://" + workerName + "." + subdomain + ".workers.dev";
await writeFile(resolve(process.cwd(), ".procura-cloudflare-url"), publicUrl + "\n", "utf8");
console.log("Prepared isolated Procura V2 Worker configuration for " + publicUrl);
