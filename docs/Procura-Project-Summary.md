# Procura project handoff

## Live website

**Procura:** https://procura-vendor-review.gallantbottle.chatgpt.site

The public site provides the current cloud-hosted application. Create a company account there, then use that same account to sign in from other devices. The ZIP alongside this summary is the source and deployment package; it does not itself create a public cloud service.

## What the app does

Procura helps a company compare vendor proposals against its own RFP:

1. Create an opportunity and upload the RFP.
2. Add up to 20 vendor response documents for that opportunity.
3. Procura extracts requirements from the RFP and compares each vendor's proposal text against them.
4. Review a ranked vendor list and open each requirement to inspect its original RFP wording, proposal quote, match status, and explanation.
5. Change a match status after human review; the vendor score and ranking update.
6. Search opportunities, download originals, and export comparison evidence to CSV.

## File support and limits

- Supported formats: PDF, DOCX, TXT, MD, and CSV.
- Maximum upload size is 15 MB per file; up to 20 proposal files can be attached to one opportunity.
- Selectable PDF text is extracted in the browser. Scanned or image-only PDFs use browser-based English OCR (Tesseract.js) before the original PDF and extracted text are uploaded.
- OCR supports up to 60 scanned pages per file and the reader processes at most 300 pages per file. Password-protected PDFs must be unlocked. The PDF reader and OCR engine load from pinned public CDNs, so first use needs an internet connection.
- DOCX extraction includes document body text, tables, headers, and footers.

OCR quality depends on scan quality. Review extracted text and source quotes before relying on a comparison.

## How comparison and ranking work

- Requirements are derived from labeled lists, bullet lists, and sentences that express a need in the uploaded RFP; there is no fixed test-case requirements list.
- Proposal content is split into passages. Deterministic term matching, explicit denial detection, and numeric checks are used to assign VERIFIED, PARTIAL, or GAP status.
- Numeric checks cover stated experience years, uptime, delivery days, user or student capacity, and pricing thresholds when comparable figures appear in both documents.
- VERIFIED earns all of a requirement's weight, PARTIAL earns half, and GAP earns none. Mandatory requirements carry more weight; commercial requirements receive an additional weight adjustment.
- Any failed or incomplete hard gate yields NO-BID. With all hard gates passed, 75% or higher is BID, 50%–74.9% is BID WITH CONDITIONS, and below 50% is NO-BID.
- Vendors are ordered by hard gates passed, then weighted score. Each result keeps its source evidence visible.

This is a transparent text-matching aid. It does not infer award probability or replace procurement, legal, accessibility, security, or contract review. Similar wording, ambiguous requirements, and poor OCR can affect its matches.

## Cloud, accounts, and security

- The hosted application uses a Cloudflare Worker API, D1 for account and opportunity records, and R2 for original documents and extracted text.
- Records are scoped to each company account. The same account can have separate sessions on multiple devices; sessions last 14 days per device.
- Passwords are stored as salted PBKDF2-HMAC-SHA-256 verifiers with 100,000 iterations. Session cookies are HttpOnly and Secure on HTTPS, and sign-out revokes the current session.
- Login attempts are rate limited. The prototype does not currently provide email verification, password reset, MFA, or organization invitations.
- Review hosting, retention, and compliance requirements before storing confidential or regulated documents.

## Verification performed

**Automated backend suite: 23 passed, 0 failed.** Coverage includes account creation and duplicate emails, additional device sessions, sign-out, login throttling, account isolation, PDF/DOCX handling, OCR handoff and invalid-PDF errors, multi-vendor scoring and ranking, reviewer overrides, CSV export, downloads and deletion, and cleanup/transaction behavior after failed writes.

**Local browser QA:** synthetic scanned PDFs were uploaded for both an RFP and vendor proposals. OCR extracted text, a strong vendor ranked above a weak vendor, a reviewer override changed the decision and resetting it restored automatic scoring, and CSV export contained the vendor evidence rows. Search, profile/sign-out, reload persistence in the mock workspace, and malformed-PDF cancel/retry flows were also exercised.

**Live test:** the public landing and sign-in pages loaded, `/health` reported the service, database, and file store as healthy, and a synthetic Charlotte parking RFP plus five vendor proposal PDFs uploaded, extracted, and compared successfully. The test created a dedicated smoke-test account and opportunity in the cloud workspace and left them in place. No real customer credentials or customer records were used. This test confirms the supplied file set worked at that time, not that every possible PDF or proposal will work.

## Run and host the source

The release ZIP includes the complete Worker and frontend source, SQL migrations, build output, tests, this summary, and the updated hackathon presentation. It excludes Git history, credentials, and QA fixtures.

Requires Node.js 22 or later. From the extracted project directory:

```text
npm test
npm run build
npm run validate
```

The included `.openai/hosting.json` identifies the configured Sites project and its D1/R2 binding names. Publishing requires an authorized Sites hosting environment with those cloud resources; opening the ZIP in Chrome does not provision cloud login or storage. For immediate access from any device, use the live HTTPS site above.
