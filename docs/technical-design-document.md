# ReconcileOS Technical Design Document

## 1. Purpose and status

ReconcileOS is a finance-operations workspace for importing D2C order and
partner financial data, comparing expected with received amounts, and
investigating evidenced exceptions. This document describes the implementation
in this repository, not a proposed or deployed production system.

The public repository URL is
<https://github.com/harishdtu/D2C-ReconcileOS-App>. The application is **not
deployed**; its deployed URL is unavailable/TBD. The latest recorded local
verification passed Prisma validation, TypeScript checking, ESLint, a
production build, and the PostgreSQL-backed test suite (10 files, 43 tests),
including mocked S3 storage tests. See
[final verification](./final-verification.md).

## 2. Architecture

The application is a Next.js App Router application using TypeScript, React,
server-rendered operational pages, and server-side API/service boundaries.
PostgreSQL is the system of record, accessed through Prisma for relational
operations and PostgreSQL-specific SQL where bulk ingestion requires it.
Business logic lives in server-side services rather than UI components.

The main data flow is:

1. An authorized user uploads an order, settlement, COD-remittance,
   freight-invoice, return-receipt, or refund file.
2. The import service records file metadata and a content hash and parses CSV
   or XLSX data. In local development, originals use `.data/imports/` when S3
   settings are absent; when configured, the server-only storage adapter stores
   originals in a private S3-compatible bucket. Production fails closed if S3
   configuration is absent or partial. The user maps source columns, inspects
   a 20-row preview, and approves the mapping before processing.
3. Validated data is normalized into orders or financial records and staged
   import rows. Import state, validation outcomes, duplicate counts, and row
   provenance are persisted.
4. A reconciliation run evaluates orders and supported financial records
   against applicable effective-dated rate cards. Results, linked
   transactions, exceptions, and claims are persisted with explanations and
   audit events.
5. Authorized users review results, candidate matches, exceptions, and claim
   evidence in the operations UI.

Operational pages and APIs query the database on the server and apply
authorization checks. The product is currently a single-workspace application;
multi-tenant administration is not implemented. No queue or separate worker
is present in the current import flow.

## 3. Persistence and schema

The Prisma schema maps PostgreSQL tables to the domain. UUID primary keys,
foreign keys, unique constraints, indexes, enums, and migration-defined
database constraints protect persisted state. Money is stored in
`NUMERIC`/Prisma `Decimal`, not binary floating point. Core model groups are:

| Domain | Models and purpose |
|---|---|
| Identity and authorization | `User`, `Session`, and `LoginRateLimit`; finance executive and co-founder roles. |
| Partners and imports | `Partner`, `ImportSource`, `ImportBatch`, and `ImportRow`; source identity, file metadata, processing state, and row provenance. |
| Mapping | `MappingVersion` and `MappingSuggestion`; approved, versioned mappings and separately recorded advisory proposals. |
| Orders and money | `Order` and `FinancialTransaction`; channel order keys, gross/fee/tax/net amounts, currency, dates, source references, and deduplication keys. |
| Rate evaluation | `RateCard` and `RateCardComponent`; versioned effective periods and percentage, flat-per-order, or weight-slab components. |
| Reconciliation | `ReconciliationRun`, `ReconciliationResult`, and `ReconciliationTransaction`; run inputs/version, calculated outcomes, and links to compared transactions. |
| Follow-up | `ReconciliationException`, `Claim`, and `AuditLog`; exception lifecycle, claim/evidence snapshots, and recorded actions. |
| Additional supported inputs | `ReturnReceipt`, `Refund`, and `MatchSuggestion`; imported return/refund data and human-reviewed missing-order candidates. |

Important integrity constraints include unique channel-partner/order IDs,
unique source/content-hash imports, unique batch/row numbers, unique
source/deduplication keys for financial transactions, and one result per
order/run. Foreign keys generally restrict deletion of financial evidence.
Historical runs and their evidence are retained rather than silently
overwritten.

Original files are not stored in PostgreSQL. Import metadata stores an
opaque content-hash-based object key. S3 objects are downloaded to a unique
temporary working file only while parsing or processing and that file is
removed in a `finally` path. The Finance Executive-only file endpoint returns
the original as a `private, no-store` attachment; it does not issue presigned
or public URLs. Provider errors return a generic API failure rather than
provider detail. The included storage tests mock S3 and exercise denied
Co-Founder access, successful private download, cleanup, configuration
failure, and provider error handling. A real bucket, policy, upload, download,
or post-redeployment recovery remains unverified.

## 4. Import and reconciliation behavior

Imports support CSV and XLSX. Source mappings are versioned and associated
with an approver. Validation outcomes and normalized data are recorded per
row; previews are limited to 20 rows. Existing content hashes, partner/order
uniqueness, and transaction deduplication keys support idempotency and
duplicate recognition.

Order ingestion uses PostgreSQL `COPY` to stream bounded 500-row groups into a
temporary staging table, followed by set-based insertion with
`ON CONFLICT DO NOTHING`. Corresponding masked import-row records are also
streamed with `COPY`. Durable writes for each chunk are transactional; a
failed chunk rolls back together. The schema constraints and validation
remain enabled.

