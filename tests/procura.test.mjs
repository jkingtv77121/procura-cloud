import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, deflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import worker from "../worker/index.js";
import { analyzeVendor, extractRequirements, rankVendors } from "../worker/analysis.js";
import { extractDocumentText } from "../worker/extract.js";

const root = resolve(import.meta.dirname, "..");
const migration = (await Promise.all([
  readFile(resolve(root, "drizzle/0001_procura.sql"), "utf8"),
  readFile(resolve(root, "drizzle/0002_pdf_extraction_method.sql"), "utf8"),
])).join("\n");
const sampleRfp = [
  "Vendor must provide at least 5 years of higher-education experience.",
  "Proposal must include SOC 2 Type II certification.",
  "Solution must maintain 99.9% uptime.",
  "Implementation must launch within 120 days.",
].join("\n");
const strongProposal = [
  "Northstar has 8 years of higher-education experience.",
  "Northstar provides SOC 2 Type II certification.",
  "The service maintains 99.95% uptime.",
  "Implementation launches in 105 days.",
].join("\n");
const weakProposal = [
  "The vendor has 3 years of higher-education experience.",
  "The vendor has no SOC 2 Type II certification.",
  "Service availability is 99.5% uptime.",
  "Implementation takes 180 days.",
].join("\n");

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, contents] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const plain = Buffer.from(contents, "utf8");
    const packed = deflateRawSync(plain);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const localRecord = Buffer.concat([local, filename, packed]);
    locals.push(localRecord);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(packed.length, 20);
    directory.writeUInt32LE(plain.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([directory, filename]));
    offset += localRecord.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function makeDocx(text) {
  const paragraphs = text.split(/\n/).map((line) => "<w:p><w:r><w:t>" + line.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</w:t></w:r></w:p>").join("");
  return makeZip({
    "word/document.xml": "<w:document><w:body>" + paragraphs + "</w:body></w:document>",
    "word/header1.xml": "<w:hdr><w:p><w:r><w:t>Response header</w:t></w:r></w:p></w:hdr>",
    "word/footer1.xml": "<w:ftr><w:p><w:r><w:t>Response footer</w:t></w:r></w:p></w:ftr>",
  });
}

function makePdf(text) {
  const commands = text.split(/\n/).map((line) => "BT /F1 12 Tf (" + line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ") Tj ET").join("\n");
  return Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n" + commands + "\nendstream\nendobj\n%%EOF", "latin1");
}

function makePdfTextArray() {
  const commands = "BT [(The system) -120 (must support) 40 (secure storage.)] TJ ET";
  return Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n" + commands + "\nendstream\nendobj\n%%EOF", "latin1");
}

function makeCompressedPdf(text) {
  const commands = text.split(/\n/).map((line) => "BT /F1 12 Tf (" + line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ") Tj ET").join("\n");
  const packed = deflateSync(Buffer.from(commands, "latin1"));
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page /Filter /FlateDecode >>\nstream\n", "latin1"),
    packed,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
}

class MemoryD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.failBatchAt = null;
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(migration);
  }
  prepare(sql) {
    const database = this.database;
    let args = [];
    return {
      sql,
      get args() { return args; },
      bind(...values) { args = values; return this; },
      async run() { return database.prepare(sql).run(...args); },
      async first() { return database.prepare(sql).get(...args) || null; },
      async all() { return { results: database.prepare(sql).all(...args) }; },
    };
  }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index++) {
        if (this.failBatchAt === index + 1) {
          this.failBatchAt = null;
          throw new Error("Simulated D1 batch failure.");
        }
        const statement = statements[index];
        results.push(this.database.prepare(statement.sql).run(...statement.args));
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class MemoryBucket {
  constructor() { this.objects = new Map(); this.failOnPutNumber = null; this.putCount = 0; }
  async put(key, value, options = {}) {
    this.putCount++;
    if (this.failOnPutNumber === this.putCount) throw new Error("Simulated R2 write failure.");
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { bytes: bytes.slice(), contentType: options.httpMetadata?.contentType || "application/octet-stream" });
  }
  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.bytes.slice();
    return {
      body: new Response(bytes).body,
      httpMetadata: { contentType: stored.contentType },
      async text() { return new TextDecoder().decode(bytes); },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  }
  async delete(key) { this.objects.delete(key); }
}

let env;
beforeEach(() => { env = { DB: new MemoryD1(), BUCKET: new MemoryBucket() }; });

