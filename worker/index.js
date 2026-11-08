import { page } from "./page.js";
import { analyzeVendor, DEMO_CASE, rankVendors } from "./analysis.js";
import { cleanExtractedText, extractDocumentText } from "./extract.js";

const COOKIE = "procura_session";
const SESSION_DAYS = 14;
const PASSWORD_HASH_ITERATIONS = 100000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_FILE = /\.(pdf|docx|txt|md|csv)$/i;

class ApiError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(status, message, code = undefined) {
  throw new ApiError(status, message, code);
}

function cookieValue(request, key) {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === key) return rest.join("=");
  }
  return "";
}

function cleanFilename(name) {
  return String(name || "upload")
    .replace(/\\/g, "/").split("/").pop()
    .replace(/[^\p{L}\p{N} ._()-]/gu, "")
    .trim().slice(0, 120) || "upload";
}

function inferVendor(filename) {
  return cleanFilename(filename).replace(/\.[^.]+$/, "")
    .replace(/\b(proposal|response|submission|bid|rfp|vendor|final|revised|v\d+)\b/gi, "")
    .replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "New vendor";
}

function cookieHeader(token, request, remove = false) {
  const secure = new URL(request.url).protocol === "https:";
  return COOKIE + "=" + (remove ? "" : token) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (remove ? "0" : String(SESSION_DAYS * 86400)) + (secure ? "; Secure" : "");
}

function enforceSameOrigin(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((origin && origin !== requestUrl.origin) || fetchSite === "cross-site") {
    fail(403, "This action must come from the Procura site.");
  }
}

function requireBindings(env) {
  if (!env.DB || !env.BUCKET) fail(503, "Cloud storage is not connected yet. Contact the Procura site owner.");
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const values = String(hex || "").match(/.{1,2}/g) || [];
  return new Uint8Array(values.map((part) => parseInt(part, 16)));
}

function randomToken(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function digest(value) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(salt), iterations: PASSWORD_HASH_ITERATIONS, hash: "SHA-256" }, key, 256);
  return bytesToHex(bits);
}

function publicAccount(row) {
  return { id: row.id, company_name: row.company_name, full_name: row.full_name, email: row.email };
}

async function currentAccount(request, env) {
  requireBindings(env);
  const token = cookieValue(request, COOKIE);
  if (!token) return null;
  const tokenHash = await digest(token);
  return env.DB.prepare(
    "SELECT a.id, a.company_name, a.full_name, a.email FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(tokenHash, new Date().toISOString()).first();
}

async function needAccount(request, env) {
  const account = await currentAccount(request, env);
  if (!account) fail(401, "Sign in to open your Procura workspace.");
  return account;
}

async function createSession(env, accountId, request) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()).run();
  await env.DB.prepare("INSERT INTO sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await digest(token), accountId, expires.toISOString(), now.toISOString()).run();
  return cookieHeader(token, request);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    fail(400, "Send a valid JSON request.");
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function safeTitle(value, filename) {
  const title = String(value || "").trim();
  if (title) return title.slice(0, 120);
  return cleanFilename(filename).replace(/\.[^.]+$/, "").slice(0, 120) || "Untitled opportunity";
}

function contentType(filename) {
  const ext = String(filename).split(".").pop().toLowerCase();
  return ({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", csv: "text/csv; charset=utf-8", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8" })[ext] || "application/octet-stream";
}

function contentDisposition(filename) {
  const clean = cleanFilename(filename);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const encoded = encodeURIComponent(clean).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encoded;
}

async function parseUpload(form, requiredName = "file") {
  const file = form.get(requiredName);
  if (!file || typeof file.arrayBuffer !== "function") fail(400, "Choose a document to upload.");
  const filename = cleanFilename(file.name);
  if (!ALLOWED_FILE.test(filename)) fail(415, "Upload a PDF, DOCX, TXT, MD, or CSV file.");
  if (!file.size) fail(400, filename + " is empty.");
  if (file.size > MAX_FILE_BYTES) fail(413, filename + " is larger than the 15 MB upload limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = filename.toLowerCase().endsWith(".pdf");
  if (isPdf && !new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1024))).includes("%PDF-")) {
    fail(415, filename + " does not contain a valid PDF header. Check that the file is really a PDF.", "INVALID_PDF");
  }
  let extracted;
  const suppliedText = isPdf ? form.get("extracted_text") : null;
  const suppliedMethod = isPdf ? String(form.get("extraction_method") || "").toLowerCase() : "";
  if (typeof suppliedText === "string" && ["pdfjs", "ocr"].includes(suppliedMethod)) {
    const text = cleanExtractedText(suppliedText);
    if (text.length >= 20) {
      extracted = { text, word_count: text.split(/\s+/).filter(Boolean).length, truncated: text.length >= 450000, extraction_method: suppliedMethod };
    }
  }
  if (!extracted) {
    try {
      extracted = await extractDocumentText(filename, bytes);
    } catch (error) {
      const needsOcr = isPdf && /no selectable text|ocr/i.test(error?.message || "");
      fail(422, filename + ": " + (needsOcr
        ? "No readable text was found. Reload the page and try automatic OCR, or use a text-searchable PDF."
        : (error?.message || "text could not be extracted.")), needsOcr ? "PDF_OCR_REQUIRED" : "DOCUMENT_UNREADABLE");
    }
  }
  return { filename, bytes, text: extracted.text, word_count: extracted.word_count, truncated: extracted.truncated, extraction_method: extracted.extraction_method || "native" };
}

