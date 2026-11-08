# Procura V2

Procura V2 is an isolated redesign of the Procura RFP and vendor proposal review application. It reuses the current backend behavior while deploying to its own Cloudflare Worker, D1 database, and R2 bucket.

## Preview

The V2 branch deploys to https://procura-v2.<account-subdomain>.workers.dev. The workflow summary reports the exact URL after deployment.

The current Procura deployment and its data remain unchanged. V2 starts with an empty database; accounts and uploads do not transfer between versions. Use the original app for existing records.

## Product workflow

1. Register a company workspace and sign in.
2. Upload an RFP in PDF, DOCX, TXT, MD, or CSV format.
3. Add one or more vendor proposals.
4. Compare proposal evidence against requirements extracted from the RFP.
5. Inspect ranked vendors, source quotes, coverage, hard-gate gaps, and reviewer overrides.
6. Download documents or export the comparison as CSV.

## Development

Requires Node.js 22 or later. Run npm test, npm run build, and npm run validate.

Deployments run from the private GitHub branch procura-v2. That branch uses the existing CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN repository secrets, while provisioning resources named procura-v2-db, procura-v2-files, and procura-v2.

The redesign keeps the analysis and ranking rules unchanged. Its product-tour figures are explicitly illustrative. Confirmed vendor decisions remain source-linked and require human review.
