import { describe, expect, it } from "vitest";
import {
  FinancialRecordKind,
  OrderDeliveryStatus,
  PaymentMethod,
  Prisma,
} from "@prisma/client";
import {
  reconcileOrder,
  unmatchedTransactionReason,
  type ReconciliationInput,
} from "../src/lib/reconciliation/engine";

const asOf = new Date("2026-11-03T00:00:00.000Z");
const rateCard = [{
  kind: "MARKETPLACE_FEE" as const,
  basis: "FLAT_PER_ORDER" as const,
  rate: new Prisma.Decimal("100"),
  minWeightKg: null,
  maxWeightKg: null,
}];

function input(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    order: {
      id: "order-1",
      externalId: "ORD-1",
      orderValue: new Prisma.Decimal("1000.00"),
      currency: "INR",
      paymentMethod: PaymentMethod.PREPAID,
      deliveryStatus: OrderDeliveryStatus.DELIVERED,
      deliveredAt: new Date("2026-10-01T00:00:00.000Z"),
      settlementDueAt: new Date("2026-10-10T00:00:00.000Z"),
    },
    transactions: [{
      id: "txn-1",
      kind: FinancialRecordKind.SETTLEMENT,
      externalReference: "SET-1",
      currency: "INR",
      netAmount: new Prisma.Decimal("900.00"),
      feeAmount: new Prisma.Decimal("100.00"),
      tcsAmount: new Prisma.Decimal("0"),
      tdsAmount: new Prisma.Decimal("0"),
      billedWeightKg: null,
    }],
    rateComponents: rateCard,
    hasApplicableRateCard: true,
    ...overrides,
  };
}