async function putObjects(env, objects) {
  const written = [];
  try {
    for (const [key, value, options] of objects) {
      await env.BUCKET.put(key, value, options);
      written.push(key);
    }
  } catch (error) {
    await Promise.allSettled(written.map((key) => env.BUCKET.delete(key)));
    throw error;
  }
}

async function deleteObjects(env, keys) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  const results = await Promise.allSettled(uniqueKeys.map((key) => env.BUCKET.delete(key)));
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed) console.error("Procura file cleanup incomplete:", failed, "of", uniqueKeys.length);
  return failed === 0;
}

function invalidateStatements(env, opportunityId, accountId, now = new Date().toISOString()) {
  return [
    env.DB.prepare("UPDATE proposals SET result_json = NULL WHERE opportunity_id = ? AND account_id = ?").bind(opportunityId, accountId),
    env.DB.prepare("UPDATE opportunities SET analyzed_at = NULL, updated_at = ? WHERE id = ? AND account_id = ?").bind(now, opportunityId, accountId),
  ];
}

async function runBatch(env, statements) {
  if (typeof env.DB.batch === "function") return env.DB.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

async function uploadOpportunity(request, env, account) {
  let form;
  try { form = await request.formData(); } catch { fail(400, "The upload form could not be read. Choose the document again and retry.", "INVALID_UPLOAD_FORM"); }
  const upload = await parseUpload(form);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const objectKey = account.id + "/" + id + "/rfp/" + crypto.randomUUID() + "-" + upload.filename;
  const textKey = account.id + "/" + id + "/text/rfp.txt";
  try {
    await putObjects(env, [
      [objectKey, upload.bytes, { httpMetadata: { contentType: contentType(upload.filename) } }],
      [textKey, upload.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }],
    ]);
    await env.DB.prepare("INSERT INTO opportunities (id, account_id, title, rfp_filename, rfp_object_key, rfp_text_key, rfp_word_count, rfp_extraction_method, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, account.id, safeTitle(form.get("title"), upload.filename), upload.filename, objectKey, textKey, upload.word_count, upload.extraction_method, now, now).run();
  } catch (error) {
    await deleteObjects(env, [objectKey, textKey]);
    throw error;
  }
  return json({ id, title: safeTitle(form.get("title"), upload.filename), rfp_filename: upload.filename, rfp_word_count: upload.word_count, rfp_extraction_method: upload.extraction_method, proposal_count: 0, analyzed_at: null, created_at: now });
}

async function ownedOpportunity(env, account, opportunityId) {
  const row = await env.DB.prepare("SELECT * FROM opportunities WHERE id = ? AND account_id = ?").bind(opportunityId, account.id).first();
  if (!row) fail(404, "Opportunity not found in this company workspace.");
  return row;
}

async function addProposal(request, env, account, opportunity) {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS count FROM proposals WHERE opportunity_id = ? AND account_id = ?")
    .bind(opportunity.id, account.id).first();
  if ((existing?.count || 0) >= 20) fail(409, "This opportunity already has 20 proposals. Remove one before adding another.");
  let form;
  try { form = await request.formData(); } catch { fail(400, "The upload form could not be read. Choose the document again and retry.", "INVALID_UPLOAD_FORM"); }
  const upload = await parseUpload(form);
  const id = crypto.randomUUID();
  const objectKey = account.id + "/" + opportunity.id + "/proposals/" + id + "-" + upload.filename;
  const textKey = account.id + "/" + opportunity.id + "/text/" + id + ".txt";
  const vendorName = String(form.get("vendor_name") || inferVendor(upload.filename)).trim().slice(0, 90) || "New vendor";
  const now = new Date().toISOString();
  try {
    await putObjects(env, [
      [objectKey, upload.bytes, { httpMetadata: { contentType: contentType(upload.filename) } }],
      [textKey, upload.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }],
    ]);
    await runBatch(env, [
      env.DB.prepare("INSERT INTO proposals (id, opportunity_id, account_id, vendor_name, filename, object_key, text_key, word_count, extraction_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, opportunity.id, account.id, vendorName, upload.filename, objectKey, textKey, upload.word_count, upload.extraction_method, now),
      ...invalidateStatements(env, opportunity.id, account.id, now),
    ]);
  } catch (error) {
    await deleteObjects(env, [objectKey, textKey]);
    throw error;
  }
  return json({ id, vendor_name: vendorName, filename: upload.filename, word_count: upload.word_count, extraction_method: upload.extraction_method, created_at: now, analysis: null }, 201);
}

function parseStoredResult(row) {
  if (!row.result_json) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

async function listOpportunities(env, account) {
  const rows = await env.DB.prepare(
    "SELECT o.id, o.title, o.rfp_filename, o.rfp_word_count, o.created_at, o.updated_at, o.analyzed_at, COUNT(p.id) AS proposal_count FROM opportunities o LEFT JOIN proposals p ON p.opportunity_id = o.id AND p.account_id = o.account_id WHERE o.account_id = ? GROUP BY o.id ORDER BY o.updated_at DESC"
  ).bind(account.id).all();
  return json({ opportunities: rows.results || [] });
}

async function opportunityDetail(env, account, opportunity) {
  const stored = await env.BUCKET.get(opportunity.rfp_text_key);
  if (!stored) fail(410, "The extracted RFP text is no longer available. Re-upload this RFP to restore its comparison source.");
  const rfpText = await stored.text();
  const rows = await env.DB.prepare("SELECT id, vendor_name, filename, word_count, extraction_method, created_at, review_json, result_json FROM proposals WHERE opportunity_id = ? AND account_id = ? ORDER BY created_at")
    .bind(opportunity.id, account.id).all();
  const proposals = (rows.results || []).map((row) => ({
    id: row.id,
    vendor_name: row.vendor_name,
    filename: row.filename,
    word_count: row.word_count,
    extraction_method: row.extraction_method || "native",
    created_at: row.created_at,
    reviews: (() => { try { return JSON.parse(row.review_json || "{}"); } catch { return {}; } })(),
    analysis: parseStoredResult(row),
  }));
  const ranked = proposals.some((proposal) => proposal.analysis)
    ? rankVendors(proposals.filter((proposal) => proposal.analysis).map((proposal) => ({ ...proposal, ...proposal.analysis, proposal_id: proposal.id, filename: proposal.filename })))
    : [];
  return {
    opportunity: {
      id: opportunity.id,
      title: opportunity.title,
      rfp_filename: opportunity.rfp_filename,
      rfp_word_count: opportunity.rfp_word_count,
      rfp_extraction_method: opportunity.rfp_extraction_method || "native",
      created_at: opportunity.created_at,
      updated_at: opportunity.updated_at,
      analyzed_at: opportunity.analyzed_at,
    },
    rfp_text: rfpText,
    proposals,
    rankings: ranked,
  };
}

async function downloadObject(env, key, filename, type) {
  const object = await env.BUCKET.get(key);
  if (!object) fail(404, "The stored file could not be found.");
  return new Response(object.body, {
    headers: {
      "content-type": type || object.httpMetadata?.contentType || "application/octet-stream",
      "content-disposition": contentDisposition(filename),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return "\"" + text.replace(/"/g, "\"\"") + "\"";
}

async function exportComparison(env, account, opportunity) {
  const detail = await opportunityDetail(env, account, opportunity);
  if (!detail.rankings.length) fail(409, "Analyze the uploaded proposals before exporting the comparison.");
  const rows = [["Rank", "Vendor", "Decision", "Weighted score", "Hard gates failed", "Requirement", "Status", "RFP source quote", "Vendor response quote"]];
  for (const vendor of detail.rankings) {
    for (const requirement of vendor.requirements) {
      rows.push([vendor.rank, vendor.vendor_name, vendor.decision, vendor.score, vendor.hard_gates_failed, requirement.title, requirement.status, requirement.rfp_quote, requirement.proposal_quote]);
    }
  }
  const csv = "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": contentDisposition(cleanFilename(opportunity.title) + "-vendor-comparison.csv"), "cache-control": "private, no-store" } });
}

async function analyzeOpportunity(env, account, opportunity) {
  const rfpObject = await env.BUCKET.get(opportunity.rfp_text_key);
  if (!rfpObject) fail(410, "The RFP source file is no longer available.");
  const rfpText = await rfpObject.text();
  const rows = await env.DB.prepare("SELECT id, vendor_name, filename, text_key, review_json FROM proposals WHERE opportunity_id = ? AND account_id = ? ORDER BY created_at")
    .bind(opportunity.id, account.id).all();
  if (!rows.results?.length) fail(409, "Upload at least one vendor proposal before comparing this RFP.");
  const proposalTexts = [];
  for (const row of rows.results) {
    const proposal = await env.BUCKET.get(row.text_key);
    if (!proposal) fail(410, "The source text for " + row.filename + " is missing. Remove that response and upload it again.", "PROPOSAL_TEXT_MISSING");
    proposalTexts.push(await proposal.text());
  }
  let requirements;
  try {
    requirements = analyzeVendor(rfpText, proposalTexts[0], rows.results[0].vendor_name).requirements;
  } catch (error) {
    fail(422, error?.message || "The RFP could not be analyzed.", "ANALYSIS_FAILED");
  }
  const analyzedAt = new Date().toISOString();
  const updates = [];
  for (let index = 0; index < rows.results.length; index++) {
    const row = rows.results[index];
    let reviews = {};
    try { reviews = JSON.parse(row.review_json || "{}"); } catch {}
    let result;
    try {
      result = analyzeVendor(rfpText, proposalTexts[index], row.vendor_name, reviews);
    } catch (error) {
      console.error("Procura proposal analysis failed:", row.id, row.filename, error?.stack || error);
      fail(422, "Could not compare “" + row.filename + "”. Remove and re-upload this proposal, then try again.", "PROPOSAL_ANALYSIS_FAILED");
    }
    result.vendor_name = row.vendor_name;
    result.requirements = result.requirements.map((item, index) => ({
      ...item,
      id: requirements[index]?.id || item.id,
    }));
    updates.push(env.DB.prepare("UPDATE proposals SET result_json = ? WHERE id = ? AND opportunity_id = ? AND account_id = ?")
      .bind(JSON.stringify(result), row.id, opportunity.id, account.id));
  }
  updates.push(env.DB.prepare("UPDATE opportunities SET analyzed_at = ?, updated_at = ? WHERE id = ? AND account_id = ?")
    .bind(analyzedAt, analyzedAt, opportunity.id, account.id));
  await runBatch(env, updates);
  const updated = await ownedOpportunity(env, account, opportunity.id);
  const detail = await opportunityDetail(env, account, updated);
  return json({ analyzed_at: analyzedAt, rankings: detail.rankings });
}

async function updateReview(request, env, account, opportunity, proposalId) {
  const row = await env.DB.prepare("SELECT id, vendor_name, text_key, review_json FROM proposals WHERE id = ? AND opportunity_id = ? AND account_id = ?")
    .bind(proposalId, opportunity.id, account.id).first();
  if (!row) fail(404, "Vendor proposal not found.");
  const body = await readJson(request);
  const requirementId = String(body.requirement_id || "");
  const status = body.status == null ? null : String(body.status).toUpperCase();
  if (!/^req-\d{1,2}$/.test(requirementId)) fail(422, "Choose a requirement from the comparison.");
  if (status !== null && !["VERIFIED", "PARTIAL", "GAP"].includes(status)) fail(422, "Review status must be Verified, Partial, or Gap.");
  let reviews = {};
  try { reviews = JSON.parse(row.review_json || "{}"); } catch {}
  if (status) reviews[requirementId] = status;
  else delete reviews[requirementId];
  let resultJson = null;
  if (opportunity.analyzed_at) {
    const rfp = await env.BUCKET.get(opportunity.rfp_text_key);
    const proposal = await env.BUCKET.get(row.text_key);
    if (!rfp || !proposal) fail(410, "A source text file is missing. Re-upload the affected document before updating this review.", "SOURCE_TEXT_MISSING");
    const result = analyzeVendor(await rfp.text(), await proposal.text(), row.vendor_name, reviews);
    resultJson = JSON.stringify(result);
  }
  await env.DB.prepare(opportunity.analyzed_at
    ? "UPDATE proposals SET review_json = ?, result_json = ? WHERE id = ? AND opportunity_id = ? AND account_id = ?"
    : "UPDATE proposals SET review_json = ? WHERE id = ? AND opportunity_id = ? AND account_id = ?")
    .bind(...(opportunity.analyzed_at
      ? [JSON.stringify(reviews), resultJson, proposalId, opportunity.id, account.id]
      : [JSON.stringify(reviews), proposalId, opportunity.id, account.id])).run();
  const current = await ownedOpportunity(env, account, opportunity.id);
  const detail = await opportunityDetail(env, account, current);
  return json({ rankings: detail.rankings });
}

async function seedDemo(env, account) {
  const existing = await env.DB.prepare("SELECT opportunity_id FROM demo_uses WHERE account_id = ?").bind(account.id).first();
  if (existing) {
    const opportunity = await ownedOpportunity(env, account, existing.opportunity_id);
    const detail = await opportunityDetail(env, account, opportunity);
    return json({ opportunity: { id: opportunity.id, title: opportunity.title }, rankings: detail.rankings, already_added: true });
  }
  const now = new Date().toISOString();
  const opportunityId = crypto.randomUUID();
  const rfpObjectKey = account.id + "/" + opportunityId + "/rfp/demo.txt";
  const rfpTextKey = account.id + "/" + opportunityId + "/text/rfp.txt";
  await env.BUCKET.put(rfpObjectKey, DEMO_CASE.rfpText, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  await env.BUCKET.put(rfpTextKey, DEMO_CASE.rfpText, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  await env.DB.prepare("INSERT INTO opportunities (id, account_id, title, rfp_filename, rfp_object_key, rfp_text_key, rfp_word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(opportunityId, account.id, "Mapleton Student Platform", DEMO_CASE.rfpName, rfpObjectKey, rfpTextKey, DEMO_CASE.rfpText.split(/\s+/).length, now, now).run();
  for (const sample of DEMO_CASE.proposals) {
    const id = crypto.randomUUID();
    const objectKey = account.id + "/" + opportunityId + "/proposals/" + id + "-" + sample.filename;
    const textKey = account.id + "/" + opportunityId + "/text/" + id + ".txt";
    await env.BUCKET.put(objectKey, sample.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    await env.BUCKET.put(textKey, sample.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    await env.DB.prepare("INSERT INTO proposals (id, opportunity_id, account_id, vendor_name, filename, object_key, text_key, word_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, opportunityId, account.id, sample.vendorName, sample.filename, objectKey, textKey, sample.text.split(/\s+/).length, now).run();
  }
  await env.DB.prepare("INSERT INTO demo_uses (account_id, opportunity_id) VALUES (?, ?)").bind(account.id, opportunityId).run();
  const opportunity = await ownedOpportunity(env, account, opportunityId);
  const result = await analyzeOpportunity(env, account, opportunity);
  return json({ opportunity: { id: opportunityId, title: "Mapleton Student Platform" }, rankings: (await result.json()).rankings, already_added: false }, 201);
}

async function deleteOpportunity(env, account, opportunity) {
  const proposals = await env.DB.prepare("SELECT object_key, text_key FROM proposals WHERE opportunity_id = ? AND account_id = ?")
    .bind(opportunity.id, account.id).all();
  const keys = [opportunity.rfp_object_key, opportunity.rfp_text_key, ...(proposals.results || []).flatMap((row) => [row.object_key, row.text_key])];
  await runBatch(env, [
    env.DB.prepare("DELETE FROM proposals WHERE opportunity_id = ? AND account_id = ?").bind(opportunity.id, account.id),
    env.DB.prepare("DELETE FROM opportunities WHERE id = ? AND account_id = ?").bind(opportunity.id, account.id),
  ]);
  const filesRemoved = await deleteObjects(env, keys);
  return json({ deleted: opportunity.id, files_removed: filesRemoved });
}

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  };
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "GET" && path === "/health") {
    const dbOk = !!env.DB;
    const bucketOk = !!env.BUCKET;
    return json({ status: dbOk && bucketOk ? "ok" : "storage_unavailable", service: "Procura", database: dbOk, file_store: bucketOk });
  }
  if (method === "GET" && (path === "/" || path === "/login" || path === "/app")) {
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (path.startsWith("/api/") && !path.startsWith("/api/auth/") && method !== "GET") enforceSameOrigin(request);
  if (path === "/api/auth/register" && method === "POST") {
    requireBindings(env);
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const company = String(body.company_name || "").trim();
    const name = String(body.full_name || "").trim();
    const password = String(body.password || "");
    if (!company || company.length > 120 || !name || name.length > 120 || !validEmail(email)) fail(422, "Enter your company, name, and a valid email address.");
    if (password.length < 12 || password.length > 200) fail(422, "Choose a password with at least 12 characters.");
    const id = crypto.randomUUID();
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const hashed = await passwordHash(password, salt);
    const now = new Date().toISOString();
    try {
      await env.DB.prepare("INSERT INTO accounts (id, company_name, full_name, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, company, name, email, salt, hashed, now).run();
    } catch {
      fail(409, "An account already uses this email. Sign in with it or register with a different email.");
    }
    const cookie = await createSession(env, id, request);
    return json({ account: { id, company_name: company, full_name: name, email } }, 201, { "set-cookie": cookie });
  }
  if (path === "/api/auth/login" && method === "POST") {
    requireBindings(env);
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    if (!validEmail(email) || !password) fail(422, "Enter a valid email and password.");
    const attempts = await env.DB.prepare("SELECT failures, blocked_until FROM login_attempts WHERE email = ?").bind(email).first();
    if (attempts?.blocked_until && new Date(attempts.blocked_until) > new Date()) fail(429, "Too many sign-in attempts. Try again in 15 minutes.");
    const account = await env.DB.prepare("SELECT id, company_name, full_name, email, password_salt, password_hash FROM accounts WHERE email = ?").bind(email).first();
    const candidate = account ? await passwordHash(password, account.password_salt) : await passwordHash(password, "00000000000000000000000000000000");
    if (!account || candidate !== account.password_hash) {
      const failures = (attempts?.failures || 0) + 1;
      const blocked = failures >= 8 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      await env.DB.prepare("INSERT INTO login_attempts (email, failures, blocked_until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at")
        .bind(email, failures, blocked, new Date().toISOString()).run();
      fail(401, "Email or password is incorrect.");
    }
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run();
    const cookie = await createSession(env, account.id, request);
    return json({ account: publicAccount(account) }, 200, { "set-cookie": cookie });
  }
  if (path === "/api/auth/logout" && method === "POST") {
    requireBindings(env);
    enforceSameOrigin(request);
    const token = cookieValue(request, COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await digest(token)).run();
    return json({ signed_out: true }, 200, { "set-cookie": cookieHeader("", request, true) });
  }
  if (path === "/api/auth/me" && method === "GET") {
    const account = await needAccount(request, env);
    return json({ account: publicAccount(account) });
  }
  if (path === "/api/demo" && method === "POST") {
    const account = await needAccount(request, env);
    return seedDemo(env, account);
  }
  if (path === "/api/opportunities" && method === "GET") {
    const account = await needAccount(request, env);
    return listOpportunities(env, account);
  }
  if (path === "/api/opportunities" && method === "POST") {
    const account = await needAccount(request, env);
    return uploadOpportunity(request, env, account);
  }
  const match = path.match(/^\/api\/opportunities\/([0-9a-f-]+)(?:\/(.*))?$/i);
  if (match) {
    const account = await needAccount(request, env);
    const opportunity = await ownedOpportunity(env, account, match[1]);
    const action = match[2] || "";
    if (!action && method === "GET") return json(await opportunityDetail(env, account, opportunity));
    if (!action && method === "DELETE") return deleteOpportunity(env, account, opportunity);
    if (action === "proposals" && method === "POST") return addProposal(request, env, account, opportunity);
    if (action === "analyze" && method === "POST") return analyzeOpportunity(env, account, opportunity);
    if (action === "export.csv" && method === "GET") return exportComparison(env, account, opportunity);
    if (action === "rfp/download" && method === "GET") return downloadObject(env, opportunity.rfp_object_key, opportunity.rfp_filename, contentType(opportunity.rfp_filename));
    const proposalMatch = action.match(/^proposals\/([0-9a-f-]+)(?:\/(.*))?$/i);
    if (proposalMatch) {
      const proposalId = proposalMatch[1];
      const proposalAction = proposalMatch[2] || "";
      const proposal = await env.DB.prepare("SELECT * FROM proposals WHERE id = ? AND opportunity_id = ? AND account_id = ?")
        .bind(proposalId, opportunity.id, account.id).first();
      if (!proposal) fail(404, "Vendor proposal not found.");
      if (!proposalAction && method === "PATCH") {
        const body = await readJson(request);
        const vendorName = String(body.vendor_name || "").trim();
        if (!vendorName || vendorName.length > 90) fail(422, "Enter a vendor name under 90 characters.");
        await runBatch(env, [
          env.DB.prepare("UPDATE proposals SET vendor_name = ? WHERE id = ? AND opportunity_id = ? AND account_id = ?")
            .bind(vendorName, proposalId, opportunity.id, account.id),
          ...invalidateStatements(env, opportunity.id, account.id),
        ]);
        return json({ id: proposalId, vendor_name: vendorName });
      }
      if (proposalAction === "review" && method === "PATCH") return updateReview(request, env, account, opportunity, proposalId);
      if (proposalAction === "download" && method === "GET") return downloadObject(env, proposal.object_key, proposal.filename, contentType(proposal.filename));
      if (!proposalAction && method === "DELETE") {
        await runBatch(env, [
          env.DB.prepare("DELETE FROM proposals WHERE id = ? AND opportunity_id = ? AND account_id = ?").bind(proposalId, opportunity.id, account.id),
          ...invalidateStatements(env, opportunity.id, account.id),
        ]);
        const filesRemoved = await deleteObjects(env, [proposal.object_key, proposal.text_key]);
        return json({ deleted: proposalId, files_removed: filesRemoved });
      }
    }
  }
  fail(404, "Procura could not find that page.");
}

export default {
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(securityHeaders())) if (!headers.has(key)) headers.set(key, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      if (!(error instanceof ApiError)) console.error("Procura Worker request failed:", error?.name || "Unknown error");
      const status = error instanceof ApiError ? error.status : 500;
      const message = error instanceof ApiError ? error.message : "Procura could not complete that request. Try again.";
      return json({ error: message, ...(error instanceof ApiError && error.code ? { code: error.code } : {}) }, status, securityHeaders());
    }
  },
};
