import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  ClaimStatus,
  ExceptionKind,
  ExceptionStatus,
  FinancialRecordKind,
  Prisma,
  ReconciliationRunStatus,
} from "@prisma/client";
import { prisma } from "../db";
import { reconcileOrder, unmatchedTransactionReason } from "./engine";

const RULES_VERSION = "reconcile-v1";
const PAGE_SIZE = 2_000;

export class ReconciliationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationConflictError";
  }
}

function fingerprint(
  batchIds: string[],
  linkedTransactions: Array<{ id: string; orderId: string }>,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      rulesVersion: RULES_VERSION,
      batchIds: [...batchIds].sort(),
      linkedTransactions: linkedTransactions
        .map(({ id, orderId }) => `${id}:${orderId}`)
        .sort(),
    }))
    .digest("hex");
}

export async function runReconciliation(input: {
  batchIds: string[];
  initiatedById: string;
  asOf?: Date;
}) {
  const batchIds = [...new Set(input.batchIds)].sort();
  if (batchIds.length === 0 || batchIds.length > 50) {
    throw new Error("Provide between 1 and 50 completed import batches.");
  }

  const batches = await prisma.importBatch.findMany({
    where: { id: { in: batchIds } },
    select: { id: true, status: true, mappingVersionId: true },
  });
  if (batches.length !== batchIds.length || batches.some((batch) => batch.status !== "COMPLETED")) {
    throw new Error("Every selected import batch must exist and be completed.");
  }

  const importedOrders = await prisma.order.findMany({
    where: { importRows: { some: { batchId: { in: batchIds } } } },
    select: { id: true },
  });
  const linkedTransactions = await prisma.financialTransaction.findMany({
    where: {
      orderId: { not: null },
      OR: [
        { importRow: { batchId: { in: batchIds } } },
        { orderId: { in: importedOrders.map((order) => order.id) } },
      ],
    },
    select: { id: true, orderId: true },
  });
  const inputFingerprint = fingerprint(
    batchIds,
    linkedTransactions.flatMap((transaction) =>
      transaction.orderId ? [{ id: transaction.id, orderId: transaction.orderId }] : [],
    ),
  );
  let run = await prisma.reconciliationRun.findUnique({
    where: { inputFingerprint },
  });
  if (run?.status === ReconciliationRunStatus.COMPLETED) {
    return { runId: run.id, idempotentReplay: true };
  }
  if (run?.status === ReconciliationRunStatus.RUNNING) {
    throw new ReconciliationConflictError("This input is already being reconciled.");
  }
  if (!run) {
    try {
      run = await prisma.reconciliationRun.create({
        data: {
          initiatedById: input.initiatedById,
          inputFingerprint,
          rulesVersion: RULES_VERSION,
          status: ReconciliationRunStatus.RUNNING,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ReconciliationConflictError("This input is already being reconciled.");
      }
      throw error;
    }
  } else {
    run = await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: { status: ReconciliationRunStatus.RUNNING, errorSummary: Prisma.DbNull },
    });
  }

  const asOf = input.asOf ?? new Date();
  const batchSet = new Set(batchIds);

  try {
    let cursor: string | undefined;
    for (;;) {
      const orders = await prisma.order.findMany({
        where: {
          OR: [
            { importRows: { some: { batchId: { in: batchIds } } } },
            { transactions: { some: { importRow: { batchId: { in: batchIds } } } } },
          ],
        },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        include: {
          transactions: true,
          channelPartner: { select: { id: true } },
          returnReceipts: { orderBy: { createdAt: "desc" }, take: 1 },
          refunds: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      });
      if (orders.length === 0) break;
      cursor = orders[orders.length - 1].id;

      const orderIds = orders.map((order) => order.id);
      const freightPartnerIds = [
        ...new Set(
          orders.flatMap((order) =>
            order.transactions
              .filter((transaction) => transaction.kind === FinancialRecordKind.FREIGHT_INVOICE)
              .map((transaction) => transaction.partnerId),
          ),
        ),
      ];
      const cards = await prisma.rateCard.findMany({
        where: {
          OR: [
            {
              channelPartnerId: { in: [...new Set(orders.map((order) => order.channelPartnerId))] },
              courierPartnerId: null,
            },
            { courierPartnerId: { in: freightPartnerIds } },
          ],
        },
        include: { components: true },
      });

      const pendingResults = await prisma.reconciliationResult.findMany({
        where: { runId: run.id, orderId: { in: orderIds } },
        select: { orderId: true },
      });
      const existingOrderIds = new Set(pendingResults.map((item) => item.orderId));
      const newOrders = orders.filter((order) => !existingOrderIds.has(order.id));
      if (newOrders.length === 0) continue;

      const resultRows: Prisma.ReconciliationResultCreateManyInput[] = [];
      const transactionRows: Prisma.ReconciliationTransactionCreateManyInput[] = [];
      const exceptionRows: Prisma.ReconciliationExceptionCreateManyInput[] = [];
      const claimRows: Prisma.ClaimCreateManyInput[] = [];

      for (const order of newOrders) {
        const orderTransactions = order.transactions;
        const freightPartnerSet = new Set(
          orderTransactions
            .filter((transaction) => transaction.kind === FinancialRecordKind.FREIGHT_INVOICE)
            .map((transaction) => transaction.partnerId),
        );
        const applicableCards = cards.filter((card) => {
          const effective = card.effectiveFrom <= order.orderDate &&
            (!card.effectiveTo || card.effectiveTo > order.orderDate);
          const channelCard = card.channelPartnerId === order.channelPartnerId &&
            card.courierPartnerId === null;
          const freightCard = card.courierPartnerId !== null &&
            freightPartnerSet.has(card.courierPartnerId);
          return effective && (channelCard || freightCard) && card.currency === order.currency;
        });
        const byLatestVersion = (left: (typeof cards)[number], right: (typeof cards)[number]) =>
          right.effectiveFrom.getTime() - left.effectiveFrom.getTime() ||
          right.version - left.version;
        const paymentCards = applicableCards
          .filter((card) => card.courierPartnerId === null)
          .sort(byLatestVersion)
          .slice(0, 1);
        const freightCards = applicableCards
          .filter((card) => card.courierPartnerId !== null)
          .sort(byLatestVersion);
        const hasApplicableRateCard =
          order.deliveryStatus === "RETURN_TO_WAREHOUSE" &&
          order.transactions.some(
            (transaction) => transaction.kind === FinancialRecordKind.FREIGHT_INVOICE,
          )
            ? freightCards.length > 0
            : paymentCards.length > 0;
        const selectedCards = [...paymentCards, ...freightCards];
        const decision = reconcileOrder(
          {
            order,
            transactions: orderTransactions,
            rateComponents: selectedCards.flatMap((card) =>
              card.components.map((component) => ({
                kind: component.kind,
                basis: component.basis,
                rate: component.rate,
                minWeightKg: component.minWeightKg,
                maxWeightKg: component.maxWeightKg,
              })),
            ),
            hasApplicableRateCard,
            returnReceipt: order.returnReceipts[0] ?? null,
            refund: order.refunds[0] ?? null,
          },
          asOf,
        );

        const resultId = randomUUID();
        const paymentCard = paymentCards[0];
        resultRows.push({
          id: resultId,
          runId: run.id,
          orderId: order.id,
          rateCardId: paymentCard?.id,
          status: decision.status,
          expectedAmount: decision.expectedAmount,
          receivedAmount: decision.receivedAmount,
          differenceAmount: decision.differenceAmount,
          currency: decision.currency,
          reasonCodes: decision.reasonCodes,
          explanation: decision.explanation,
        });
        for (const transaction of orderTransactions) {
          transactionRows.push({ resultId, transactionId: transaction.id });
        }
        for (const exception of decision.exceptions) {
          const exceptionId = randomUUID();
          const kind = exception.kind as ExceptionKind;
          const evidence = {
            ...exception.evidence,
            orderId: order.externalId,
            rateCards: selectedCards.map((card) => ({
              id: card.id,
              key: card.key,
              version: card.version,
            })),
            expectedComponents: decision.feeBreakdown,
            tcs: decision.tcsAmount.toFixed(2),
            tds: decision.tdsAmount.toFixed(2),
          };
          exceptionRows.push({
            id: exceptionId,
            resultId,
            partnerId:
              kind === ExceptionKind.FREIGHT_OVERCHARGE
                ? (orderTransactions.find(
                    (transaction) => transaction.kind === FinancialRecordKind.FREIGHT_INVOICE,
                  )?.partnerId ?? order.channelPartnerId)
                : order.channelPartnerId,
            kind,
            status: ExceptionStatus.OPEN,
            amountAtRisk: exception.amountAtRisk,
            currency: decision.currency,
            dueAt: exception.dueAt,
            evidenceSnapshot: evidence as Prisma.InputJsonValue,
          });
          if (
            kind === ExceptionKind.SHORT_PAYMENT ||
            kind === ExceptionKind.UNPAID_PAST_DUE ||
            kind === ExceptionKind.FREIGHT_OVERCHARGE ||
            kind === ExceptionKind.REFUND_MISMATCH
          ) {
            claimRows.push({
              id: randomUUID(),
              exceptionId,
              partnerId:
                kind === ExceptionKind.FREIGHT_OVERCHARGE
                  ? (orderTransactions.find(
                      (transaction) => transaction.kind === FinancialRecordKind.FREIGHT_INVOICE,
                    )?.partnerId ?? order.channelPartnerId)
                  : order.channelPartnerId,
              status: ClaimStatus.OPEN,
              claimAmount: exception.amountAtRisk,
              recoveredAmount: new Prisma.Decimal(0),
              currency: decision.currency,
              evidenceSnapshot: evidence as Prisma.InputJsonValue,
            });
          }
        }
      }

      await prisma.$transaction(async (tx) => {
        await tx.reconciliationResult.createMany({ data: resultRows, skipDuplicates: true });
        await tx.reconciliationTransaction.createMany({
          data: transactionRows,
          skipDuplicates: true,
        });
        await tx.reconciliationException.createMany({
          data: exceptionRows,
          skipDuplicates: true,
        });
        await tx.claim.createMany({ data: claimRows, skipDuplicates: true });
      }, { timeout: 30_000 });
    }

    const unmatched = await prisma.financialTransaction.findMany({
      where: {
        importRow: { batchId: { in: batchIds } },
        orderId: null,
      },
      select: {
        id: true,
        partnerId: true,
        currency: true,
        netAmount: true,
        externalReference: true,
      },
      take: 100_001,
    });
    if (unmatched.length > 100_000) {
      throw new Error("Too many unmatched transactions for one reconciliation run.");
    }
    if (unmatched.length > 0) {
      await prisma.reconciliationException.createMany({
        data: unmatched.map((transaction) => {
          const reason = unmatchedTransactionReason(transaction);
          return {
            id: randomUUID(),
            financialTransactionId: transaction.id,
            partnerId: transaction.partnerId,
            kind: ExceptionKind.MISSING_ORDER_REFERENCE,
            status: ExceptionStatus.OPEN,
            amountAtRisk: transaction.netAmount.abs(),
            currency: transaction.currency,
            evidenceSnapshot: reason.evidence as Prisma.InputJsonValue,
          };
        }),
        skipDuplicates: true,
      });
    }

    await prisma.$transaction([
      prisma.auditLog.create({
        data: {
          actorId: input.initiatedById,
          action: "RECONCILIATION_COMPLETED",
          entityType: "ReconciliationRun",
          entityId: run.id,
          details: {
            batchIds: [...batchSet],
            resultCount: await prisma.reconciliationResult.count({ where: { runId: run.id } }),
            unmatchedTransactionCount: unmatched.length,
          },
        },
      }),
      prisma.reconciliationRun.update({
        where: { id: run.id },
        data: { status: ReconciliationRunStatus.COMPLETED, completedAt: new Date() },
      }),
    ]);

    return {
      runId: run.id,
      idempotentReplay: false,
      resultCount: await prisma.reconciliationResult.count({ where: { runId: run.id } }),
      unmatchedTransactionCount: unmatched.length,
    };
  } catch (error) {
    await prisma.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: ReconciliationRunStatus.FAILED,
        errorSummary: {
          message: error instanceof Error ? error.message : "Unexpected reconciliation failure.",
        },
      },
    });
    throw error;
  }
}
