import "server-only";

import {
  ExceptionKind,
  ExceptionStatus,
  FinancialRecordKind,
  Prisma,
} from "@prisma/client";
import { prisma } from "../db";
import { moneyAtRiskByPartner } from "../exceptions/service";

export async function getDashboardOverview() {
  const [orders, received, openExceptions, recentRuns, latestCompletedRun, riskByPartner] =
    await Promise.all([
      prisma.order.groupBy({
        by: ["currency"],
        _count: { _all: true },
        _sum: { orderValue: true },
      }),
      prisma.financialTransaction.groupBy({
        by: ["currency"],
        where: {
          kind: {
            in: [
              FinancialRecordKind.SETTLEMENT,
              FinancialRecordKind.COD_REMITTANCE,
            ],
          },
        },
        _sum: { netAmount: true },
      }),
      prisma.reconciliationException.groupBy({
        by: ["currency"],
        where: {
          status: { in: [ExceptionStatus.OPEN, ExceptionStatus.IN_REVIEW] },
          amountAtRisk: { gt: new Prisma.Decimal(0) },
        },
        _count: { _all: true },
        _sum: { amountAtRisk: true },
      }),
      prisma.reconciliationRun.findMany({
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: 5,
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          initiatedBy: { select: { email: true } },
          _count: { select: { results: true } },
        },
      }),
      prisma.reconciliationRun.findFirst({
        where: { status: "COMPLETED" },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: { id: true },
      }),
      moneyAtRiskByPartner(),
    ]);

  const [latestExceptionGroups, codGroups] = latestCompletedRun
    ? await Promise.all([
        prisma.reconciliationException.groupBy({
          by: ["currency", "kind"],
          where: {
            result: { runId: latestCompletedRun.id },
            kind: {
              in: [
                ExceptionKind.SHORT_PAYMENT,
                ExceptionKind.UNPAID_PAST_DUE,
                ExceptionKind.FREIGHT_OVERCHARGE,
              ],
            },
          },
          _count: { _all: true },
          _sum: { amountAtRisk: true },
        }),
        prisma.reconciliationResult.groupBy({
          by: ["currency", "status"],
          where: { runId: latestCompletedRun.id, order: { paymentMethod: "COD" } },
          _count: { _all: true },
          _sum: { expectedAmount: true, receivedAmount: true },
        }),
      ])
    : [[], []];
  const discrepancies = new Map<string, {
    count: number;
    amount: Prisma.Decimal;
  }>();
  for (const exception of latestExceptionGroups) {
    const current = discrepancies.get(exception.currency) ?? {
      count: 0,
      amount: new Prisma.Decimal(0),
    };
    current.count += exception._count._all;
    current.amount = current.amount.plus(
      exception._sum.amountAtRisk ?? new Prisma.Decimal(0),
    );
    discrepancies.set(exception.currency, current);
  }

  const orderCount = orders.reduce((total, row) => total + row._count._all, 0);
  const openExceptionCount = openExceptions.reduce(
    (total, row) => total + row._count._all,
    0,
  );
  const currencyKeys = new Set([
    ...orders.map((row) => row.currency),
    ...received.map((row) => row.currency),
    ...openExceptions.map((row) => row.currency),
    ...discrepancies.keys(),
  ]);
  const codByCurrency = new Map<string, {
    totalCount: number;
    settledCount: number;
    receivedAmount: Prisma.Decimal;
  }>();
  for (const result of codGroups) {
    const current = codByCurrency.get(result.currency) ?? {
      totalCount: 0,
      settledCount: 0,
      receivedAmount: new Prisma.Decimal(0),
    };
    current.totalCount += result._count._all;
    if (result.status === "SETTLED") current.settledCount += result._count._all;
    current.receivedAmount = current.receivedAmount.plus(
      result._sum.receivedAmount ?? new Prisma.Decimal(0),
    );
    codByCurrency.set(result.currency, current);
  }
  const byCurrency = [...currencyKeys].sort().map((currency) => {
    const orderRow = orders.find((row) => row.currency === currency);
    const receivedRow = received.find((row) => row.currency === currency);
    const exceptionRow = openExceptions.find((row) => row.currency === currency);
    const discrepancy = discrepancies.get(currency);
    return {
      currency,
      orderCount: orderRow?._count._all ?? 0,
      orderValue: (orderRow?._sum.orderValue ?? new Prisma.Decimal(0)).toFixed(2),
      paymentsReceived: (receivedRow?._sum.netAmount ?? new Prisma.Decimal(0)).toFixed(2),
      openExceptionCount: exceptionRow?._count._all ?? 0,
      openExceptionAmount: (exceptionRow?._sum.amountAtRisk ?? new Prisma.Decimal(0)).toFixed(2),
      latestRunDiscrepancyCount: discrepancy?.count ?? 0,
      latestRunDiscrepancyAmount: (discrepancy?.amount ?? new Prisma.Decimal(0)).toFixed(2),
      codTotalCount: codByCurrency.get(currency)?.totalCount ?? 0,
      codSettledCount: codByCurrency.get(currency)?.settledCount ?? 0,
      codReceivedAmount: (codByCurrency.get(currency)?.receivedAmount ?? new Prisma.Decimal(0)).toFixed(2),
    };
  });

  return {
    orderCount,
    openExceptionCount,
    byCurrency,
    riskByPartner,
    latestCompletedRunId: latestCompletedRun?.id ?? null,
    recentRuns: recentRuns.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      initiatedBy: run.initiatedBy.email,
      resultCount: run._count.results,
    })),
  };
}

export type DashboardOverview = Awaited<ReturnType<typeof getDashboardOverview>>;
