# ReconcileOS performance review

## Baseline bottleneck inventory (before implementation changes)

Evidence: the latest supplied 100,000-row run measured upload/preview at
2.689 s, mapping preview at 0.042 s, import processing at 102.833 s, and
reconciliation at 57.704 s. The previous complete 100,000-row run measured
import at 91.4 s and reconciliation at 52.6 s. The import target is under
60 s. Increasing the import chunk to 6,000 rows regressed both import and
reconciliation substantially; that experiment was reverted.

### Observed query and transaction work

For each 2,000-row order-import chunk, `processChunk`:

1. Normalizes rows before opening the transaction.
2. Starts an interactive transaction.
3. Reads `import_rows` by `(batch_id, row_number IN (...))` to make retries safe.
4. Inserts orders with `createManyAndReturn`, honoring the unique
   `(channel_partner_id, external_id)` constraint and returning generated IDs.
5. Inserts staged `import_rows` with `createMany`.
6. Commits the transaction.

Thus, a clean 100,000-row order import uses 50 chunk transactions, 150 Prisma
data statements for chunk processing, plus transaction begin/commit and a
small fixed set of batch/mapping/audit statements. There is no per-order
database query on this path. Query time for each statement had not previously
been instrumented, so assigning the 102.833 s to PostgreSQL execution alone
would be speculation.

The upload path reads and hashes the in-memory file, writes it locally, then
scans the whole CSV once to count rows and produce its 20-row preview. Mapping
preview reads at most 20 rows. Approval verifies the first 20 rows again and
then scans the whole CSV for processing. The first and processing scans are
necessary today because the API accepts a `Buffer` and the saved file remains
the source of truth; preview hashing/validation and full processing are not
repeated per row.

### Reconciliation query inventory

The reconciliation runner performs a fixed batch/run lookup and run
create/update, then for every 2,000-order page:

- Fetches the orders and related transactions/return/refund records.
- Fetches effective-candidate rate cards and their components.
- Looks up already-created results for safe resume.
- Inserts results, transaction links, exceptions, and claims in one page
  transaction (four bulk statements).

It then reads unmatched transactions, bulk-inserts their exceptions, counts
results, and commits the audit event and run status. There is no per-order SQL
query, but rate-card candidate discovery, result-resume lookup, JavaScript
matching, Decimal operations, object construction, and per-page transactions
all run repeatedly across pages.

### Indexes and integrity work retained

The order insert maintains its primary key, unique partner/order key, order
date, delivery/due, and payment/delivery indexes, plus foreign-key checks.
`import_rows` maintains its primary key, unique batch/row key, batch/status,
and order indexes and stores masked raw and normalized JSON. Those indexes,
uniqueness rules, audit records, and transaction boundaries are correctness
requirements; this review does not remove them or disable database safeguards.

### Profiled root cause

The instrumented 100,000-row run measured import at 89.734 s (processing:
87.328 s). Within the processing phase:

| Work | Cumulative duration |
|---|---:|
| CSV iteration/chunk collection | 2.207 s |
| Row normalization/validation | 1.108 s |
| In-memory duplicate detection | 0.080 s |
| Retry-safe existing-row lookup | 3.713 s |
| Order insert + returned IDs | 33.699 s |
| Import-row JSON/relational insert | 45.374 s |
| Complete chunk transactions | 85.011 s |

These are elapsed client timings around Prisma operations. Their totals overlap
because transaction time contains its statements; do not add them together.
Import-row lookups use an `Index Only Scan` on the batch/row unique index
(EXPLAIN ANALYZE: 0.471 ms for a representative 2,000-row range, 13 shared
blocks hit). Rollback-only `EXPLAIN ANALYZE` runs for 2,000 synthetic inserts
reported 215 ms for the indexed `orders` insert and 177 ms for the indexed
`import_rows` insert. This confirms these constraints are material work, but
not enough alone to explain the much longer end-to-end bulk-write timings.
PostgreSQL `pg_stat_statements` is not installed, so
statement-level server aggregates are unavailable without changing server
configuration.

The evidence falsifies CSV parsing, validation, mapping, and the retry lookup
as primary bottlenecks. The first candidate, a single Prisma raw SQL statement
fed by a JSONB recordset, was not measurably faster: its instrumented run
completed import in 89.210 s and spent 60.709 s in set-based inserts. Increasing
this path to 10,000 rows per transaction also did not help (88.799 s total
import; 77.241 s in set-based inserts). Prisma bulk-input encoding was
therefore not the main cause.

## Optimization and final benchmark

The order import now uses PostgreSQL `COPY` to stream bounded 500-row groups
into a temporary staging table, inserts valid non-duplicate orders with a
set-based `INSERT ... ON CONFLICT DO NOTHING`, then streams the corresponding
masked `import_rows` records through `COPY`. Each chunk keeps durable writes
inside a PostgreSQL transaction. Existing unique constraints, indexes,
validation outcomes, foreign keys, and PII masking remain in force; conflicts
are recorded as duplicates rather than silently matched. Failed chunks roll
back together. Fresh batches skip the retry-only existing-row query, while
failed-batch retries still check persisted row numbers.

The benchmark script (`scripts/benchmark-import.ts`) generates exactly
100,000 fictional INR orders per run, executes one warm-up and three measured
trials sequentially, and assigns unique IDs to each trial. It verifies
accepted/rejected/duplicate counts, persisted import-row and order counts,
the exact Decimal order-value total, reconciliation-result count, and
idempotent import and reconciliation replay. Each trial removes only its own
tagged records after verification; it does not reset or delete other database
data. The trials ran against the existing local development database rather
than an isolated benchmark database, so timings are specific to that machine
and database state.

Environment: Windows x64, Node.js 24.16.0, PostgreSQL 18.6, Ryzen 5 3500U.
Command: `$env:NODE_OPTIONS = '--conditions=react-server'; npx tsx scripts/benchmark-import.ts`.

| Run | Import | Reconciliation |
|---|---:|---:|
| Warm-up | 63.470 s | — |
| Measured 1 | 38.185 s | 71.662 s |
| Measured 2 | 44.091 s | 81.084 s |
| Measured 3 | 42.394 s | 65.602 s |
| Median (measured) | **42.394 s** | **71.662 s** |

The import target of under 60 seconds passed in all three measured trials.
Each trial accepted 100,000 rows, rejected 0, and classified 0 as duplicates;
the exact order-value total was INR 100,000,000.00. Each reconciliation
produced 100,000 results and replayed idempotently; with no settlements in the
synthetic dataset, the results were review-required, expected amount totaled
INR 91,000,000.00, and received amount totaled INR 0.00. Per-trial cleanup
completed, and the final benchmark process exited with code 0.

PostgreSQL `pg_stat_statements` is not installed, so server-wide statement
statistics could not be collected. The benchmark records a representative
`EXPLAIN (ANALYZE, BUFFERS)` plan for the import-row lookup; DML
`EXPLAIN ANALYZE` profiling is performed inside an explicit rollback-only
transaction by `scripts/profile-import-writes.ts`.

## Regression verification

After the COPY change, Prisma validation and generation, TypeScript checking,
the full test suite (23 tests passed), ESLint, and the production build passed.
The benchmark also passed its count, total, reconciliation-result, replay,
and per-trial cleanup assertions.
