# Milestone 4 — Product UI and end-to-end integration plan

## Source of truth and scope

The required CORE BUILD is transcribed in [architecture.md](./architecture.md#exact-core-build).
It covers operational CSV/XLSX imports and versioned mappings, deterministic
rate-card reconciliation, explainable order outcomes, evidence-backed claims,
money at risk, the 100,000-row performance gate, and advisory AI mapping
suggestions with human approval. Optional return tracking and partner TCS/TDS
summaries are not promoted to required product screens. Automatic claim filing,
storefront/inventory integration, and automated financial decisions remain out
of scope.

The original client brief was not found as a separate workspace file. The
architecture document and the existing Milestone 3 traceability document
record the supplied Company A brief and its CORE BUILD requirements. This plan
uses those recorded requirements rather than adding new product scope.

## Requirement-to-implementation matrix

| Required feature | Existing backend capability | Required UI screen | API integration | Acceptance proof / gap |
|---|---|---|---|---|
| Sign in/out; Finance Executive operations and Co-founder read-only oversight | Hashed sessions, login throttling, role permission helpers, login/logout/session routes | Login; shared authenticated shell with role-aware actions | `/api/auth/login`, `/api/auth/logout`, protected read/write APIs | Exercise credentials, session persistence/logout, finance-only mutation, co-founder read access and rejected writes |
| Import order, settlement, COD-remittance, and freight-invoice CSV/XLSX | File validation, duplicate hash detection, private local storage, masked preview, import row summaries, PostgreSQL COPY for orders | Imports: upload, source/kind, 20-row preview, validation summary, batch history | `POST /api/imports`, mapping preview and approval routes, authenticated batch list | API integration verifies upload, approval, persisted masking and counts; existing tests cover invalid rows, duplicate upload/rows, and idempotent retry |
| Map columns, preview, approve, version mappings, rollback | Mapping validation, preview hash, approved mapping version, rollback service/API | Import mapping step with field selectors and preview; mapping history/rollback control | Existing preview/approve/rollback routes; authenticated partners/sources/mapping versions read endpoint | API integration verifies preview/approval; mapping approval records whether the AI suggestion was accepted or overridden |
| AI mapping suggestions, approved by a person | Configurable OpenAI-compatible provider, structured output validation, confidence and uncertainty, audited pending suggestions, deterministic fallback | Import mapping screen labels AI versus deterministic fallback and requires the normal human preview and import approval | Authenticated `POST /api/imports/[batchId]/suggest-mapping`; approval accepts a suggestion ID | Mocked API test verifies metadata-only provider request, unsupported column handling, unavailable-provider fallback and explicit approval. Live provider connectivity remains unverified because no credential is configured |
| Deterministic matching and rate-card expected amounts | Decimal reconciliation service; effective-dated rate cards and explanations | Reconciliation results and evidence detail; rate cards may be inspected where available | `POST /api/reconciliation`, authenticated run/result list, and order query endpoints | API integration verifies a persisted result and explanation; existing tests cover matching scenarios and idempotency |
| Missing/ambiguous order references remain human-reviewable | Deterministic reference/amount/date/currency/partner signals, bounded generation, guarded transactional accept/reject, audit history | Match review queue shows reasons, deterministic signal score, and competing candidates; acceptance confirmation leaves the exception open | Authenticated `/api/match-suggestions` and `/api/match-suggestions/[suggestionId]` | PostgreSQL integration test verifies false/no-match behavior, competing candidates, role denial, reject/confirm, audit trail, and idempotent reconciliation after a link |
| Partner-grouped claims worklist with source/calculation evidence and export | Claim listing, evidence snapshots, CSV export, exception transitions and audit events | Claims and exception review | Existing claims/export/detail/PATCH APIs | Verify evidence and export, valid transitions/resolution note, audit record and denied co-founder mutation |
| Money at risk by partner and age | Currency-separated age buckets via `moneyAtRiskByPartner` | Dashboard overview | Existing `/api/dashboard/money-at-risk` and authenticated dashboard aggregates | Integration test verifies order totals against PostgreSQL; every financial figure stays grouped by currency |
| 100,000 rows under 60 seconds | COPY ingestion and reproducible benchmark; latest recorded three trials all under target | Imports screen reports actual batch row counts; no UI timing promise | Existing import APIs preserve COPY path | Existing benchmark evidence: three measured imports 38.185s, 44.091s, 42.394s; do not rerun as a UI test |
| Audit history for material operations | Audit events persisted for import/mapping/reconciliation/exception changes; paginated read endpoint excludes details/raw PII | Audit history | Read-only `/api/audit` endpoint | API integration verifies exception transition audit records; endpoint returns only action/entity/actor/time metadata |
| Returns / refunds and TCS/TDS | Optional import kinds, models and reconciliation support exist | No separate screen unless needed to operate imported core data | Existing import/reconciliation APIs | Optional depth only; document current support without implying warehouse scan integration or tax filing |

## Implementation sequence

1. Replace the starter route with a guarded, responsive financial operations
   shell and login/logout experience.
2. Add read-only, server-authorized query seams for dashboard metrics, import
   batches/sources, orders, reconciliation runs/results, exceptions and audit
   history. Keep money as Decimal/string values and group by currency.
3. Connect the import wizard to existing upload, preview, approve, duplicate,
   validation, and rollback services without changing COPY ingestion.
4. Connect reconciliation execution and result review; connect exception
   transitions and claim evidence/export.
5. Add focused service/API/UI workflow tests, update architecture and
   traceability records, then run tests, TypeScript, lint and production build
   sequentially.

## Acceptance boundary and non-goals

- Every finance view requires a server-verified authenticated user; every
  mutation separately checks the server-side permission.
- Client-submitted roles, totals, and permissions are never trusted.
- No customer PII is rendered; uploaded previews and stored raw rows continue
  to use the existing masking service.
- Search, status filters and pagination apply to persisted queries, not
  client-only arrays.
- No rate-card editor is added because the backend has no rate-card management
  service/API; no decorative settings screen is planned.
- AI mapping requires server-side endpoint/model/key configuration to use a
  live provider. Until then, the deterministic fallback is explicitly labeled.
- Candidate scoring is an explainable deterministic ranking, not a calibrated
  probability; amount-only candidates require a comparable matching channel.

## Current delivery status

Implemented screens are the authenticated overview, imports/mappings,
orders, reconciliation results, claims, exceptions, and audit history. The
API-level integration test exercises login/logout, role restrictions, all
financial read endpoints, an uploaded order file through approval and
reconciliation, PII masking, and an audited exception resolution. Existing
Milestone 3 integration tests continue to cover invalid rows, duplicate
imports, retries, matching, and exception service transitions.

The previously missing AI mapping and missing-order review workflows are now
implemented. Their limitations are explicit: live provider calls are not
verified without credentials, deterministic fallback is used when no provider
is configured, and no candidate is auto-accepted. See
`docs/final-gap-audit.md` for exact requirement classification and
`docs/deployment.md` for the private-storage deployment blocker.

## Final verification

Final QA executed the following checks sequentially:

| Command | Result |
|---|---|
| `npx prisma validate` | Passed |
| `npx tsc --noEmit` | Passed |
| `npm test` | Passed: 10 test files, 43 tests, including private-storage tests |
| `npm run lint` | Passed |
| `npm run build` | Passed: optimized Next.js 16.4.4 build and static-page generation |

The PostgreSQL-backed tests cover authentication and role boundaries, financial
workflows, provider fallback, candidate decisions, audit history, and database
integrity. Browser smoke testing covered the Finance Executive import-to-
reconciliation flow, exception resolution, claims evidence/export, audit
history, and mobile/tablet and keyboard checks. A populated candidate decision
was not exercised in the browser; it is covered at the API/service level.
Live AI connectivity and hosted durable file storage remain unverified. The S3 adapter is implemented, but real bucket configuration and
survival/retrieval across a redeploy remain unverified. See
[final-gap-audit.md](./final-gap-audit.md) and
[final-verification.md](./final-verification.md) for detailed evidence.
