# Final verification

## Automated checks

Commands were run sequentially on Windows against the existing local
PostgreSQL database. The application schema was unchanged during this final
QA pass, so no migration or database reset was run.

| Command | Result |
|---|---|
| `npx prisma validate` | Passed — schema valid with Prisma 6.19.0. |
| `npx tsc --noEmit` | Passed — no TypeScript diagnostics. |
| `npm test` | Passed — 10 test files, 43 tests. PostgreSQL integration tests ran, including login/logout, role boundaries, import/reconciliation, candidate decisions, database constraints, Decimal precision, repeatable seeding, and 9 mocked private-storage tests. |
| `npm run lint` | Passed — ESLint exited successfully. |
| `npm run build` | Passed — Next.js 16.4.4 production build compiled, type-checked, generated 27 static pages, and listed the application/API routes. |

The database test intentionally attempted a duplicate order and Prisma logged
the expected unique-constraint error; the assertion passed. No test failed.

## Browser QA performed

Used the running local application in an actual browser with a Finance Executive
session:

- Signed in and viewed persisted dashboard data.
- Uploaded a fictional order CSV; reviewed the deterministic-mapping fallback,
  previewed the mapped row, and approved the import.
- Searched for the imported order.
- Ran reconciliation and inspected the persisted `Review Required` result.
  The explanation stated that no remittance was recorded and the due date was
  unknown/not passed; expected ₹2,410.00, received ₹0.00, difference
  -₹2,410.00.
- Created a disposable test exception for that order, opened its evidence,
  resolved it with the required resolution note, and verified the status-change
  entry in Audit history.
- Viewed a claims evidence detail. The claims CSV export endpoint returned
  HTTP 200 with `text/csv` and an attachment filename.
- Viewed the empty missing-order-candidate state.
- Signed out and confirmed the unauthenticated session endpoint returned 401.
- Checked mobile (375 CSS-pixel document width) and tablet (768 px) layouts.
  The document width matched the viewport; wide order/claims/audit tables were
  contained in horizontally scrollable table wrappers.
- Checked keyboard focus from the audit filter to the Apply button.

No persistent application changes from browser QA remain. The disposable
browser QA users, order, import batch, mapping version, reconciliation run and
result, exception, audit events, and uploaded files were removed by exact
fixture identifiers after verification.

Co-Founder read-only access and protected-write rejection were verified by the
PostgreSQL-backed integration test; a separate Co-Founder browser session was
not run. The browser check of candidate suggestions covered the empty state,
not a populated accept/reject UI. No live AI provider request was made because
no credential is configured. Browser navigation produced canceled Next.js
RSC requests, and the explicit signed-out session probe produced its expected
401; no application 5xx response was observed.

## Deployment and integrity status

- `.env` remains ignored by Git (`.gitignore` rule verified); no credentials
  were printed or committed.
- Private S3-compatible import storage is implemented. Focused mocked tests
  verify the upload/download path, finance-only access, Co-Founder denial,
  temporary-file cleanup, fail-closed production configuration, endpoint
  validation, and provider error handling. No live object-storage request was
  performed.
- The production build passed locally, but the application was not deployed.
- Local development uses `.data/imports/` when all S3 configuration is absent;
  production fails closed without complete S3 configuration. No real bucket,
  policy, uploaded-file retrieval, or persistence-across-redeployment test was
  configured. Hosted production storage remains blocked on those provider
  actions.
- The AI mapping provider is optional and degrades to labeled deterministic
  suggestions. Live provider connectivity remains unverified.
- No schema change was made; Prisma validation passed, and no migration was
  required for this QA work.