async function call(path, { method = "GET", body, cookie = "", origin = "https://procura.test" } = {}) {
  const headers = new Headers();
  headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  if (body && !(body instanceof FormData)) headers.set("content-type", "application/json");
  const request = new Request("https://procura.test" + path, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return worker.fetch(request, env);
}

async function register(email = "buyer@example.test") {
  const response = await call("/api/auth/register", {
    method: "POST",
    body: { company_name: "Mapleton University", full_name: "Jordan Green", email, password: "Strong-test-password-2026!" },
  });
  return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
}

async function upload(path, filename, bytes, cookie, extra = {}) {
  const form = new FormData();
  form.set("file", new File([bytes], filename));
  Object.entries(extra).forEach(([key, value]) => form.set(key, value));
  return call(path, { method: "POST", body: form, cookie });
}

test("text, PDF, and DOCX uploads extract readable text", async () => {
  const text = await extractDocumentText("brief.txt", new TextEncoder().encode("A detailed plain text requirement for campus services."));
  assert.match(text.text, /plain text requirement/);
  const pdf = await extractDocumentText("brief.pdf", makePdf("The platform provides secure campus support services."));
  assert.match(pdf.text, /secure campus support/);
  const compressed = await extractDocumentText("brief-compressed.pdf", makeCompressedPdf("The vendor provides compressed-stream service evidence."));
  assert.match(compressed.text, /compressed-stream service evidence/);
  const arrayText = await extractDocumentText("array.pdf", makePdfTextArray());
  assert.match(arrayText.text, /The system[\s\S]*must support[\s\S]*secure storage/);
  const docx = await extractDocumentText("response.docx", makeDocx("The vendor has 8 years of campus experience."));
  assert.match(docx.text, /8 years of campus experience/);
  assert.match(docx.text, /Response header/);
  assert.match(docx.text, /Response footer/);
  const markdown = await extractDocumentText("brief.md", new TextEncoder().encode("# Requirements\nProvide a testable secure platform."));
  assert.match(markdown.text, /secure platform/);
  const csv = await extractDocumentText("brief.csv", new TextEncoder().encode("Requirement,Value\nUptime,99.9%"));
  assert.match(csv.text, /99.9%/);
});

test("scanned PDFs and unsupported file formats fail with actionable messages", async () => {
  await assert.rejects(() => extractDocumentText("scan.pdf", new TextEncoder().encode("%PDF-1.4 no selectable text")), /no selectable text.*OCR/i);
  await assert.rejects(() => extractDocumentText("image.png", new Uint8Array([1, 2, 3])), /PDF, DOCX, TXT, MD, or CSV/);
});

test("RFP requirement extraction splits a labeled list and preserves its language", () => {
  const requirements = extractRequirements("Mandatory requirements: provide 5 years of service, include SOC 2 certification, maintain 99.9% uptime.");
  assert.equal(requirements.length, 3);
  assert.match(requirements[0].rfp_quote, /5 years/);
  assert.equal(requirements[0].is_hard_gate, true);
});

test("numbered compliance matrices preserve nine requirements and partials remain conditional", () => {
  const rfp = [
    "4 Mandatory & Technical Requirements",
    "ID Requirement Category Evidence Expected",
    "M-1 Vendor must hold ISO 27001 certification. Compliance ISO 27001 Certificate",
    "M-2 Vendor must provide a current SOC 2 Type II report. Compliance SOC 2 Type II Report",
    "M-3 Vendor must demonstrate 5+ years mobility experience. Mandatory Case study + CVs",
    "M-4 Platform must meet a 99.9% uptime SLA. Technical SLA / uptime history",
    "M-5 Vendor must provide at least 3 client references. Mandatory 3 references",
    "M-6 Vendor must achieve go-live within 120 days. Technical Implementation plan",
    "M-7 Total price must be within the budget cap $2.5M. Commercial Pricing proposal",
    "M-8 Vendor must provide a data security / encryption policy. Compliance Data Security Policy",
    "M-9 Vendor must provide qualified staffing and key personnel. Technical Staff CVs",
  ].join("\n");
  const proposal = [
    "Compliance Matrix",
    "M-1 ISO 27001 certificate is current. VERIFIED",
    "M-2 SOC 2 Type II report attached. VERIFIED",
    "M-3 7 years of mobility experience. VERIFIED",
    "M-4 We commit to a 99.9% uptime SLA. PARTIAL: historical uptime was 99.85%. PARTIAL",
    "M-5 Two references are attached; a third is pending. PARTIAL",
    "M-6 Go-live in 110 days. VERIFIED",
    "M-7 Total price is $2.1M under the $2.5M cap. VERIFIED",
    "M-8 Encryption in transit and at rest; data security policy attached. VERIFIED",
    "M-9 Qualified staffing, key personnel, and CVs attached. VERIFIED",
  ].join("\n");
  const requirements = extractRequirements(rfp);
  assert.equal(requirements.length, 9);
  assert.equal(requirements[8].source_ref, "M-9");
  const result = analyzeVendor(rfp, proposal, "Summit Transit");
  assert.equal(result.total_count, 9);
  assert.equal(result.partial_count, 2);
  assert.equal(result.hard_gates_failed, 0);
  assert.equal(result.decision, "BID WITH CONDITIONS");
});

test("negative and below-threshold language cannot pass a hard gate", () => {
  const result = analyzeVendor(sampleRfp, weakProposal, "Weak Vendor");
  assert.equal(result.hard_gates_failed, 4);
  assert.equal(result.decision, "NO-BID");
  assert.equal(result.requirements[1].status, "GAP");
  assert.match(result.requirements[1].explanation, /not met/);
  assert.equal(result.requirements[0].status, "PARTIAL");
});

test("numeric capacity and over-budget claims fail hard-gate requirements", () => {
  const rfp = [
    "The platform must support at least 50,000 concurrent users.",
    "Pricing must remain within a $2.5M total budget.",
  ].join("\n");
  const proposal = [
    "Our platform supports 40,000 concurrent users.",
    "Total pricing is $2.8M.",
  ].join("\n");
  const result = analyzeVendor(rfp, proposal, "Beacon");
  assert.equal(result.hard_gates_failed, 2);
  assert.equal(result.decision, "NO-BID");
  assert.equal(result.requirements[0].status, "PARTIAL");
  assert.equal(result.requirements[1].status, "PARTIAL");
  assert.match(result.requirements[0].explanation, /does not meet the RFP threshold/);
  assert.match(result.requirements[1].explanation, /does not meet the RFP threshold/);
});

test("capacity above the minimum and pricing under a budget pass numeric checks", () => {
  const rfp = [
    "The platform must support at least 50,000 concurrent users.",
    "Pricing must remain within a $2.5M total budget.",
  ].join("\n");
  const proposal = [
    "Our platform supports 75,000 concurrent users.",
    "Total pricing is $2.2M.",
  ].join("\n");
  const result = analyzeVendor(rfp, proposal, "Atlas");
  assert.equal(result.hard_gates_failed, 0);
  assert.equal(result.decision, "BID");
  assert.equal(result.requirements.every((item) => item.status === "VERIFIED"), true);
});

test("vendor ranking sorts hard-gate fit before weighted coverage", () => {
  const strong = analyzeVendor(sampleRfp, strongProposal, "Northstar");
  const weak = analyzeVendor(sampleRfp, weakProposal, "Pinecone");
  assert.equal(strong.score, 100);
  assert.equal(strong.decision, "BID");
  assert.deepEqual(rankVendors([weak, strong]).map((item) => item.vendor_name), ["Northstar", "Pinecone"]);
});

test("registration creates distinct accounts and login works on another device session", async () => {
  const first = await register();
  assert.equal(first.response.status, 201);
  const duplicate = await register("BUYER@example.test");
  assert.equal(duplicate.response.status, 409);
  const secondAccount = await register("other@example.test");
  assert.equal(secondAccount.response.status, 201);
  const nextDevice = await call("/api/auth/login", { method: "POST", body: { email: "BUYER@example.test", password: "Strong-test-password-2026!" } });
  assert.equal(nextDevice.status, 200);
  const nextSession = nextDevice.headers.get("set-cookie").split(";")[0];
  const firstMe = await call("/api/auth/me", { cookie: first.cookie });
  const nextMe = await call("/api/auth/me", { cookie: nextSession });
  assert.equal((await firstMe.json()).account.id, (await nextMe.json()).account.id);
});

test("protected routes reject anonymous and cross-origin workspace writes", async () => {
  const anonymous = await call("/api/opportunities");
  assert.equal(anonymous.status, 401);
  const { cookie } = await register();
  const crossSite = await call("/api/opportunities", { method: "POST", cookie, body: new FormData(), origin: "https://attacker.example" });
  assert.equal(crossSite.status, 403);
});

test("sign out revokes only the current session and cross-site logout is rejected", async () => {
  const { cookie } = await register();
  const secondDevice = await call("/api/auth/login", { method: "POST", body: { email: "buyer@example.test", password: "Strong-test-password-2026!" } });
  const secondCookie = secondDevice.headers.get("set-cookie").split(";")[0];
  const rejected = await call("/api/auth/logout", { method: "POST", body: {}, cookie, origin: "https://attacker.example" });
  assert.equal(rejected.status, 403);
  const signedOut = await call("/api/auth/logout", { method: "POST", body: {}, cookie });
  assert.equal(signedOut.status, 200);
  assert.match(signedOut.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await call("/api/auth/me", { cookie })).status, 401);
  assert.equal((await call("/api/auth/me", { cookie: secondCookie })).status, 200);
});

