import { FinancialRecordKind, OrderDeliveryStatus, PaymentMethod, Prisma } from "@prisma/client";

const ZERO = new Prisma.Decimal(0);
const CLAIM_THRESHOLD = new Prisma.Decimal(10);

export type RateComponentInput = {
  kind: "MARKETPLACE_FEE" | "PAYMENT_FEE" | "COD_FEE" | "FREIGHT_FEE" | "OTHER";
  basis: "PERCENTAGE" | "FLAT_PER_ORDER" | "WEIGHT_SLAB";
  rate: Prisma.Decimal;
  minWeightKg: Prisma.Decimal | null;
  maxWeightKg: Prisma.Decimal | null;
};

export type ReconciliationInput = {
  order: {
    id: string;
    externalId: string;
    orderValue: Prisma.Decimal;
    currency: string;
    paymentMethod: PaymentMethod;
    deliveryStatus: OrderDeliveryStatus;
    deliveredAt: Date | null;
    settlementDueAt: Date | null;
  };
  transactions: Array<{
    id: string;
    kind: FinancialRecordKind;
    externalReference?: string | null;
    currency: string;
    netAmount: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
    tcsAmount: Prisma.Decimal;
    tdsAmount: Prisma.Decimal;
    billedWeightKg: Prisma.Decimal | null;
  }>;
  rateComponents: RateComponentInput[];
  hasApplicableRateCard: boolean;
  returnReceipt?: {
    expectedReceiptAt: Date | null;
    receivedAt: Date | null;
  } | null;
  refund?: {
    expectedAmount: Prisma.Decimal;
    refundedAmount: Prisma.Decimal;
    currency: string;
  } | null;
};

export type ReconciliationExceptionDraft = {
  kind:
    | "SHORT_PAYMENT"
    | "UNPAID_PAST_DUE"
    | "FREIGHT_OVERCHARGE"
    | "RETURN_NOT_RECEIVED"
    | "REFUND_MISMATCH"
    | "DUPLICATE_TRANSACTION"
    | "MISSING_ORDER_REFERENCE";
  amountAtRisk: Prisma.Decimal;
  dueAt: Date | null;
  evidence: Record<string, unknown>;
};

export type ReconciliationDecision = {
  status:
    | "SETTLED"
    | "PARTIAL_MATCH"
    | "SHORT_PAID"
    | "UNPAID_PAST_DUE"
    | "FREIGHT_OVERCHARGED"
    | "RETURN_NOT_RECEIVED"
    | "REFUND_MISMATCH"
    | "UNMATCHED_TRANSACTION"
    | "REVIEW_REQUIRED";
  currency: string;
  expectedAmount: Prisma.Decimal;
  receivedAmount: Prisma.Decimal;
  differenceAmount: Prisma.Decimal;
  tcsAmount: Prisma.Decimal;
  tdsAmount: Prisma.Decimal;
  feeBreakdown: Array<{ kind: string; expected: string }>;
  reasonCodes: string[];
  explanation: string;
  exceptions: ReconciliationExceptionDraft[];
};

