# ReconcileOS — Milestone 1: Requirements and Architecture

## Status

Requirements and architecture are defined from the supplied Company A brief.
The workspace was empty at inspection time; no existing application, framework,
or behavior needs to be preserved. This document is the milestone-1 baseline.

Milestone 4 adds a responsive authenticated operations workspace backed by
server-guarded APIs and PostgreSQL queries. The core dashboard, import/mapping
workflow, order ledger, reconciliation execution/results, claims, exception
review, and audit history are implemented. Milestone 5 adds a configurable,
advisory AI mapping path with deterministic fallback and a human-reviewed
missing-order candidate workflow. A server-only S3-compatible storage adapter
is also implemented; its private configuration and production fail-closed
behavior have mocked test coverage, but no real bucket or deployment is
configured. See `docs/final-gap-audit.md` and `../deployment.md` for remaining
release constraints.

## Problem and users

Company A is a Bengaluru-based D2C home-textiles brand selling on its own
website, three marketplaces, and two quick-commerce apps. Its three-person
finance team manually reconciles partner settlements, COD remittances, and
courier freight invoices in spreadsheets. Return-to-warehouse records are not
reliably checked against warehouse receipts. The result is poor visibility
into missing or late money, excessive fees, and a 12-day month-end close.

The primary users are finance executives, who operate imports and investigate
discrepancies, and the finance co-founder, who needs oversight of money at risk
and partner performance. The returns manager is a potential later user, not
part of the required core roles.

The product's core question is: **for each order, did the partner remit the
expected amount on time, and can finance substantiate and pursue any gap?**

## Exact core build

The first end-to-end release is limited to:

1. Import order, settlement, COD-remittance, and freight-invoice CSV/XLSX files.
2. Map source columns, preview the mapping against 20 rows, approve it, and
   save versioned mappings per source with rollback.
3. Match imported financial rows to orders and calculate expected amounts
   from effective-dated channel/courier rate cards.
4. Show order-level outcomes: settled, short-paid, unpaid past due,
   freight overcharged, and return not received where supported by input data.
5. Create a partner-grouped claims worklist for supported short, late, and
   overcharge cases, with source-row and calculation evidence and export.
6. Show money at risk by partner and age.
7. Process 100,000 input rows in under 60 seconds on documented test
   infrastructure.
8. Use AI only to suggest source-column mappings. Suggestions are previewed
   and approved by a person before saving. Any suggested match for a missing
   order ID goes to a human review queue and cannot close a case automatically.

Core matching and financial calculations are deterministic rules. TCS and TDS
are shown separately from recoverable leakage; neither is treated as a claim.

## Scope boundary

Not in scope: storefront or inventory integrations, GST filing, automatic
claim filing, and AI/automation that changes financial records or makes
financial decisions.

The brief identifies returns tracking against warehouse receipt scans and a
partner-wise TCS/TDS summary as desired capabilities, then says the rest of the
MUST HAVE list is optional depth beyond the named core slice. Keep return
tracking and the expanded tax summary as the first post-core additions unless
the end-to-end flow cannot correctly classify an explicitly supplied return
record without them. Do not invent a warehouse integration; use imported scan
data if that feature is later selected.

Target outcomes supplied by the client are 98% auto-matched orders, close
reduced from 12 to 3 days, and at least ₹30 lakh recovered in year one. These
are product success measures, not guarantees the software can make.

## Proposed architecture

- **Web application:** Next.js App Router, strict TypeScript, server-rendered
  operational pages, and server-side API/service boundaries. Use a restrained,
  accessible table-first design with simple filters and explicit loading,
  empty, error, and confirmation states.
- **Persistence:** PostgreSQL with Prisma for relational models, migrations,
  constraints, and ordinary access. Use indexed staging tables and bulk
  database operations for large imports; avoid per-row ORM round trips.
- **Import processing:** Persist an import job and immutable original file,
  parse CSV/XLSX into staging rows, normalize through the approved mapping
  version, validate, then reconcile in set-based batches. Keep import state
  visible so users can distinguish uploaded, processing, completed, and failed
  files. The execution mechanism and file-storage provider are deployment
  choices to settle before the foundation milestone; do not add a queue or
  external integration without a demonstrated need.
