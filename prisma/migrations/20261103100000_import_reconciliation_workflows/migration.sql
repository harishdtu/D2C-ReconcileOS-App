-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('EXPECTED', 'RECEIVED', 'OVERDUE', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'MISMATCH');

-- AlterEnum
ALTER TYPE "ExceptionKind" ADD VALUE 'REFUND_MISMATCH';

-- AlterEnum
ALTER TYPE "FinancialRecordKind" ADD VALUE 'REFUND';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ImportKind" ADD VALUE 'RETURN_RECEIPT';
ALTER TYPE "ImportKind" ADD VALUE 'REFUND';

-- AlterEnum
ALTER TYPE "ImportRowStatus" ADD VALUE 'DUPLICATE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReconciliationStatus" ADD VALUE 'PARTIAL_MATCH';
ALTER TYPE "ReconciliationStatus" ADD VALUE 'REFUND_MISMATCH';
ALTER TYPE "ReconciliationStatus" ADD VALUE 'UNMATCHED_TRANSACTION';

-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN     "accepted_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "preview_hash" CHAR(64),
ADD COLUMN     "preview_headers" JSONB,
ADD COLUMN     "preview_rows" JSONB,
ADD COLUMN     "rejected_rows" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "reconciliation_exceptions" ADD COLUMN     "financial_transaction_id" UUID,
ADD COLUMN     "resolution_note" TEXT,
ALTER COLUMN "result_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "match_suggestions" (
    "id" UUID NOT NULL,
    "financial_transaction_id" UUID NOT NULL,
    "candidate_order_id" UUID NOT NULL,
    "status" "MappingSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" DECIMAL(5,4),
    "reason" TEXT NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_receipts" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "import_row_id" UUID NOT NULL,
    "order_id" UUID,
    "external_order_id" VARCHAR(120) NOT NULL,
    "deduplication_key" VARCHAR(180) NOT NULL,
    "expected_receipt_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "warehouse_receipt_reference" VARCHAR(180),
    "status" "ReturnStatus" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "return_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "return_receipt_id" UUID,
    "financial_transaction_id" UUID NOT NULL,
    "expected_amount" DECIMAL(14,2) NOT NULL,
    "refunded_amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "RefundStatus" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "match_suggestions_status_created_at_idx" ON "match_suggestions"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "match_suggestions_financial_transaction_id_candidate_order__key" ON "match_suggestions"("financial_transaction_id", "candidate_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_receipts_import_row_id_key" ON "return_receipts"("import_row_id");

-- CreateIndex
CREATE INDEX "return_receipts_partner_id_status_expected_receipt_at_idx" ON "return_receipts"("partner_id", "status", "expected_receipt_at");

-- CreateIndex
CREATE INDEX "return_receipts_order_id_status_idx" ON "return_receipts"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "return_receipts_partner_id_deduplication_key_key" ON "return_receipts"("partner_id", "deduplication_key");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_financial_transaction_id_key" ON "refunds"("financial_transaction_id");

-- CreateIndex
CREATE INDEX "refunds_partner_id_status_created_at_idx" ON "refunds"("partner_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "refunds_order_id_status_idx" ON "refunds"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_exceptions_financial_transaction_id_kind_key" ON "reconciliation_exceptions"("financial_transaction_id", "kind");

-- AddForeignKey
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_financial_transaction_id_fkey" FOREIGN KEY ("financial_transaction_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_financial_transaction_id_fkey" FOREIGN KEY ("financial_transaction_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_candidate_order_id_fkey" FOREIGN KEY ("candidate_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_import_row_id_fkey" FOREIGN KEY ("import_row_id") REFERENCES "import_rows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_return_receipt_id_fkey" FOREIGN KEY ("return_receipt_id") REFERENCES "return_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_financial_transaction_id_fkey" FOREIGN KEY ("financial_transaction_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_summary_nonnegative"
    CHECK (
        "accepted_rows" >= 0
        AND "rejected_rows" >= 0
        AND "duplicate_rows" >= 0
    );

ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_exactly_one_parent"
    CHECK (num_nonnulls("result_id", "financial_transaction_id") = 1);

ALTER TABLE "match_suggestions" ADD CONSTRAINT "match_suggestions_confidence_range"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amounts_valid"
    CHECK (
        "expected_amount" >= 0
        AND "refunded_amount" >= 0
        AND "currency" ~ '^[A-Z]{3}$'
    );