test("repeated incorrect passwords trigger a temporary sign-in block", async () => {
  await register();
  for (let index = 0; index < 8; index++) {
    const wrong = await call("/api/auth/login", { method: "POST", body: { email: "buyer@example.test", password: "Incorrect-password-2026!" } });
    assert.equal(wrong.status, 401);
  }
  const blocked = await call("/api/auth/login", { method: "POST", body: { email: "buyer@example.test", password: "Strong-test-password-2026!" } });
  assert.equal(blocked.status, 429);
});

test("PDF RFP plus DOCX and PDF vendor proposals compare and persist in the cloud workspace", async () => {
  const { response: registration, cookie } = await register();
  assert.equal(registration.status, 201);
  const rfpResponse = await upload("/api/opportunities", "Mapleton-RFP.pdf", makePdf(sampleRfp), cookie, { title: "Mapleton platform" });
  assert.equal(rfpResponse.status, 200);
  const opportunity = await rfpResponse.json();
  const addStrong = await upload("/api/opportunities/" + opportunity.id + "/proposals", "Northstar-response.docx", makeDocx(strongProposal), cookie);
  const addWeak = await upload("/api/opportunities/" + opportunity.id + "/proposals", "Pinecone-response.pdf", makePdf(weakProposal), cookie);
  assert.equal(addStrong.status, 201);
  assert.equal(addWeak.status, 201);
  const analysis = await call("/api/opportunities/" + opportunity.id + "/analyze", { method: "POST", body: {}, cookie });
  assert.equal(analysis.status, 200);
  const result = await analysis.json();
  assert.equal(result.rankings.length, 2);
  assert.equal(result.rankings[0].vendor_name, "Northstar");
  assert.equal(result.rankings[0].score, 100);
  assert.equal(result.rankings[1].decision, "NO-BID");
  assert.match(result.rankings[0].requirements[0].proposal_quote, /8 years/);
  const detail = await call("/api/opportunities/" + opportunity.id, { cookie });
  const saved = await detail.json();
  assert.equal(saved.proposals.length, 2);
  assert.equal(saved.rankings[0].vendor_name, "Northstar");
  assert.match(saved.rfp_text, /5 years/);
  assert.equal(env.BUCKET.objects.size, 6);
});