- **Business services:** Keep mapping validation, normalization, rate
  evaluation, matching, discrepancy classification, claims, and dashboard
  aggregation outside UI components. Reconciliation results record rule and
  rate-card versions so a run can be explained and repeated.
- **Security and privacy:** Enforce role checks and request validation on the
  server. Do not import or display customer names, phone numbers, or addresses
  unless strictly necessary; mask any such fields in previews and tables.
  Keep credentials in environment variables and provide names/placeholders only
  in an example environment file.
- **AI boundary:** An advisory provider proposes mapping suggestions only.
  Persist the proposal separately from the approved mapping; require explicit
  user approval, version the saved mapping, and support rollback. Missing-ID
  match suggestions are review items, never automatic reconciliations.

### Initial domain model

Use only entities needed for the slice:

- `User` and role/permission data for finance executive and co-founder access.
- `Partner` and source identity for marketplaces, quick-commerce channels,
  payment/COD remitters, and couriers.
- `ImportBatch`, immutable file metadata, `MappingVersion`, and staged source
  rows with file/row provenance and validation state.
- `Order` and normalized financial records for settlement, COD, and freight
  inputs, retaining source references and duplicate-detection keys.
- Effective-dated `RateCard` versions with explainable components.
- `ReconciliationRun` and order-level results, including the records compared,
  expected/received amounts, reason codes, and rule/rate versions.
- `Claim` and audit events for review state, evidence, exports, and important
  user actions.

Add return-receipt and detailed TCS/TDS entities only when those optional
workflows are selected and their input formats are known. Monetary values use
PostgreSQL `NUMERIC`/decimal-safe arithmetic, never binary floating point.
Preserve original imports and historical results rather than silently
overwriting financial evidence.

## Matching and money rules

- Normalize every imported value through the approved, source-specific mapping;
  retain the original file and row number for evidence.
- Prefer exact order and partner references. Apply deterministic duplicate
  detection and aggregate legitimate split/partial remittances only where the
  source records support that relationship.
- A missing or ambiguous order ID is not an exact match. An AI-proposed
  candidate may be reviewed by a person but cannot be auto-accepted.
- Evaluate the expected net remittance from the order, applicable effective
  rate-card components, and supported transaction/fee rows. Keep GST TCS and
  income-tax TDS as separate deductions so statutory withholding is not
  mislabeled as leakage.
- Use `difference = received net amount - expected net amount`, consistent
  with the supplied examples. A negative difference below -₹10 is a shortfall
  candidate; an overcharge is supported by comparing a billed fee to its
  allowed rate-card amount. A ₹10-or-less difference is not a claim.
- Classify unpaid as past due only when a configured partner settlement term
  and relevant dates establish that it is late. Missing terms must not produce
  a fabricated due date.
- Claims remain reviewable and supported by source rows, rate-card version,
  expected/received component breakdown, and calculation reason. No claim is
  filed automatically.
- Imports and reconciliation reruns must be idempotent; a repeated upload must
  not duplicate orders, remittances, claims, or recovered amounts.

## Assumptions and decisions to validate

1. **Currency:** Examples use ₹; core records and rate cards will use INR.
2. **Tenant model:** Build for Company A's single workspace first; do not add
   multi-tenant billing or organization administration without a requirement.
3. **Permissions:** Finance executives operate imports, mappings, rate cards,
   reconciliation, and claims. Co-founder starts with oversight/read access.
   The brief does not define detailed permissions, so confirm before locking
   access to sensitive actions.
4. **Past-due threshold:** Partner-specific settlement terms and holiday/date
   rules are not supplied. Make terms configurable; do not hardcode a universal
   settlement delay.
5. **Rate cards:** Exact fee components and calculation rules are not
   supplied. Support effective-dated, explainable components; do not invent
   commission, freight, COD, or tax rates.
