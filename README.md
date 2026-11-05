# ReconcileOS

ReconcileOS is a finance operations workspace for a D2C brand to import orders,
partner settlements, COD remittances, and freight invoices; reconcile expected
and received amounts; and review evidenced exceptions.

## Product capabilities

- Role-protected finance operations for Finance Executive and read-only
  Co-founder accounts.
- Dashboard totals and operational activity from persisted PostgreSQL data.
- CSV/XLSX imports with validation, preview, duplicate handling, mapping
  review, and PostgreSQL `COPY`-based order ingestion.
- Deterministic reconciliation of orders and financial records with
  explainable results, exceptions, and missing-order match suggestions that
  require an authorized human decision.
- Claims/returns workflows, audit history, and private original-file retrieval.
- Optional provider-backed mapping suggestions; AI output is validated and
  never approved automatically. Deterministic mapping remains available when
  the provider is not configured.

## Local setup

1. Install Node.js/npm and PostgreSQL.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to a dedicated local
   database. Keep `.env` private and untracked.
3. Install dependencies and apply existing migrations:

   ```powershell
   npm ci
   npx prisma validate
   npx prisma migrate deploy
   npx prisma generate
   ```

4. To create fictional demo records, set the four `SEED_*` variables in `.env`
   and run `npm run db:seed`.
5. Start the development server with `npm run dev`, then open
   `http://localhost:3000`.

The Finance Executive can manage imports and reconciliation. The Co-founder
role is read-only. There is no public registration flow.

## Demo accounts

There are no shared or hardcoded demo passwords. To seed fictional users in a
local or disposable database, set `SEED_FINANCE_EXECUTIVE_EMAIL`,
`SEED_FINANCE_EXECUTIVE_PASSWORD`, `SEED_COFOUNDER_EMAIL`, and
`SEED_COFOUNDER_PASSWORD` in the ignored `.env` file, then run `npm run db:seed`.
Choose strong local-only passwords; do not use these accounts in production.

## AI mapping suggestions

Set `RECONCILEOS_MAPPING_AI_ENDPOINT`, `RECONCILEOS_MAPPING_AI_MODEL`, and
`RECONCILEOS_MAPPING_AI_API_KEY` on the server to enable a compatible provider.
The key is never sent to the browser. The service sends column headers and
allowed field metadata only, validates structured suggestions, and requires
human review before import. Without a configured or available provider, the
mapping screen explains the outage and offers deterministic header aliases.

## Validation

```powershell
npx prisma validate
npx tsc --noEmit
npm test
npm run lint
npm run build
```

The latest recorded local benchmark imported 100,000 fictional orders in
38.185 s, 44.091 s, and 42.394 s across three measured trials (42.394 s
median); reconciliation took 71.662 s, 81.084 s, and 65.602 s (71.662 s
median). This was a local Windows/PostgreSQL benchmark, not hosted performance
evidence. The import target under 60 s passed in each measured trial; see
[the benchmark report](./docs/performance-review.md) for methodology and
integrity checks.

See [the architecture](./docs/architecture.md), [deployment guide](./deployment.md),
[technical design document](./docs/technical-design-document.md),
[the Milestone 5 gap audit](./docs/final-gap-audit.md), and
[final verification](./docs/final-verification.md).

## Important storage limitation

In local development with S3 settings absent, uploaded files use the private
`.data/imports/` directory. A server-only S3-compatible adapter is implemented;
production fails closed without complete S3 configuration. A real bucket and
post-redeployment durability test have not been configured or verified. See
the [deployment guide](./deployment.md).