function rounded(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function expectedComponent(
  component: RateComponentInput,
  orderValue: Prisma.Decimal,
  weight: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (component.basis === "PERCENTAGE") {
    return rounded(orderValue.mul(component.rate).div(100));
  }
  if (component.basis === "FLAT_PER_ORDER") return rounded(component.rate);
  if (
    !weight ||
    !component.minWeightKg ||
    !component.maxWeightKg ||
    weight.lt(component.minWeightKg) ||
    weight.gt(component.maxWeightKg)
  ) {
    return null;
  }
  return rounded(component.rate);
}

export function reconcileOrder(
  input: ReconciliationInput,
  asOf = new Date(),
): ReconciliationDecision {
  const paymentKind =
    input.order.paymentMethod === PaymentMethod.COD
      ? FinancialRecordKind.COD_REMITTANCE
      : FinancialRecordKind.SETTLEMENT;
  const paymentTransactions = input.transactions.filter(
    (transaction) => transaction.kind === paymentKind,
  );
  const freightTransactions = input.transactions.filter(
    (transaction) => transaction.kind === FinancialRecordKind.FREIGHT_INVOICE,
  );
  const refunds = input.transactions.filter(
    (transaction) => transaction.kind === FinancialRecordKind.REFUND,
  );
  const currencies = new Set([
    input.order.currency,
    ...input.transactions.map((transaction) => transaction.currency),
    ...(input.refund ? [input.refund.currency] : []),
  ]);
  const matchedCurrencies = [...currencies].every(
    (currency) => currency === input.order.currency,
  );
  const paymentReferences = paymentTransactions
    .map((transaction) => transaction.externalReference)
    .filter((reference): reference is string => Boolean(reference));
  const duplicateReferences = new Set(
    paymentReferences.filter(
      (reference, index) => paymentReferences.indexOf(reference) !== index,
    ),
  );

  const feeBreakdown: ReconciliationDecision["feeBreakdown"] = [];
  let expectedFees = ZERO;
  const paymentWeight = paymentTransactions.find(
    (transaction) => transaction.billedWeightKg,
  )?.billedWeightKg ?? null;

  for (const component of input.rateComponents.filter((item) => item.kind !== "FREIGHT_FEE")) {
    const expected = expectedComponent(component, input.order.orderValue, paymentWeight);
    if (expected !== null) {
      expectedFees = expectedFees.plus(expected);
      feeBreakdown.push({ kind: component.kind, expected: expected.toFixed(2) });
    }
  }

  const eligibleTransactions =
    input.order.deliveryStatus === OrderDeliveryStatus.RETURN_TO_WAREHOUSE
      ? freightTransactions
      : paymentTransactions;
  const paymentReceivedAmount = rounded(
    eligibleTransactions.reduce((sum, transaction) => sum.plus(transaction.netAmount), ZERO),
  );
  const tcsAmount = rounded(
    paymentTransactions.reduce((sum, transaction) => sum.plus(transaction.tcsAmount), ZERO),
  );
  const tdsAmount = rounded(
    paymentTransactions.reduce((sum, transaction) => sum.plus(transaction.tdsAmount), ZERO),
  );
  const expectedBeforeTax = rounded(input.order.orderValue.minus(expectedFees));
  const paymentExpectedAmount = rounded(expectedBeforeTax.minus(tcsAmount).minus(tdsAmount));
  const isFreightReconciliation =
    input.order.deliveryStatus === OrderDeliveryStatus.RETURN_TO_WAREHOUSE &&
    freightTransactions.length > 0;
  const freightComponents = input.rateComponents.filter(
    (component) => component.kind === "FREIGHT_FEE",
  );
  const freightWeight =
    freightTransactions.find((transaction) => transaction.billedWeightKg)
      ?.billedWeightKg ?? null;
  const expectedFreight = freightComponents.reduce((sum, component) => {
    const amount = expectedComponent(component, input.order.orderValue, freightWeight);
    return amount ? sum.plus(amount) : sum;
  }, ZERO);
  const billedFreight = rounded(
    freightTransactions.reduce((sum, transaction) => sum.plus(transaction.feeAmount), ZERO),
  );
  const freightDifference = rounded(expectedFreight.minus(billedFreight));
  const expectedAmount = isFreightReconciliation
    ? expectedFreight.negated()
    : paymentExpectedAmount;
  const receivedAmount = isFreightReconciliation
    ? billedFreight.negated()
    : paymentReceivedAmount;
  const differenceAmount = rounded(receivedAmount.minus(expectedAmount));
  const reasonCodes: string[] = [];
  const exceptions: ReconciliationExceptionDraft[] = [];
  let status: ReconciliationDecision["status"] = "SETTLED";
  const details: string[] = [];

  if (isFreightReconciliation) {
    status = "REVIEW_REQUIRED";
    reasonCodes.push("FREIGHT_COMPARISON");
    details.push("Courier invoice is compared against the effective freight rate card.");
  } else if (duplicateReferences.size > 0) {
    status = "REVIEW_REQUIRED";
    reasonCodes.push("DUPLICATE_TRANSACTION");
    details.push("Duplicate partner transaction references require manual review.");
    exceptions.push({
      kind: "DUPLICATE_TRANSACTION",
      amountAtRisk: receivedAmount.abs(),
      dueAt: null,
      evidence: {
        duplicateReferences: [...duplicateReferences],
        transactionIds: paymentTransactions.map((transaction) => transaction.id),
      },
    });
  } else if (!matchedCurrencies) {
    status = "REVIEW_REQUIRED";
    reasonCodes.push("CURRENCY_MISMATCH");
    details.push("Imported currency differs from the order currency.");
  } else if (!input.hasApplicableRateCard) {
    status = "REVIEW_REQUIRED";
    reasonCodes.push("RATE_CARD_NOT_FOUND");
    details.push("No effective rate card applies; the expected remittance cannot be verified.");
  } else if (differenceAmount.abs().lte(CLAIM_THRESHOLD)) {
    status = "SETTLED";
    reasonCodes.push("WITHIN_TOLERANCE");
    details.push("Net remittance is within the ₹10 review tolerance.");
  } else if (differenceAmount.lt(0)) {
    const isPastDue =
      paymentReceivedAmount.isZero() &&
      input.order.settlementDueAt !== null &&
      input.order.settlementDueAt < asOf;
    const notYetDue =
      paymentReceivedAmount.isZero() &&
      (input.order.settlementDueAt === null || input.order.settlementDueAt >= asOf);
    status = isPastDue
      ? "UNPAID_PAST_DUE"
      : notYetDue
        ? "REVIEW_REQUIRED"
        : paymentReceivedAmount.lt(paymentExpectedAmount)
          ? "PARTIAL_MATCH"
          : "SHORT_PAID";
    reasonCodes.push(
      isPastDue
        ? "UNPAID_PAST_DUE"
        : notYetDue
          ? "SETTLEMENT_NOT_DUE_OR_TERM_UNKNOWN"
          : "NET_SHORTFALL",
    );
    details.push(
      notYetDue
        ? "No remittance is recorded, but the partner due date has not passed or is unknown."
        : `Received ${paymentReceivedAmount.toFixed(2)} against expected ${paymentExpectedAmount.toFixed(2)}; difference ${differenceAmount.toFixed(2)}.`,
    );
    if (!notYetDue && (status !== "PARTIAL_MATCH" || differenceAmount.abs().gt(CLAIM_THRESHOLD))) {
      exceptions.push({
        kind: isPastDue ? "UNPAID_PAST_DUE" : "SHORT_PAYMENT",
        amountAtRisk: differenceAmount.abs(),
        dueAt: input.order.settlementDueAt,
        evidence: {
          expected: paymentExpectedAmount.toFixed(2),
          received: paymentReceivedAmount.toFixed(2),
          difference: rounded(paymentReceivedAmount.minus(paymentExpectedAmount)).toFixed(2),
          transactionIds: paymentTransactions.map((transaction) => transaction.id),
        },
      });
    }
  } else {
    status = "REVIEW_REQUIRED";
    reasonCodes.push("UNEXPECTED_OVERPAYMENT");
    details.push("Received amount exceeds the expected net amount; manual review is required.");
  }

  if (matchedCurrencies && freightTransactions.length > 0) {
    if (freightComponents.length === 0) {
      status = "REVIEW_REQUIRED";
      reasonCodes.push("FREIGHT_RATE_NOT_FOUND");
      details.push("A freight invoice exists but no applicable freight rate is configured.");
    } else {
      if (freightDifference.abs().lte(CLAIM_THRESHOLD)) {
        if (isFreightReconciliation) status = "SETTLED";
        reasonCodes.push("FREIGHT_WITHIN_TOLERANCE");
      } else if (freightDifference.lt(0)) {
        status = "FREIGHT_OVERCHARGED";
        reasonCodes.push("FREIGHT_OVERCHARGE");
        details.push(
          `Billed freight ${billedFreight.toFixed(2)} exceeds rate-card freight ${expectedFreight.toFixed(2)}.`,
        );
        exceptions.push({
          kind: "FREIGHT_OVERCHARGE",
          amountAtRisk: freightDifference.abs(),
          dueAt: null,
          evidence: {
            expectedFreight: expectedFreight.toFixed(2),
            billedFreight: billedFreight.toFixed(2),
            sourceTransactionIds: freightTransactions.map(
              (transaction) => transaction.id,
            ),
          },
        });
      }
    }
  }

  if (input.returnReceipt?.expectedReceiptAt && !input.returnReceipt.receivedAt &&
      input.returnReceipt.expectedReceiptAt < asOf) {
    status = "RETURN_NOT_RECEIVED";
    reasonCodes.push("RETURN_RECEIPT_OVERDUE");
    details.push("Expected return receipt date has elapsed with no warehouse receipt.");
    exceptions.push({
      kind: "RETURN_NOT_RECEIVED",
      amountAtRisk: ZERO,
      dueAt: input.returnReceipt.expectedReceiptAt,
      evidence: {
        expectedReceiptAt: input.returnReceipt.expectedReceiptAt.toISOString(),
        receivedAt: null,
      },
    });
  }

  if (input.refund) {
    const actualRefund = rounded(input.refund.refundedAmount);
    const refundGap = rounded(input.refund.expectedAmount.minus(actualRefund));
    if (refundGap.abs().gt(CLAIM_THRESHOLD)) {
      status = "REFUND_MISMATCH";
      reasonCodes.push("REFUND_MISMATCH");
      details.push(
        `Refund expected ${input.refund.expectedAmount.toFixed(2)}; recorded ${actualRefund.toFixed(2)}.`,
      );
      exceptions.push({
        kind: "REFUND_MISMATCH",
        amountAtRisk: refundGap.gt(0) ? refundGap : ZERO,
        dueAt: null,
        evidence: {
          expectedRefund: input.refund.expectedAmount.toFixed(2),
          actualRefund: actualRefund.toFixed(2),
          transactionIds: refunds.map((transaction) => transaction.id),
        },
      });
    }
  }

  return {
    status,
    currency: input.order.currency,
    expectedAmount,
    receivedAmount,
    differenceAmount,
    tcsAmount,
    tdsAmount,
    feeBreakdown,
    reasonCodes,
    explanation: details.join(" ") || "Order and partner records reconcile.",
    exceptions,
  };
}

export function unmatchedTransactionReason(
  transaction: { id: string; externalReference: string | null },
): ReconciliationExceptionDraft {
  return {
    kind: "MISSING_ORDER_REFERENCE",
    amountAtRisk: ZERO,
    dueAt: null,
    evidence: {
      transactionId: transaction.id,
      externalReference: transaction.externalReference,
      reason: "No unique exact order reference was available; manual matching is required.",
    },
  };
}
