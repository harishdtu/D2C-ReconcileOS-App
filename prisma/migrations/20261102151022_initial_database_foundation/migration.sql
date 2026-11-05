-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('FINANCE_EXECUTIVE', 'CO_FOUNDER');

-- CreateEnum
CREATE TYPE "PartnerKind" AS ENUM ('WEBSITE', 'MARKETPLACE', 'QUICK_COMMERCE', 'COURIER', 'COD_REMITTER');

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('ORDER', 'SETTLEMENT', 'COD_REMITTANCE', 'FREIGHT_INVOICE');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('MAPPING_REQUIRED', 'PREVIEWED', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'VALIDATED', 'INVALID', 'PROCESSED');

-- CreateEnum
CREATE TYPE "MappingSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('COD', 'PREPAID');

-- CreateEnum
CREATE TYPE "OrderDeliveryStatus" AS ENUM ('PLACED', 'SHIPPED', 'DELIVERED', 'RETURN_TO_WAREHOUSE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FinancialRecordKind" AS ENUM ('SETTLEMENT', 'COD_REMITTANCE', 'FREIGHT_INVOICE');

-- CreateEnum
CREATE TYPE "RateComponentKind" AS ENUM ('MARKETPLACE_FEE', 'PAYMENT_FEE', 'COD_FEE', 'FREIGHT_FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "RateBasis" AS ENUM ('PERCENTAGE', 'FLAT_PER_ORDER', 'WEIGHT_SLAB');

-- CreateEnum
CREATE TYPE "ReconciliationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('SETTLED', 'SHORT_PAID', 'UNPAID_PAST_DUE', 'FREIGHT_OVERCHARGED', 'RETURN_NOT_RECEIVED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "ExceptionKind" AS ENUM ('SHORT_PAYMENT', 'UNPAID_PAST_DUE', 'FREIGHT_OVERCHARGE', 'RETURN_NOT_RECEIVED', 'MISSING_ORDER_REFERENCE', 'DUPLICATE_TRANSACTION', 'OTHER');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'READY_TO_SUBMIT', 'SUBMITTED', 'PARTIALLY_RECOVERED', 'RECOVERED', 'CLOSED', 'DISMISSED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_rate_limits" (
    "key_hash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "window_started" TIMESTAMPTZ(6) NOT NULL,
    "blocked_until" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "login_rate_limits_pkey" PRIMARY KEY ("key_hash")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "kind" "PartnerKind" NOT NULL,
    "settlement_terms_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_sources" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "source_key" VARCHAR(120) NOT NULL,
    "active_mapping_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "import_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_versions" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "mapping" JSONB NOT NULL,
    "preview_rows" JSONB NOT NULL,
    "rollback_of_id" UUID,
    "approved_by_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mapping_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_suggestions" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "batch_id" UUID,
    "proposed" JSONB NOT NULL,
    "confidence" DECIMAL(5,4),
    "status" "MappingSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mapping_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "mapping_version_id" UUID,
    "uploaded_by_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(1024) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'MAPPING_REQUIRED',
    "total_rows" INTEGER,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "error_summary" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_data" JSONB NOT NULL,
    "normalized_data" JSONB,
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "validation_errors" JSONB,
    "order_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "channel_partner_id" UUID NOT NULL,
    "external_id" VARCHAR(120) NOT NULL,
    "order_date" TIMESTAMPTZ(6) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),
    "settlement_due_at" TIMESTAMPTZ(6),
    "payment_method" "PaymentMethod" NOT NULL,
    "delivery_status" "OrderDeliveryStatus" NOT NULL DEFAULT 'PLACED',
    "order_value" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_transactions" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "import_row_id" UUID NOT NULL,
    "order_id" UUID,
    "kind" "FinancialRecordKind" NOT NULL,
    "external_reference" VARCHAR(180),
    "transaction_date" TIMESTAMPTZ(6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "gross_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fee_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tcs_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tds_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(14,2) NOT NULL,
    "billed_weight_kg" DECIMAL(10,3),
    "deduplication_key" VARCHAR(180) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" UUID NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "version" INTEGER NOT NULL,
    "channel_partner_id" UUID NOT NULL,
    "courier_partner_id" UUID,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_components" (
    "id" UUID NOT NULL,
    "rate_card_id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "kind" "RateComponentKind" NOT NULL,
    "basis" "RateBasis" NOT NULL,
    "rate" DECIMAL(12,4) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "min_weight_kg" DECIMAL(10,3),
    "max_weight_kg" DECIMAL(10,3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_card_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "initiated_by_id" UUID NOT NULL,
    "input_fingerprint" CHAR(64) NOT NULL,
    "rules_version" VARCHAR(40) NOT NULL,
    "status" "ReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "error_summary" JSONB,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_results" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "rate_card_id" UUID,
    "status" "ReconciliationStatus" NOT NULL,
    "expected_amount" DECIMAL(14,2) NOT NULL,
    "received_amount" DECIMAL(14,2) NOT NULL,
    "difference_amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason_codes" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_transactions" (
    "result_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,

    CONSTRAINT "reconciliation_transactions_pkey" PRIMARY KEY ("result_id","transaction_id")
);

-- CreateTable
CREATE TABLE "reconciliation_exceptions" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "kind" "ExceptionKind" NOT NULL,
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "amount_at_risk" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "evidence_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reconciliation_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "exception_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'OPEN',
    "claim_amount" DECIMAL(14,2) NOT NULL,
    "recovered_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "partner_case_ref" VARCHAR(180),
    "evidence_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(120) NOT NULL,
    "entity_type" VARCHAR(120) NOT NULL,
    "entity_id" VARCHAR(120) NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "login_rate_limits_blocked_until_idx" ON "login_rate_limits"("blocked_until");

-- CreateIndex
CREATE UNIQUE INDEX "partners_code_key" ON "partners"("code");

-- CreateIndex
CREATE INDEX "partners_kind_is_active_idx" ON "partners"("kind", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "import_sources_active_mapping_version_id_key" ON "import_sources"("active_mapping_version_id");

-- CreateIndex
CREATE INDEX "import_sources_partner_id_kind_idx" ON "import_sources"("partner_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "import_sources_partner_id_kind_source_key_key" ON "import_sources"("partner_id", "kind", "source_key");

-- CreateIndex
CREATE INDEX "mapping_versions_source_id_approved_at_idx" ON "mapping_versions"("source_id", "approved_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mapping_versions_source_id_version_key" ON "mapping_versions"("source_id", "version");

-- CreateIndex
CREATE INDEX "mapping_suggestions_source_id_status_created_at_idx" ON "mapping_suggestions"("source_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "import_batches_source_id_created_at_idx" ON "import_batches"("source_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_batches_status_created_at_idx" ON "import_batches"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "import_batches_source_id_content_hash_key" ON "import_batches"("source_id", "content_hash");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_status_idx" ON "import_rows"("batch_id", "status");

-- CreateIndex
CREATE INDEX "import_rows_order_id_idx" ON "import_rows"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_batch_id_row_number_key" ON "import_rows"("batch_id", "row_number");

-- CreateIndex
CREATE INDEX "orders_order_date_idx" ON "orders"("order_date");

-- CreateIndex
CREATE INDEX "orders_delivery_status_settlement_due_at_idx" ON "orders"("delivery_status", "settlement_due_at");

-- CreateIndex
CREATE INDEX "orders_payment_method_delivery_status_idx" ON "orders"("payment_method", "delivery_status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_channel_partner_id_external_id_key" ON "orders"("channel_partner_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_transactions_import_row_id_key" ON "financial_transactions"("import_row_id");

-- CreateIndex
CREATE INDEX "financial_transactions_partner_id_transaction_date_idx" ON "financial_transactions"("partner_id", "transaction_date");

-- CreateIndex
CREATE INDEX "financial_transactions_order_id_kind_idx" ON "financial_transactions"("order_id", "kind");

-- CreateIndex
CREATE INDEX "financial_transactions_source_id_transaction_date_idx" ON "financial_transactions"("source_id", "transaction_date");

-- CreateIndex
CREATE UNIQUE INDEX "financial_transactions_source_id_deduplication_key_key" ON "financial_transactions"("source_id", "deduplication_key");

-- CreateIndex
CREATE INDEX "rate_cards_channel_partner_id_effective_from_effective_to_idx" ON "rate_cards"("channel_partner_id", "effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "rate_cards_courier_partner_id_effective_from_effective_to_idx" ON "rate_cards"("courier_partner_id", "effective_from", "effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "rate_cards_key_version_key" ON "rate_cards"("key", "version");

-- CreateIndex
CREATE INDEX "rate_card_components_rate_card_id_kind_basis_idx" ON "rate_card_components"("rate_card_id", "kind", "basis");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_components_rate_card_id_code_key" ON "rate_card_components"("rate_card_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_runs_input_fingerprint_key" ON "reconciliation_runs"("input_fingerprint");

-- CreateIndex
CREATE INDEX "reconciliation_runs_status_started_at_idx" ON "reconciliation_runs"("status", "started_at" DESC);

-- CreateIndex
CREATE INDEX "reconciliation_results_order_id_created_at_idx" ON "reconciliation_results"("order_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reconciliation_results_status_created_at_idx" ON "reconciliation_results"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_results_run_id_order_id_key" ON "reconciliation_results"("run_id", "order_id");

-- CreateIndex
CREATE INDEX "reconciliation_transactions_transaction_id_idx" ON "reconciliation_transactions"("transaction_id");

-- CreateIndex
CREATE INDEX "reconciliation_exceptions_partner_id_status_created_at_idx" ON "reconciliation_exceptions"("partner_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "reconciliation_exceptions_status_due_at_idx" ON "reconciliation_exceptions"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_exceptions_result_id_kind_key" ON "reconciliation_exceptions"("result_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "claims_exception_id_key" ON "claims"("exception_id");

-- CreateIndex
CREATE INDEX "claims_partner_id_status_created_at_idx" ON "claims"("partner_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_active_mapping_version_id_fkey" FOREIGN KEY ("active_mapping_version_id") REFERENCES "mapping_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_versions" ADD CONSTRAINT "mapping_versions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "import_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_versions" ADD CONSTRAINT "mapping_versions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_versions" ADD CONSTRAINT "mapping_versions_rollback_of_id_fkey" FOREIGN KEY ("rollback_of_id") REFERENCES "mapping_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_suggestions" ADD CONSTRAINT "mapping_suggestions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "import_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_suggestions" ADD CONSTRAINT "mapping_suggestions_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_suggestions" ADD CONSTRAINT "mapping_suggestions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "import_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_mapping_version_id_fkey" FOREIGN KEY ("mapping_version_id") REFERENCES "mapping_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_partner_id_fkey" FOREIGN KEY ("channel_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "import_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_import_row_id_fkey" FOREIGN KEY ("import_row_id") REFERENCES "import_rows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_channel_partner_id_fkey" FOREIGN KEY ("channel_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_courier_partner_id_fkey" FOREIGN KEY ("courier_partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card_components" ADD CONSTRAINT "rate_card_components_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_initiated_by_id_fkey" FOREIGN KEY ("initiated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_transactions" ADD CONSTRAINT "reconciliation_transactions_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "reconciliation_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_transactions" ADD CONSTRAINT "reconciliation_transactions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "reconciliation_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_exception_id_fkey" FOREIGN KEY ("exception_id") REFERENCES "reconciliation_exceptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Financial invariants not expressed by Prisma's schema language.
ALTER TABLE "partners" ADD CONSTRAINT "partners_settlement_terms_days_nonnegative"
    CHECK ("settlement_terms_days" IS NULL OR "settlement_terms_days" >= 0);

ALTER TABLE "login_rate_limits" ADD CONSTRAINT "login_rate_limits_attempts_nonnegative"
    CHECK ("attempts" >= 0);

ALTER TABLE "mapping_versions" ADD CONSTRAINT "mapping_versions_version_positive"
    CHECK ("version" > 0);

ALTER TABLE "mapping_suggestions" ADD CONSTRAINT "mapping_suggestions_confidence_range"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));

ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_counts_valid"
    CHECK (
        "file_size_bytes" >= 0
        AND "processed_rows" >= 0
        AND ("total_rows" IS NULL OR "total_rows" >= 0)
        AND ("total_rows" IS NULL OR "processed_rows" <= "total_rows")
    );

ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_row_number_positive"
    CHECK ("row_number" > 0);

ALTER TABLE "orders" ADD CONSTRAINT "orders_amount_and_currency_valid"
    CHECK ("order_value" >= 0 AND "currency" ~ '^[A-Z]{3}$');

ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_amounts_valid"
    CHECK (
        "gross_amount" >= 0
        AND "fee_amount" >= 0
        AND "tcs_amount" >= 0
        AND "tds_amount" >= 0
        AND ("billed_weight_kg" IS NULL OR "billed_weight_kg" >= 0)
        AND "currency" ~ '^[A-Z]{3}$'
    );

ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_period_valid"
    CHECK (
        "version" > 0
        AND ("effective_to" IS NULL OR "effective_to" > "effective_from")
        AND "currency" ~ '^[A-Z]{3}$'
    );

ALTER TABLE "rate_card_components" ADD CONSTRAINT "rate_card_components_values_valid"
    CHECK (
        "rate" >= 0
        AND "currency" ~ '^[A-Z]{3}$'
        AND ("min_weight_kg" IS NULL OR "min_weight_kg" >= 0)
        AND ("max_weight_kg" IS NULL OR "max_weight_kg" > 0)
        AND (
            "basis" <> 'WEIGHT_SLAB'
            OR (
                "min_weight_kg" IS NOT NULL
                AND "max_weight_kg" IS NOT NULL
                AND "max_weight_kg" > "min_weight_kg"
            )
        )
    );

ALTER TABLE "reconciliation_results" ADD CONSTRAINT "reconciliation_results_amounts_consistent"
    CHECK (
        "difference_amount" = "received_amount" - "expected_amount"
        AND "currency" ~ '^[A-Z]{3}$'
    );

ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_amount_valid"
    CHECK ("amount_at_risk" >= 0 AND "currency" ~ '^[A-Z]{3}$');

ALTER TABLE "claims" ADD CONSTRAINT "claims_amounts_valid"
    CHECK (
        "claim_amount" >= 0
        AND "recovered_amount" >= 0
        AND "recovered_amount" <= "claim_amount"
        AND "currency" ~ '^[A-Z]{3}$'
    );
