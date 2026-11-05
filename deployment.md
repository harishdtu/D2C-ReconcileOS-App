# Deployment and Local Setup

## Deployment status

The application has **not been deployed**. Hosting, production database and
object-storage resources, provider credentials, and a public application URL
are not configured. Private S3-compatible storage support is implemented and
tested with a mocked provider, but no real bucket upload or redeployment
recovery test has been performed.

- Public repository: <https://github.com/harishdtu/D2C-ReconcileOS-App>
- Deployed application URL: **Unavailable / TBD — not deployed**

The deployment architecture below is a recommendation, not a description of
provisioned resources.

## Recommended hosted architecture

For a future hosted deployment, use Vercel for the Next.js application, Neon
PostgreSQL for relational data, and a private S3 bucket for original imports.
Keep the bucket private, block public access, enable encryption, apply a
documented retention/lifecycle policy, and grant the application only the
minimum required object permissions. Store object keys in import metadata and
access originals through a server-only storage adapter; do not expose public
object URLs or credentials to the browser.

The application uses `.data/imports/` only for local development when all S3
settings are absent. In production, missing or partial S3 configuration fails
closed rather than falling back to ephemeral disk. The server-only adapter
supports S3 object upload and private reads. Original-file download uses
`GET /api/imports/[batchId]/file`, which requires the server-side
`MANAGE_IMPORTS` permission and returns `private, no-store` attachment
responses. No bucket policy, encryption configuration, or real-provider
durability test is included here.

The current import route buffers files up to 50 MB and processes them
synchronously; large-file behavior must be tested against Vercel function
memory and duration limits. If those limits are unsuitable, move processing
to a durable asynchronous worker before production use.

The bulk order-import path uses PostgreSQL `COPY` through a `pg` connection.
Choose a Neon connection URL that supports this protocol and validate the
connection/pooling behavior, connection limits, and transaction duration in a
staging environment. The local benchmark is not evidence of hosted
performance.

## Local setup

Prerequisites: Node.js/npm and a dedicated PostgreSQL database for local
development.

1. Copy `.env.example` to `.env` and set private values locally. Do not commit
   `.env` or paste secret values into this document.
2. Configure these existing environment variable names:

   - `DATABASE_URL`
   - `SHADOW_DATABASE_URL` (a separate empty database for Prisma migration
     development; never point it at the application database)
   - `SEED_FINANCE_EXECUTIVE_EMAIL`
   - `SEED_FINANCE_EXECUTIVE_PASSWORD`
   - `SEED_COFOUNDER_EMAIL`
   - `SEED_COFOUNDER_PASSWORD`
   - `RECONCILEOS_MAPPING_AI_ENDPOINT` (optional)
   - `RECONCILEOS_MAPPING_AI_MODEL` (optional)
   - `RECONCILEOS_MAPPING_AI_API_KEY` (optional, server-only)
   - `S3_BUCKET` (optional locally; required in production)
   - `S3_REGION` (required with S3 storage)
   - `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (server-only)
   - `S3_ENDPOINT` (optional S3-compatible endpoint; omit for AWS S3; HTTPS in
     production, HTTP only for a local development endpoint)
   - `S3_FORCE_PATH_STYLE` (optional; defaults to path-style requests)

   Seed variables are needed only when creating the fictional demo users. Use
   unique, strong passwords and do not use demo identities as production
   accounts. AI configuration is optional; without it, deterministic mapping
   suggestions remain available. When all S3 variables are absent in
   development, the ignored local `.data/imports/` directory is used. Partial
   S3 configuration is an error.
3. Install dependencies, validate the schema, apply existing migrations, and
   generate the client:

   ```powershell
   npm ci
   npx prisma validate
   npx prisma migrate deploy
   npx prisma generate
   ```

4. To create fictional demo records in a disposable/local database only, set
   the four seed variables above and run:

   ```powershell
   npm run db:seed
   ```

5. Start the development server and open `http://localhost:3000`:

   ```powershell
   npm run dev
   ```

## Safe Prisma migration procedure

1. Review the schema and generated migration SQL. Keep migrations in source
   control; do not use `prisma db push` or `prisma migrate reset` on any
   database containing data.
2. Back up the target database and verify the restore procedure. Apply the
   migration first to an isolated staging database containing a
   representative schema/data snapshot.
