# Milestone 3 — Requirements traceability

Source of truth: the Company A brief supplied in the project conversation.
The exact core slice is the named “Core build”; other MUST HAVE capabilities
are optional depth according to that brief. No storefront, inventory, GST
filing, automatic claim filing, or AI-driven financial decisions are included.

| Requirement | Brief scope | Before this milestone | Milestone 3 implementation |
|---|---|---|---|
| Upload order, settlement, COD-remittance, freight CSV/Excel | Core | `ImportSource`, `ImportBatch`, `ImportRow`, but no upload/parse service or row-count summary | CSV/XLSX upload API, retained source file, mapping preview, chunked staging/processing, row summary and retry |
| Per-source saved column map, preview 20 rows, rollback | Core | Version/preview/rollback relations only | Validate required field map against 20-row preview; versioned approval and rollback APIs |
| Order-level deterministic matching and expected amounts | Core | Order, rate-card, run/result schema only | Decimal-safe rule service: exact reference, currency, fees, tax deductions, partials, due-date rules, detailed explanations |
| Required statuses: settled, short-paid, unpaid past due, freight overcharged, return not received when supported | Core | Most enum values existed; no calculation path | Engine emits supported outcomes; unsupported/ambiguous inputs remain review items |
| Claims list by partner, evidence export, money at risk by partner and age | Core | Claim/exception/evidence relations, no query/export operations | Authenticated query and CSV evidence export; aging is derived from recorded due date/creation time |
| Partner-wise TCS and TDS, separate from leakage | MUST HAVE optional depth | Decimal TCS/TDS columns existed | Kept separate in totals/evidence; no unsupported tax filing or rate assumptions |
| Return receipt and refund reconciliation | MUST HAVE optional depth; explicitly called out for attention in this milestone | No return/refund domain models | Minimal imported return-receipt/refund records and exception classifications; no warehouse integration |
| Human-reviewed missing-order match suggestions | Core AI boundary | Unmatched transaction exception only | Deterministic candidate generation uses exact currency, date-window, reference/amount and comparable partner signals; paginated review shows competing candidates and reasons; finance executive must explicitly accept/reject; accepted links are audited and exceptions remain open |
| Finance executive / co-founder permissions | Core | Role model and auth helpers, but no guarded business endpoints | Every mutating endpoint requires finance-executive permission; read-only queries require authenticated financial access |
| 100,000 rows under 60 seconds | Core measurable constraint | No pipeline or benchmark | Chunked CSV and database writes plus a generated 100k-row end-to-end benchmark; report machine/database and measured duration |
| Exception status, resolution notes, audit | Needed for core claims and requested in this milestone | Basic status/evidence only | Authorized status transition endpoint with notes and audit events |

## Schema gaps identified before implementation

The existing schema did not retain accepted/rejected/duplicate counts or the
preview file headers/rows, could not link an exception to an unmatched
transaction (it required an order result), had no pending match-review item,
and had no return-receipt/refund records or resolution note. Mapping/version
records existed without approval/rollback operations. This milestone adds only
those fields/relations needed by the workflows above; no payment gateway,
warehouse, or claim-filing integration is assumed.

## Explicit assumptions

- Imported financial references are matched only on an exact order reference;
  ambiguous/missing references remain unmatched for human review.
- For a financial source without an order-channel identifier, an order ID
  shared by multiple channels is ambiguous and will not be linked.
- A missing-payment due date is calculated only from configured partner
  settlement terms and a known delivery date.
- Tax withholding values are included as separate informational deductions.
  Whether tax is already excluded from a partner's supplied `net` value is a
  source-mapping/data-contract question; the engine does not subtract it twice.
- Local uploads are stored under the ignored `.data/imports/` directory. A
  hosted deployment must provide durable private object storage before use.
- Return-not-received is emitted only when an imported return record has a
  known expected-receipt date that has elapsed; there is no invented warehouse
  SLA or scan integration.

## Milestone 4 — UI and integration status

| Core workflow | Product surface | Verification |
|---|---|---|
| Authenticated oversight | Finance overview with currency-separated persisted totals, COD outcomes, partner age buckets, and recent runs | Integration test verifies login/session, live dashboard API, and logout invalidation |
| Operational import and mapping | Import upload, exact-header convenience mapping, normalized preview, approval, duplicate feedback, saved mapping history/rollback, paginated batch list | API workflow test uploads and processes a real CSV; existing tests cover invalid rows, duplicate data/file, idempotency, and PII masking |
| Order and reconciliation review | Searchable/filterable/sortable orders; selectable completed batches; explainable, paginated reconciliation results | API workflow test verifies a persisted result and explanation; existing tests cover deterministic outcomes and repeated/concurrent execution |
| Claims and exceptions | Evidence-backed claims/export; searchable exception queue with controlled status transitions and resolution notes | API workflow test verifies an exception transition and audit entries; existing tests cover lifecycle rules |
| Audit history | Paginated read-only history exposing operation, entity, actor, and timestamp, not raw payloads | Integration test confirms material exception-change events are persisted |

The workflows are implemented, with the following acceptance boundaries:

- **AI source-column mapping suggestions:** the server calls a configurable
  OpenAI-compatible provider with column headers and allowed destination
  metadata only. Structured output is validated, confidence and uncertainty
  are shown, and a person must review/approve. Without provider configuration
  or when the provider fails, exact-header suggestions are explicitly labeled
  deterministic; no AI response is fabricated. A live provider call remains
  unverified because no provider credential is configured.
- **Missing-order candidate decisions:** deterministic candidate suggestions
  are ranked using explainable signals and remain advisory. Competing
  candidates are shown together, decisions are permission-checked and audited,
  and acceptance never closes a case automatically.

The rate-card calculation service and existing effective-dated rate-card data
remain operational, but a rate-card editor is not exposed because there is no
management API. Import file storage remains local and must be replaced with
private durable object storage before hosted production use. See
`docs/final-gap-audit.md` for current verification status.

## Milestone 5 final verification

The final local QA run passed Prisma validation, TypeScript, all 43 tests across
10 files, ESLint, and the production build. Browser smoke testing exercised the
Finance Executive import-to-reconciliation flow, exception resolution, claims
evidence/export, audit history, logout, and mobile/tablet/keyboard behavior.
Co-Founder read-only permissions and candidate accept/reject decisions were
verified through PostgreSQL-backed integration tests. A populated candidate
decision was not browser-tested; live AI provider access and durable hosted
file storage remain unverified. The S3-compatible adapter passes mocked tests
for permission checks, upload/download, temporary-file cleanup, and failure
handling, but no real bucket or post-redeployment persistence test has been
performed. See `docs/final-verification.md` for exact results and
`docs/final-gap-audit.md` for requirement-by-requirement status.