The reconciliation runner processes orders in 2,000-order pages. It fetches
orders and associated transactions/return/refund records, applicable rate-card
candidates, and existing results needed for safe resume. Results, links,
exceptions, and claims are written in a page transaction. It then records
unmatched-transaction exceptions and completes the run/audit state. An input
fingerprint makes repeat runs identifiable and idempotent; results record the
rules version, rate-card reference where applicable, reason codes, and
explanation.

The amount difference is `received net amount - expected net amount`. A
difference of -₹10 or greater is not itself a claim; a difference below -₹10
is a shortfall candidate for review. A past-due outcome requires relevant
dates and configured settlement terms; missing terms do not produce an
invented due date. Fee overcharges are based on billed charges against the
applicable rate-card amount. TCS and TDS are tracked separately from
recoverable leakage. Claims are reviewable; no claim is filed automatically.

## 5. Matching and AI boundaries

Core matching and financial calculations are deterministic. Exact order and
partner references are preferred; duplicate detection and split/partial
remittance handling depend on source-supported relationships. Missing or
ambiguous references are not treated as exact matches.

Missing-order candidate generation uses exact currency, a 30-day
order-to-transaction window, exact source-reference and amount signals, and a
comparable channel-partner signal when available. Competing candidates are
shown together; candidate sets exceeding 200 for a transaction are withheld
as too ambiguous. Only an authorized, explicit human decision can link one
transaction. Accepting a candidate is audited and does not resolve its
exception; changed links result in a new reconciliation run.

The optional AI integration is limited to column-mapping suggestions. When
configured, it sends the import kind, source header names, and allowed
destination-field metadata to a server-side OpenAI-compatible endpoint. It
does not send source rows, amounts, or customer data. Suggestions are
schema-validated, remain distinct from approved mappings, and require human
review and explicit import approval. Missing credentials or provider failures
fall back to clearly labeled deterministic header aliases. No live AI provider
credential is configured or verified in the current workspace.

## 6. Security and privacy

- Passwords are bcrypt-hashed. Sessions use random opaque tokens; only
  SHA-256 token hashes are persisted. Sessions expire after 12 hours.
- The `reconcileos_session` cookie is `HttpOnly`, `SameSite=Lax`, path `/`,
  expires with the session, and sets `Secure` when `NODE_ENV` is `production`.
- Authorization and request validation are enforced on the server. Finance
  executives can perform operational actions; co-founders have read-only
  oversight. There is no public registration flow.
- Login attempts are rate-limited per normalized account identifier.
- Customer names, phone numbers, and addresses are not displayed. Import
  previews and staged source rows use masking where applicable. AI receives
  headers and field metadata only.
- Environment secrets are server-side and `.env` is ignored by Git. S3
  credentials are read only by the server-side adapter. The local filesystem
  fallback is development-only; production requires complete S3 configuration
  and fails closed otherwise. Private bucket policy, encryption, lifecycle
  rules, and deployed object access still require provider-side configuration
  and verification.

These are implementation safeguards, not a claim of a formal security audit,
production hardening, or deployment review.

## 7. Performance evidence and trade-offs

The recorded 100,000-row benchmark was run against a local development
database on Windows x64, Node.js 24.16.0, PostgreSQL 18.6, and a Ryzen 5
3500U. Three measured import times were 38.185, 44.091, and 42.394 seconds
(median 42.394 seconds); each completed under the 60-second target. Each
trial also checked accepted/rejected/duplicate counts, persisted row and order
counts, exact Decimal totals, reconciliation result count, idempotent replay,
and per-trial cleanup. These measurements do not predict hosted performance.
Reconciliation times for the measured runs were 71.662, 81.084, and 65.602
seconds; a sub-60-second reconciliation target is not claimed.

The performance investigation found per-page transaction and repeated
rate-card discovery, result-resume lookup, JavaScript matching, and Decimal
work in reconciliation. Bulk COPY reduced import time. Database constraints,
indexes, foreign-key checks, audit evidence, and transactions were retained
because they enforce correctness. The benchmark was not run on an isolated
database, and PostgreSQL `pg_stat_statements` was unavailable, limiting
server-side attribution.

## 8. Limitations and open deployment work

- The S3-compatible adapter is implemented and mocked in unit tests, but no
  real bucket, production credentials, policy, real file-access test, or
  persistence-across-redeployment test is configured. Until those are
  verified, hosted file durability is not established.
- There is no hosting account or public deployment URL configured.
- The application has no asynchronous queue/worker. Large imports use a
  buffered upload and synchronous processing path; the local benchmark does
  not establish compatibility with serverless request-duration or memory
  limits.
- No live AI provider request has been verified. Deterministic fallback is
  available.
- The rate-card schema and evaluation exist, but there is no rate-card
  management service/API or UI.
- Return/refund workflows depend on supplied input data; there is no warehouse
  scan integration. TCS/TDS are kept distinct but expanded tax reporting and
  tax filing are not provided.
- Populated candidate decisions were not exercised in browser QA, and no
  formal accessibility review was performed. These limits are recorded in
  [the gap audit](./final-gap-audit.md).
- No deployment, hosting, storage, backup/restore process, or production
  secret rotation has been configured or verified.

## 9. Evidence references

- [Architecture and product behavior](./architecture.md)
- [Schema](../prisma/schema.prisma)
- [Performance review and benchmark methodology](./performance-review.md)
- [Final verification](./final-verification.md)
- [Final gap audit](./final-gap-audit.md)