3. Run `npx prisma migrate status` and `npx prisma migrate deploy` once from a
   controlled release/migration job using the production database
   configuration. Do not have every Vercel build or application instance
   race to apply migrations.
4. Prefer additive expand/contract changes for schema evolution: deploy
   compatible columns/tables first, deploy code that uses them, backfill and
   verify, then remove obsolete structures in a later migration.
5. Verify migration status, application health, and critical read/write flows.
   If a migration or release fails, stop further rollout and use the reviewed
   restore/recovery plan; do not assume schema rollback is automatic.

For local schema authoring, use the repository's `npm run db:migrate`
(`prisma migrate dev`) against the dedicated local database and a separate
empty `SHADOW_DATABASE_URL`. Commit the resulting migration and use
`migrate deploy` for staging/production application.

## Cookie and transport security

The current application sets the `reconcileos_session` cookie as `HttpOnly`,
`SameSite=Lax`, path `/`, and expires it with the 12-hour server-side session.
The `Secure` flag is enabled when `NODE_ENV` is `production`. Keep production
traffic on HTTPS, terminate TLS at the hosting edge, ensure production runs
with `NODE_ENV=production`, and verify the cookie flags in browser developer
tools after deployment. Do not weaken cookie settings to work around an
incorrect HTTP/proxy setup. Sessions store only a hash of the random opaque
token in PostgreSQL.

## Deployment and verification checklist

Deployment has not been performed. When provider access and resources are
available:

1. Provision isolated staging and production Neon databases, the Vercel
   project, and a private S3 bucket. Keep staging and production data and
   credentials separate. Block public bucket access, enable encryption at
   rest, use a lifecycle/retention policy appropriate for financial evidence,
   and issue a least-privilege application key limited to the bucket and
   required object actions. Do not configure public ACLs.
2. Configure Vercel runtime environment variables by name only:
   `DATABASE_URL`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, and
   `S3_SECRET_ACCESS_KEY`; add `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` only for
   compatible providers, and optional `RECONCILEOS_MAPPING_AI_*` variables
   only after provider approval. The isolated migration job also requires
   `DATABASE_URL` and `SHADOW_DATABASE_URL` because the repository's Prisma
   config loads both. Do not put demo seed credentials in production unless
   seeding a disposable demo environment is explicitly intended. Never use
   `NEXT_PUBLIC_` for secrets.
3. Configure and apply versioned Prisma migrations to staging and production
   using the safe procedure
   above, and verify login/logout, role boundaries, imports and reprocessing,
   reconciliation idempotency, claims/evidence, exports, audit history, and
   storage persistence across a redeploy. Verify that Co-Founder accounts
   cannot retrieve original files, while Finance Executives can download the
   expected file. Run a synthetic upload/download test using a dedicated
   fixture; remove only that fixture after verifying retrieval after redeploy.
4. Run the existing automated checks in the target release workflow:

   ```powershell
   npx prisma validate
   npx tsc --noEmit
   npm test
   npm run lint
   npm run build
   ```

   The latest recorded local run passed all five checks; `npm test` passed 10
   files and 43 tests, including PostgreSQL-backed integration tests and
   mocked storage tests. Run
   tests against a dedicated test database, never production.
5. Repeat the 100,000-row benchmark on representative hosted infrastructure,
   verify memory/time limits and COPY connectivity, check backup/restore and
   retention behavior, then review HTTPS cookie flags and production logs
   before considering release.

## Known blockers and unverified items

- No deployment has been made; there is no deployed URL.
- The private S3-compatible adapter is implemented, but no real storage
  provider, bucket policy, credentials, or cross-redeploy access test is
  configured. Production imports are not verified.
- Vercel function limits may not accommodate the current buffered,
  synchronous import of large files; this is unverified. A worker may be
  required.
- No ReconcileOS Neon project, Vercel project/authentication, or S3 resource/
  account is configured or tested here.
- No production credentials, live AI provider call, or hosted migration has
  been verified.
- The benchmark was run on local development infrastructure. Its import
  timings do not guarantee Vercel/Neon performance; measured reconciliation
  exceeded 60 seconds.
- Formal accessibility review and populated candidate-decision browser QA
  remain incomplete.