test("reviewer overrides persist and rerank all proposals", async () => {
  const { cookie } = await register();
  const rfp = await (await upload("/api/opportunities", "Mapleton.pdf", makePdf(sampleRfp), cookie)).json();
  const proposal = await (await upload("/api/opportunities/" + rfp.id + "/proposals", "Northstar.txt", new TextEncoder().encode(strongProposal), cookie)).json();
  await (await upload("/api/opportunities/" + rfp.id + "/proposals", "Pinecone.txt", new TextEncoder().encode(weakProposal), cookie)).json();
  await call("/api/opportunities/" + rfp.id + "/analyze", { method: "POST", body: {}, cookie });
  let review;
  for (let index = 1; index <= 4; index++) {
    review = await call("/api/opportunities/" + rfp.id + "/proposals/" + proposal.id + "/review", { method: "PATCH", body: { requirement_id: "req-" + index, status: "GAP" }, cookie });
    assert.equal(review.status, 200);
  }
  const rankings = (await review.json()).rankings;
  assert.equal(rankings[0].vendor_name, "Pinecone");
  const detail = await call("/api/opportunities/" + rfp.id, { cookie });
  const saved = await detail.json();
  const revised = saved.proposals.find((item) => item.id === proposal.id);
  assert.equal(revised.analysis.requirements.every((item) => item.reviewer_override === "GAP"), true);
});

