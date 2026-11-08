# Procura backend architecture

This note explains the backend layout and the data path in the current Procura application.

## Repository layout

| Path | Purpose |
| --- | --- |
| `worker/index.js` | HTTP routes, sessions, authorization, uploads, cloud reads/writes, and exports |
| `worker/analysis.js` | RFP requirement extraction, proposal evidence matching, scores, and vendor order |
| `worker/extract.js` | Server-side text cleanup and PDF/DOCX extraction and validation |
| `worker/page.js` | Browser UI served by the Worker, including upload/OCR preparation and API calls |
| `drizzle/` | Versioned D1 SQL schema migrations |
| `tests/procura.test.mjs` | Automated API and matching tests using synthetic documents and mock storage |
| `scripts/` | Build, artifact validation, Cloudflare resource setup, and post-deploy health check |
| `.github/workflows/` | GitHub Actions verification and optional Cloudflare deployment workflows |
| `docs/` | Project handoff and backend architecture notes |

## Request and document flow

1. A person registers or signs in through the browser.
2. The Worker validates the request and verifies the account session.
3. The browser prepares PDF text. It uses OCR for image-only scanned pages. DOCX, TXT, MD, and CSV are also supported.
4. The Worker checks file type, size, and extracted text, then stores the original document and extracted text in R2.
5. D1 stores the company account, opportunity, proposal metadata, storage keys, reviewer overrides, and saved comparison results.
6. The compare route reads the RFP and every proposal, extracts a shared requirement list, evaluates each proposal, and saves results.
7. The UI shows ordered vendors with source quotes and allows a reviewer to change a status, download source files, or export CSV evidence.

## Ranking rules

- `VERIFIED` earns the full requirement weight, `PARTIAL` earns half, and `GAP` earns zero.
- Mandatory requirements have higher weight. Commercial requirements have an additional adjustment.
- A failed or incomplete hard gate produces `NO-BID`.
- When hard gates pass, scores of at least 75% yield `BID`, 50% through 74.9% yield `BID WITH CONDITIONS`, and lower scores yield `NO-BID`.
- Vendors sort by hard-gate fit, then weighted score, then detected total price, go-live time, and vendor name.
- These are deterministic text and numeric checks. They do not estimate award probability.

## Account and storage design

Passwords use salted PBKDF2-HMAC-SHA-256 verifiers with 100,000 iterations. Sessions use random bearer tokens in HttpOnly cookies; D1 stores token hashes and expiry timestamps. Protected data queries include the owning account ID. Login attempts are throttled and cross-origin writes are rejected.

D1 stores structured application data. R2 stores original files and extracted text. When a multi-step write fails, the Worker attempts cleanup to reduce orphaned objects or partial state. Migrations in `drizzle/` define the database schema.

## Deployment and verification

GitHub Actions runs `npm test`, `npm run build`, and `npm run validate`. When Cloudflare repository secrets are present, the deploy workflow provisions or reuses D1/R2, applies migrations, deploys the Worker, and checks `/health`.

Do not add credentials, `.env` files, live database exports, account data, or real uploaded documents to the repository. The included automated test cases generate synthetic document contents in code. The live Charlotte sample run is documented as a QA event; the source PDFs and cloud account data are not committed here.

## Prototype limits

The application does not currently include email verification, password reset, multi-factor authentication, or organization invitations. OCR depends on scan quality and public CDN availability. Review extracted text and source passages before relying on a match.
