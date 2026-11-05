# Final gap audit

## Source and scope

The original client brief is not present as a separate workspace file. The
recorded source is the “Exact core build” section in
[architecture.md](./architecture.md), traced in
[milestone-3-traceability.md](./milestone-3-traceability.md), and supplied in
the project conversation. This audit uses that recorded scope and does not
promote optional depth into mandatory requirements.

## Requirement status

| Requirement | Status | Evidence and remaining boundary |
|---|---|---|
| Import order, settlement, COD-remittance, and freight CSV/XLSX files | Complete and verified | Import parsing, validation, duplicate handling, and database workflows pass the integration suite; browser QA uploaded and approved an order CSV. XLSX parsing has a focused test. |
| Map source columns, preview 20 rows, approve, save per-source versions, and roll back | Implemented but not fully verified | Preview/approval and human approval of mapping suggestions are tested; the browser exercised preview and approval. The mapping rollback path was not exercised in this final QA pass. |
| Deterministic order matching and expected amounts using effective-dated rate cards | Complete and verified | Decimal-safe reconciliation unit/integration tests pass. Browser QA ran a persisted order reconciliation and inspected its rule explanation. |
| Order outcomes: settled, short-paid, unpaid past due, freight overcharged, and return not received when supported | Implemented but not fully verified | The reconciliation service and test suite cover supported outcomes. Return-not-received depends on supplied return receipt and expected-date data; no warehouse scan integration is provided. |
| Partner-grouped claims worklist, evidence, and export | Complete and verified | Claims and evidence rendered in browser QA; `/api/claims/export` returned HTTP 200 with a CSV attachment. Integration tests cover the persisted API workflow. |
| Money at risk by partner and age | Complete and verified | Dashboard figures are database-backed, currency-separated, and covered by aggregate integration tests; the signed-in dashboard was opened in browser QA. |
| Process 100,000 rows in under 60 seconds | Complete and verified | Three measured imports were 38.185 s, 44.091 s, and 42.394 s; median 42.394 s. See [performance-review.md](./performance-review.md) for environment and integrity checks. |
| AI mapping suggestions, confidence, uncertainty, and human approval | Implemented but not fully verified | Provider requests are schema-validated and covered with mocked success/outage tests; fallback is deterministic and clearly labeled. No provider credential is configured, so a live provider request was not tested. No suggestion is approved automatically. |
| Missing-order candidate generation and human accept/reject decisions | Implemented but not fully verified | PostgreSQL integration tests cover no-match, ambiguity, competing candidates, authorization, reject/confirm, audit, and reconciliation reruns. Browser QA verified the empty state, but did not exercise a populated candidate decision UI. |
| Finance Executive operations and Co-founder read-only oversight | Complete and verified | Full integration tests verify login/logout, authenticated reads, Finance Executive operations, Co-founder oversight, and rejected Co-founder mutations. Browser QA exercised Finance Executive login and logout. |
| Explainable results, audit history, duplicate protection, idempotency, and PII masking | Complete and verified | Unit and PostgreSQL integration tests cover these safeguards; browser QA inspected the reconciliation explanation and an exception status-change audit event. |
| Durable private storage for hosted deployment | Implemented but not fully verified | The server-only S3-compatible adapter stores originals privately, requires Finance Executive authorization for retrieval, uses no-store attachment responses, removes temporary working copies, and fails closed in production without complete S3 settings. Nine mocked tests pass. No real bucket, bucket policy, production credentials, real download, or post-redeployment persistence test is configured, so hosted durability is not established. |

## Not required by the Core Build

Storefront/inventory integration, GST filing, automatic claim filing, a rate-card
editor, warehouse integration, and AI-driven financial decisions are outside
the recorded Core Build. Returns/refunds and expanded partner-wise TCS/TDS are
optional depth. Existing return/refund ingestion and classification do not
constitute warehouse scan integration or tax filing.

## Final QA boundaries

- TypeScript, Prisma validation, the complete 43-test Vitest suite, ESLint,
  and the production build passed. Exact command output and browser
  observations are recorded in [final-verification.md](./final-verification.md).
- Browser smoke testing covered Finance Executive login/logout, dashboard,
  order CSV upload and mapping approval, order search, reconciliation and
  explanation, exception resolution with a required note, claims evidence and
  export, audit history, and the missing-order empty state.
- Mobile/tablet smoke checks found no page-level horizontal overflow; wide
  financial tables use their own scrollable containers. Keyboard testing
  verified focus progression from the audit filter to its Apply button. This
  was not a formal accessibility audit.
- No hosted deployment was performed. Configure and verify the private bucket
  policy, production storage/database secrets, HTTPS/cookie behavior, backups,
  and restore procedures for the selected hosting platform before release.