test("vendor names can be corrected without confusing them with the uploaded filename", async () => {
  const { cookie } = await register();
  const rfp = await (await upload("/api/opportunities", "Mapleton.txt", new TextEncoder().encode(sampleRfp), cookie)).json();
  const proposal = await (await upload("/api/opportunities/" + rfp.id + "/proposals", "response-final.txt", new TextEncoder().encode(strongProposal), cookie)).json();
  await call("/api/opportunities/" + rfp.id + "/analyze", { method: "POST", body: {}, cookie });
  const renamed = await call("/api/opportunities/" + rfp.id + "/proposals/" + proposal.id, {
    method: "PATCH", body: { vendor_name: "Northstar Learning" }, cookie,
  });
  assert.equal(renamed.status, 200);
  const detail = await call("/api/opportunities/" + rfp.id, { cookie });
  const current = await detail.json();
  assert.equal(current.proposals[0].vendor_name, "Northstar Learning");
  assert.equal(current.proposals[0].analysis, null);
  assert.equal(current.rankings.length, 0);
});

test("the labeled sample comparison creates three source-backed rankings once", async () => {
  const { cookie } = await register();
  const first = await call("/api/demo", { method: "POST", body: {}, cookie });
  assert.equal(first.status, 201);
  const firstData = await first.json();
  assert.equal(firstData.rankings.length, 3);
  assert.equal(firstData.rankings[0].vendor_name, "Northstar Learning");
  assert.equal(firstData.rankings[0].decision, "BID");
  assert.equal(firstData.rankings[1].decision, "NO-BID");
  assert.equal(firstData.already_added, false);
  const again = await call("/api/demo", { method: "POST", body: {}, cookie });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).already_added, true);
  const all = await call("/api/opportunities", { cookie });
  assert.equal((await all.json()).opportunities.length, 1);
});

test("company workspaces are isolated even when the same site is used", async () => {
  const { cookie: ownerCookie } = await register("owner@example.test");
  const rfp = await (await upload("/api/opportunities", "Mapleton.txt", new TextEncoder().encode(sampleRfp), ownerCookie)).json();
  const { cookie: otherCookie } = await register("other@example.test");
  const hidden = await call("/api/opportunities/" + rfp.id, { cookie: otherCookie });
  assert.equal(hidden.status, 404);
  const list = await call("/api/opportunities", { cookie: otherCookie });
  assert.deepEqual((await list.json()).opportunities, []);
});

test("comparison export includes rankings and source quotes", async () => {
  const { cookie } = await register();
  const rfp = await (await upload("/api/opportunities", "Mapleton.txt", new TextEncoder().encode(sampleRfp), cookie)).json();
  await upload("/api/opportunities/" + rfp.id + "/proposals", "Northstar.txt", new TextEncoder().encode(strongProposal), cookie);
  await call("/api/opportunities/" + rfp.id + "/analyze", { method: "POST", body: {}, cookie });
  const response = await call("/api/opportunities/" + rfp.id + "/export.csv", { cookie });
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.match(csv, /RFP source quote/);
  assert.match(csv, /Northstar/);
  assert.match(csv, /Vendor must provide at least 5 years/);
});

test("original cloud files can be downloaded and opportunity deletion removes associated objects", async () => {
  const { cookie } = await register();
  const rfp = await (await upload("/api/opportunities", "Mapleton.pdf", makePdf(sampleRfp), cookie)).json();
  const proposal = await (await upload("/api/opportunities/" + rfp.id + "/proposals", "Northstar.docx", makeDocx(strongProposal), cookie)).json();
  const download = await call("/api/opportunities/" + rfp.id + "/proposals/" + proposal.id + "/download", { cookie });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /Northstar.docx/);
  assert.match(await download.text(), /PK/);
  const before = env.BUCKET.objects.size;
  const deleted = await call("/api/opportunities/" + rfp.id, { method: "DELETE", cookie });
  assert.equal(deleted.status, 200);
  assert.equal(env.BUCKET.objects.size, before - 4);
  const gone = await call("/api/opportunities/" + rfp.id, { cookie });
  assert.equal(gone.status, 404);
});

