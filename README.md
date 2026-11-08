# Procura Cloud

Procura compares a company's RFP with multiple vendor proposals, shows source evidence for each requirement, and ranks the vendors by hard-gate fit and weighted coverage.

## Use Procura from any device

Open the live cloud application: https://procura-vendor-review.gallantbottle.chatgpt.site

Create a company account, then sign into that same account from another browser or device. Cloudflare D1 stores account and opportunity records; Cloudflare R2 stores original documents and extracted text. Company records are isolated by account.

The release ZIP is source and deployment material. It does not provision a cloud host when opened in Chrome; use the live HTTPS URL for a shared cross-device service.

## Procurement workflow

1. Create an opportunity and upload its RFP.
2. Upload up to 20 vendor proposals.
3. Compare each proposal against requirements extracted from that RFP.
4. Review ranked vendors and inspect each RFP quote, proposal quote, status, and explanation.
5. Change a status when human review finds a better interpretation; scores and ranks recalculate.
6. Search opportunities, download original documents, or export comparison evidence as CSV.

## Files and extraction

Supported formats are PDF, DOCX, TXT, MD, and CSV. Files are limited to 15 MB each. Selectable PDF text is extracted in the browser. Image-only scanned PDFs use browser-based English OCR before upload; the original PDF and extracted text are saved to the cloud workspace. OCR supports up to 60 scanned pages per file, and PDF processing is limited to 300 pages per file. Password-protected PDFs must be unlocked or split. The PDF.js reader and Tesseract.js OCR engine load from pinned public CDNs, so first use needs an internet connection. DOCX extraction includes body text, tables, headers, and footers.

## Scoring

- Requirements are derived from labeled lists, bullets, and sentences expressing a need in the RFP.
- Deterministic term matching, explicit denial detection, and numeric checks produce VERIFIED, PARTIAL, or GAP results with proposal source quotes.
- Numeric checks cover experience years, uptime, delivery days, user/student capacity, and pricing when both documents provide relevant figures.
- VERIFIED earns full weight, PARTIAL half weight, and GAP zero. Mandatory requirements carry higher weight; commercial requirements receive an added weight adjustment.
- A failed or incomplete hard gate yields NO-BID. If all hard gates pass, scores of at least 75% yield BID, 50%–74.9% yield BID WITH CONDITIONS, and lower scores yield NO-BID.
- Vendors sort by hard-gate fit, then weighted score. A reviewer can override statuses and rerank.

The method is a transparent text-matching aid, not an award prediction or substitute for procurement, legal, accessibility, or security review. Inspect source quotes and OCR text before relying on a result.

## Account security and known limits

Passwords are stored as salted PBKDF2-HMAC-SHA-256 verifiers with 100,000 iterations. Session tokens are random, HttpOnly cookies stored in hashed form; sessions last 14 days per device. Login attempts are rate limited. The prototype does not include email verification, password reset, MFA, or organization invitations. Review hosting, retention, and compliance requirements before uploading confidential or regulated records.

## Development and verification

Requires Node.js 22 or later:

```text
npm test
npm run build
npm run validate
```

The current automated suite has 22 passing tests. See `docs/Procura-Project-Summary.md` for the QA scope, production smoke-check results, deployment details, and limitations. The updated hackathon deck is included with the separate project release materials.

## Hosting on your Cloudflare account

The GitHub repository includes a Cloudflare Workers deployment workflow. Each push to `main` runs the checks; once the Cloudflare secrets are present, the workflow creates or reuses a D1 database and R2 bucket, applies the SQL migrations, deploys the Worker, and checks `/health`. The public `workers.dev` URL appears in the GitHub Actions run summary.

Before the first deployment, add these **repository secrets** in GitHub under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_ACCOUNT_ID`: the account ID shown in Cloudflare Workers & Pages.
- `CLOUDFLARE_API_TOKEN`: an account-scoped Cloudflare API token with Workers Scripts Write, D1 Write, and Workers R2 Storage Write access. Keep the token in GitHub Secrets; do not commit it or paste it into chat.

Run **Actions → Deploy Procura to Cloudflare → Run workflow** after saving the secrets. Future pushes to `main` deploy automatically. The workflow provisions an account-specific Procura D1 database and R2 bucket; if the account has no `workers.dev` subdomain, it requests a project-specific one.

This creates new storage in your Cloudflare account. Existing accounts, opportunities, and uploads from the current managed host do not copy over automatically. Keep using the current live site until you verify the Cloudflare deployment; users will need to create accounts on the new host unless data is migrated separately. The `.openai/hosting.json` file remains for the existing Sites-hosted copy.

See Cloudflare's [GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [D1 migration commands](https://developers.cloudflare.com/d1/wrangler-commands/), and [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

## Main files

- `worker/index.js`: API, authentication, cloud records, uploads, and HTTP routes
- `worker/page.js`: landing page, sign-in, dashboard, upload, ranking, and review UI
- `worker/extract.js`: PDF/DOCX text handling
- `worker/analysis.js`: requirement extraction, matching, scoring, and ranking
- `drizzle/`: D1 schema migrations, including PDF extraction metadata
- `tests/procura.test.mjs`: automated API and analysis tests
- `scripts/`: build and release validation scripts
- `dist/`: packaged deployment output