6. **Inputs:** Sample rows are illustrative and incomplete. Use fictional,
   deterministic seed data for missing scenarios; label it as demo data.
7. **Return receipt:** The brief requires warehouse receipt scans for return
   verification but does not define their file format. Do not claim a return
   was not received unless an agreed source and time window support that result.
8. **AI provider and hosting:** Neither is specified. Keep provider/storage
   interfaces replaceable and choose concrete vendors only when deployment
   requirements are known.
9. **Performance proof:** The under-one-minute target needs a repeatable
   100,000-row benchmark and recorded hardware/database configuration; the
   threshold is not considered met by a smaller test.

## Product screens and integration

The current interface stays focused on operational tasks rather than generic
administration:

1. **Overview:** persisted order totals, payment receipts, latest completed-run
   exposure, open exception exposure, COD outcome counts, age buckets by
   partner/currency, and recent runs.
2. **Imports:** authorized CSV/XLSX upload, column mapping, normalized preview,
   server-side approval, validation summary, duplicate recognition, saved
   mapping versions/rollback, and paginated batch history.
3. **Orders:** searchable and filterable channel order ledger with deterministic
   latest outcomes; sort is performed by the database.
4. **Reconciliation:** select completed source batches, run the idempotent
   engine, filter persisted results, and inspect explanations and linked
   transaction references.
5. **Match review:** review deterministic missing-order candidates, competing
   signals, and reasons; explicitly accept or reject. Acceptance links one
   transaction in a guarded transaction, audits the decision, and does not
   close the exception.
6. **Claims:** supported claim worklist, evidence snapshot and source-row
   provenance, status filter, and CSV export.
7. **Exceptions:** searchable lifecycle queue, evidence detail, and
   permission-checked transitions with resolution notes and audit events.
8. **Audit trail:** paginated, read-only record of important financial
   operations.

The dashboard keeps amounts grouped by currency and labels whether the figure
is gross order value, received settlement/COD net, latest-run supported claim
exposure, or currently open exception exposure. It does not sum unlike
currencies. Customer names, phone numbers, and addresses are not displayed.
Operational queries are uncached and authorized on the server.

Mapping suggestions use a configurable server-side OpenAI-compatible provider
when configured. Only source headers, import kind, and allowed destination
field metadata are sent; no sample rows or customer data are sent. The output
is schema-validated and uncertain/unsupported columns remain unmapped.
Suggestions are advisory and require a human-reviewed mapping preview and
explicit import approval. If credentials are absent or a provider request
fails, the UI labels deterministic exact-header suggestions and explains the
fallback; no AI result is fabricated.

Missing-order candidate generation uses exact currency, a 30-day order-to-
transaction window, exact source-reference and amount signals, and a
comparable channel-partner signal where available. Ambiguous competing
candidates are shown together; more than 200 candidates for one transaction
is withheld and reported as too ambiguous. Only an authorized, explicitly
confirmed decision can link one transaction. Rejections/acceptance are audited;
acceptance does not resolve the exception, and a changed link set produces a
new idempotent reconciliation run rather than rewriting the prior result.
No match is forced or auto-approved.

No rate-card editor is provided because there is no rate-card management
service/API. Returns/refunds and TCS/TDS remain optional depth; no warehouse
integration or tax filing is implied.

## Prioritized implementation checklist

### Milestone 1 — Requirements and architecture (current)

- [x] Read the complete client brief and identify the named core slice.
- [x] Separate core scope, optional depth, exclusions, assumptions, and
  measurable acceptance targets.
- [x] Record initial architecture, domain model, screens, and calculation
  boundaries.
- [x] Establish a performance gate for 100,000 rows under 60 seconds.

### Milestone 2 — Foundation

- [x] Scaffold the strict-TypeScript Next.js app and test/lint/build commands.
- [x] Provision PostgreSQL and create the minimal relational schema/migrations.
- [x] Implement server-side authentication and the two core roles.
- [x] Build the application shell and shared accessible table/form patterns.
- [ ] Decide file storage and import-job execution based on the deployment
  target.

