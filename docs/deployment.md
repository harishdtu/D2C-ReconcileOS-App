# ReconcileOS deployment notes

## Current deployment state

No hosting platform, persistent filesystem, object store, or provider
credentials are configured in this workspace. Local development uses the
private `.data/imports/` directory unless S3-compatible storage is configured.
Production fails closed without complete S3 configuration. The server-only
storage adapter never exposes public object URLs; original files are retrieved
through `GET /api/imports/[batchId]/file`, which requires the Finance Executive
`MANAGE_IMPORTS` permission.

Before hosted deployment, configure a private S3-compatible bucket, public
access blocking, encryption, lifecycle/retention policy, and least-privilege
application credentials. No provider or credentials are provisioned in this
workspace. The S3 adapter is tested with a mocked client only.

## Environment configuration

Copy `.env.example` to `.env` for local work. Never commit `.env` or expose
server values with `NEXT_PUBLIC_` prefixes.

Required at runtime:

- `DATABASE_URL` — PostgreSQL application connection.

Required for local Prisma migration development:

- `SHADOW_DATABASE_URL` — separate empty shadow database; never point this at
  the application database.

Required only to seed the fictional demo users:

- `SEED_FINANCE_EXECUTIVE_EMAIL`
- `SEED_FINANCE_EXECUTIVE_PASSWORD`
- `SEED_COFOUNDER_EMAIL`
- `SEED_COFOUNDER_PASSWORD`

Optional AI mapping provider:

- `RECONCILEOS_MAPPING_AI_ENDPOINT` — HTTPS OpenAI-compatible chat-completions
  endpoint. Plain HTTP is accepted only for localhost development.
- `RECONCILEOS_MAPPING_AI_MODEL` — provider model name.
- `RECONCILEOS_MAPPING_AI_API_KEY` — server-only secret sent in the
  Authorization header.

Required in production for private import storage:

- `S3_BUCKET` — private bucket name.
- `S3_REGION` — bucket region.
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` — server-only credentials.
- `S3_ENDPOINT` — optional S3-compatible endpoint; omit for AWS S3.
- `S3_FORCE_PATH_STYLE` — optional; defaults to `true` for compatible providers.

When all S3 values are absent in development, import files remain on local
disk. Partial S3 configuration is rejected rather than silently falling back
to local storage.

The AI provider receives the import kind, source header names, and allowed
destination-field metadata only. It does not receive source rows, amounts, or
customer data. When the endpoint/model/key are absent or a provider request
fails, the UI explains that AI is unavailable and offers clearly labeled
deterministic header-alias suggestions. A real provider call must be verified
with an approved deployment credential before enabling that provider in a
review environment.

## Local verification and operation

```powershell
npm ci
npx prisma validate
npx prisma migrate deploy
npx prisma generate
npm run build
npm run start
```

Do not use `prisma migrate reset` against any database containing application
data. Provision a separate database for tests and previews. The 100,000-row
performance evidence is recorded in `docs/performance-review.md`; repeat that
benchmark on the actual deployment database and machine before making a
production performance claim.

## Release blockers and safeguards

- A private S3-compatible storage provider is not configured; production
  imports remain unavailable until credentials, bucket policies, and provider
  behavior are verified in the target environment.
- No live AI provider credential is configured; provider integration is
  covered with mocked API responses, while deterministic fallback remains
  operational.
- Configure and verify secure cookie/HTTPS behavior, database backups,
  restore procedures, log retention, and secret rotation in the chosen hosting
  platform before production use.