describe("deterministic reconciliation engine", () => {
  it("reconciles an exact net settlement with decimal-safe amounts", () => {
    const result = reconcileOrder(input(), asOf);
    expect(result.status).toBe("SETTLED");
    expect(result.expectedAmount.toFixed(2)).toBe("900.00");
    expect(result.receivedAmount.toFixed(2)).toBe("900.00");
    expect(result.differenceAmount.toFixed(2)).toBe("0.00");
    expect(result.explanation).toContain("within the ₹10");
  });

  it("keeps a partial remittance visible and creates a shortfall exception", () => {
    const result = reconcileOrder(input({
      transactions: [{
        ...input().transactions[0],
        netAmount: new Prisma.Decimal("400.00"),
      }],
    }), asOf);
    expect(result.status).toBe("PARTIAL_MATCH");
    expect(result.differenceAmount.toFixed(2)).toBe("-500.00");
    expect(result.exceptions[0].kind).toBe("SHORT_PAYMENT");
    expect(result.exceptions[0].amountAtRisk.toFixed(2)).toBe("500.00");
  });

  it("classifies a wholly missing overdue remittance only after the configured due date", () => {
    const result = reconcileOrder(input({ transactions: [] }), asOf);
    expect(result.status).toBe("UNPAID_PAST_DUE");
    expect(result.exceptions[0].kind).toBe("UNPAID_PAST_DUE");
  });

  it("does not claim a missing remittance before or without a due date", () => {
    const beforeDue = reconcileOrder(input({
      transactions: [],
      order: { ...input().order, settlementDueAt: new Date("2026-11-04T00:00:00.000Z") },
    }), asOf);
    const unknownDue = reconcileOrder(input({
      transactions: [],
      order: { ...input().order, settlementDueAt: null },
    }), asOf);
    expect(beforeDue.status).toBe("REVIEW_REQUIRED");
    expect(beforeDue.exceptions).toHaveLength(0);
    expect(unknownDue.status).toBe("REVIEW_REQUIRED");
    expect(unknownDue.exceptions).toHaveLength(0);
  });

  it("does not treat statutory withholding as leakage", () => {
    const transaction = {
      ...input().transactions[0],
      netAmount: new Prisma.Decimal("880.00"),
      tcsAmount: new Prisma.Decimal("15.00"),
      tdsAmount: new Prisma.Decimal("5.00"),
    };
    const result = reconcileOrder(input({ transactions: [transaction] }), asOf);
    expect(result.status).toBe("SETTLED");
    expect(result.expectedAmount.toFixed(2)).toBe("880.00");
    expect(result.tcsAmount.toFixed(2)).toBe("15.00");
    expect(result.tdsAmount.toFixed(2)).toBe("5.00");
  });

  it("routes currency mismatches to review", () => {
    const result = reconcileOrder(input({
      transactions: [{
        ...input().transactions[0],
        currency: "USD",
      }],
    }), asOf);
    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toContain("CURRENCY_MISMATCH");
  });

  it("does not count duplicate transaction references as settled", () => {
    const transaction = input().transactions[0];
    const result = reconcileOrder(input({
      transactions: [
        transaction,
        { ...transaction, id: "txn-2", netAmount: new Prisma.Decimal("900.00") },
      ],
    }), asOf);
    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toContain("DUPLICATE_TRANSACTION");
    expect(result.exceptions[0].kind).toBe("DUPLICATE_TRANSACTION");
  });

  it("compares return freight as negative expense amounts and flags overcharges", () => {
    const result = reconcileOrder(input({
      order: {
        ...input().order,
        deliveryStatus: OrderDeliveryStatus.RETURN_TO_WAREHOUSE,
      },
      transactions: [{
        ...input().transactions[0],
        kind: FinancialRecordKind.FREIGHT_INVOICE,
        netAmount: new Prisma.Decimal("-142.00"),
        feeAmount: new Prisma.Decimal("142.00"),
        billedWeightKg: new Prisma.Decimal("0.5"),
      }],
      rateComponents: [{
        kind: "FREIGHT_FEE",
        basis: "WEIGHT_SLAB",
        rate: new Prisma.Decimal("96.00"),
        minWeightKg: new Prisma.Decimal("0"),
        maxWeightKg: new Prisma.Decimal("1"),
      }],
    }), asOf);
    expect(result.status).toBe("FREIGHT_OVERCHARGED");
    expect(result.expectedAmount.toFixed(2)).toBe("-96.00");
    expect(result.receivedAmount.toFixed(2)).toBe("-142.00");
    expect(result.differenceAmount.toFixed(2)).toBe("-46.00");
    expect(result.exceptions[0].kind).toBe("FREIGHT_OVERCHARGE");
  });

  it("detects refunds that differ from the expected approved amount", () => {
    const result = reconcileOrder(input({
      refund: {
        expectedAmount: new Prisma.Decimal("500"),
        refundedAmount: new Prisma.Decimal("450"),
        currency: "INR",
      },
    }), asOf);
    expect(result.status).toBe("REFUND_MISMATCH");
    expect(result.exceptions.some((item) => item.kind === "REFUND_MISMATCH")).toBe(true);
  });

  it("flags a return only after its supplied receipt date has elapsed", () => {
    const result = reconcileOrder(input({
      returnReceipt: {
        expectedReceiptAt: new Date("2026-10-30T00:00:00.000Z"),
        receivedAt: null,
      },
    }), asOf);
    expect(result.status).toBe("RETURN_NOT_RECEIVED");
    expect(result.exceptions.some((item) => item.kind === "RETURN_NOT_RECEIVED")).toBe(true);
  });

  it("requires review instead of inventing a rate when no rate card applies", () => {
    const result = reconcileOrder(input({ hasApplicableRateCard: false }), asOf);
    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toContain("RATE_CARD_NOT_FOUND");
  });

  it("explains why an unmatched transaction needs manual order matching", () => {
    const exception = unmatchedTransactionReason({
      id: "txn-unmatched",
      externalReference: "UNKNOWN-ORDER",
    });
    expect(exception.kind).toBe("MISSING_ORDER_REFERENCE");
    expect(exception.evidence).toMatchObject({
      transactionId: "txn-unmatched",
      externalReference: "UNKNOWN-ORDER",
    });
    expect(exception.evidence.reason).toContain("manual matching");
  });
});