Database foundation details: `prisma/schema.prisma` contains the operational
models and enums; the initial SQL migration adds additional database CHECK
constraints for valid money, currency, rate-card periods, row counts, and
settlement terms. Run `npx prisma migrate dev` for local migration application,
`npx prisma generate` after schema changes, and `npm run db:seed` to upsert the
fictional demo records. The seed requires the four `SEED_*` variables in
`.env`; it updates only the dedicated demo identities and deterministic demo
fixtures. `SHADOW_DATABASE_URL` points to a separate empty `reconcileos_shadow`
database used by Prisma migration diffing.

Authentication uses bcrypt-hashed passwords, random opaque session tokens
stored as SHA-256 hashes, `HttpOnly`/`SameSite=Lax` cookies, server-side
permission checks, and per-account login throttling. There is no public
registration flow. Finance executives can operate core finance tasks;
co-founders have read-only financial oversight pending confirmation of the
client's detailed permission policy.

### Milestone 3 — Import and deterministic core

- [x] Implement CSV/XLSX parsing, staged rows, source mapping versions, 20-row
  preview/approval, rollback, and validation errors.
- [x] Implement effective-dated rate cards and decimal-safe expected amounts.
- [x] Implement deterministic, idempotent matching, status classification,
  evidence, and audit history.
- [x] Add duplicate, split/partial, missing reference, tax deduction, and
  re-run tests before connecting the UI.
- [x] Benchmark 100,000 rows under 60 seconds and optimize measured
  bottlenecks.

### Milestone 4 — Core operations UI

- [x] Connect the persisted dashboard, imports/mappings, orders,
  reconciliation, claims, exception review, and audit-history screens.
- [x] Add server-side search/filter/pagination, order sorting, evidence detail,
  claims export, role-gated mutations, and useful loading/empty/error states.
- [x] Verify TypeScript, lint, integration workflows, and production build.
- [x] Implement schema-validated, person-approved AI mapping suggestions with
  server-only configuration and deterministic fallback.
- [x] Implement missing-order candidate generation, review decisions,
  transaction linking, and decision audit history.
- [x] Conduct browser-based keyboard and responsive smoke review.

### Milestone 5 — Final product QA and submission readiness

- [x] Create a requirement-by-requirement final gap audit from the recorded
  Core Build brief.
- [x] Add test coverage for mapping-provider fallback, uncertainty, candidate
  ambiguity, no-match outcomes, authorization, decisions, and reruns.
- [x] Run Prisma validation, TypeScript, full test suite, ESLint, production
  build, and browser-based workflow smoke checks.
- [ ] Complete populated missing-order candidate decisions in the browser and
  perform a formal accessibility review.
- [ ] Configure a durable private upload store for the chosen hosting target.
- [ ] Configure an approved AI provider credential before live-provider
  acceptance testing; deterministic fallback remains available until then.

### Milestone 5 — Demo data and optional depth

- [ ] Seed fictional cases including settled, short-paid, unpaid, freight
  overcharge, COD remittance, duplicate, and review-required records.
- [ ] Add return-receipt tracking and partner TCS/TDS summary if the core is
  stable and their input semantics are confirmed.

### Milestone 6 — Quality assurance

- [x] Run unit and integration suites plus manual browser smoke tests for the
  core import, reconciliation, exception, claims, and audit workflows.
- [x] Check authorization, privacy masking, import resilience, and duplicate
  handling.
- [x] Run the 100,000-row benchmark and smoke-check primary workflow controls.
  Populated candidate decisions and formal accessibility review remain open.

### Milestones 7–8 — Deployment and submission

- [ ] Deploy and verify persistence, environment configuration, seed/demo
  access, and major flows.
- [ ] Prepare the Technical Design Document, `deployment.md`, and a ZIP
  containing exactly those two deliverables.

## Stop condition for milestone 1

Do not add optional integrations or automatic financial actions. Begin
milestone 2 only after the core boundaries in this document are accepted and
the rate-card/file-format details needed for implementation are either
provided or represented as explicitly configurable, unseeded assumptions.