test("CSV export cannot be used before analysis and proposal count is visible", async () => {
  const { cookie } = await register();
  const rfp = await (await upload("/api/opportunities", "Mapleton.txt", new TextEncoder().encode(sampleRfp), cookie)).json();
  const empty = await call("/api/opportunities/" + rfp.id + "/analyze", { method: "POST", body: {}, cookie });
  assert.equal(empty.status, 409);
  const exported = await call("/api/opportunities/" + rfp.id + "/export.csv", { cookie });
  assert.equal(exported.status, 409);
});

test("OCR-assisted PDF uploads retain their extraction method and compare against proposal text", async () => {
  const { cookie } = await register();
  const scannedPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Page /Resources << /XObject << /Image1 2 0 R >> >> >>\nendobj\n%%EOF", "latin1");
  const rfp = await (await upload("/api/opportunities", "Scanned-RFP.pdf", scannedPdf, cookie, {
    extracted_text: sampleRfp,
    extraction_method: "ocr",
  })).json();
  assert.equal(rfp.rfp_extraction_method, "ocr");
  const proposal = await (await upload("/api/opportunities/" + rfp.id + "/proposals", "Scanned-Northstar.pdf", scannedPdf, cookie, {
    extracted_text: strongProposal,
    extraction_method: "ocr",
  })).json();
  assert.equal(proposal.extraction_method, "ocr");
  const comparison = await call("/api/opportunities/" + rfp.id + "/analyze", { method: "POST", body: {}, cookie });
  assert.equal(comparison.status, 200);
  assert.equal((await comparison.json()).rankings[0].decision, "BID");
  const detail = await call("/api/opportunities/" + rfp.id, { cookie });
  const saved = await detail.json();
  assert.equal(saved.opportunity.rfp_extraction_method, "ocr");
  assert.equal(saved.proposals[0].extraction_method, "ocr");
  assert.match(saved.rankings[0].requirements[0].rfp_quote, /at least 5 years/);
});

test("PDF validation returns stable actionable errors instead of a generic OCR failure", async () => {
  const { cookie } = await register();
  const invalid = await upload("/api/opportunities", "not-a-pdf.pdf", Buffer.from("plain text"), cookie);
  assert.equal(invalid.status, 415);
  assert.equal((await invalid.json()).code, "INVALID_PDF");
  const scan = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF", "latin1");
  const needsOcr = await upload("/api/opportunities", "scan.pdf", scan, cookie);
  assert.equal(needsOcr.status, 422);
  assert.equal((await needsOcr.json()).code, "PDF_OCR_REQUIRED");
});

test("partial cloud writes and D1 batch failures roll back without orphaning or partial rankings", async () => {
  const { cookie } = await register();
  env.BUCKET.failOnPutNumber = 2;
  const failedRfp = await upload("/api/opportunities", "failed.txt", new TextEncoder().encode(sampleRfp), cookie);
  assert.equal(failedRfp.status, 500);
  assert.equal(env.BUCKET.objects.size, 0);
  env.BUCKET.failOnPutNumber = null;

  const rfp = await (await upload("/api/opportunities", "Mapleton.txt", new TextEncoder().encode(sampleRfp), cookie)).json();
  env.DB.failBatchAt = 2;
  const failedProposal = await upload("/api/opportunities/" + rfp.id + "/proposals", "Northstar.txt", new TextEncoder().encode(strongProposal), cookie);
  assert.equal(failedProposal.status, 500);
  let detail = await (await call("/api/opportunities/" + rfp.id, { cookie })).json();
  assert.equal(detail.proposals.length, 0);
  assert.equal(env.BUCKET.objects.size, 2);

  await upload("/api/opportunities/" + rfp.id + "/proposals", "Northstar.txt", new TextEncoder().encode(strongProposal), cookie);
  env.DB.failBatchAt = 2;
  const failedAnalysis = await call("/api/opportunities/" + rfp.id + "/analyze", { method: "POST", body: {}, cookie });
  assert.equal(failedAnalysis.status, 500);
  detail = await (await call("/api/opportunities/" + rfp.id, { cookie })).json();
  assert.equal(detail.opportunity.analyzed_at, null);
  assert.equal(detail.proposals[0].analysis, null);
  const retry = await call("/api/opportunities/" + rfp.id + "/analyze", { method: "POST", body: {}, cookie });
  assert.equal(retry.status, 200);
});

