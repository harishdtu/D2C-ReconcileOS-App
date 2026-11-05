import "server-only";

import {
  FinancialRecordKind,
  MappingSuggestionStatus,
  PartnerKind,
  Prisma,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { ReconciliationConflictError } from "./service";

const CHANNEL_PARTNERS = new Set<PartnerKind>([
  PartnerKind.WEBSITE,
  PartnerKind.MARKETPLACE,
  PartnerKind.QUICK_COMMERCE,
]);
const LOOKBACK_DAYS = 30;
const MAX_TRANSACTIONS_PER_GENERATION = 100;
const MAX_CANDIDATES_PER_TRANSACTION = 200;

export type CandidateTransaction = {
  id: string;
  partnerId: string;
  partner: { kind: PartnerKind };
  externalReference: string | null;
  transactionDate: Date;
  currency: string;
  grossAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  kind?: FinancialRecordKind;
};

export type CandidateOrder = {
  id: string;
  externalId: string;
  orderDate: Date;
  currency: string;
  orderValue: Prisma.Decimal;
  channelPartnerId: string;
  channelPartner: { code: string; name: string };
};

export type EvaluatedCandidate = {
  confidence: string;
  reason: string;
};

export function evaluateMatchCandidate(
  transaction: CandidateTransaction,
  order: CandidateOrder,
): EvaluatedCandidate | null {
  if (transaction.currency !== order.currency) return null;
  const ageMs = transaction.transactionDate.getTime() - order.orderDate.getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays < 0 || ageDays > LOOKBACK_DAYS) return null;

  const identifierMatch = transaction.externalReference === order.externalId;
  const grossMatch = transaction.grossAmount.gt(0) &&
    transaction.grossAmount.eq(order.orderValue);
  const netMatch = transaction.netAmount.gt(0) &&
    transaction.netAmount.eq(order.orderValue);
  const amountMatch = grossMatch || netMatch;
  const partnerComparable = CHANNEL_PARTNERS.has(transaction.partner.kind);
  const partnerMatch = transaction.partnerId === order.channelPartnerId;

  if (!identifierMatch && !amountMatch) return null;
  if (!identifierMatch && partnerComparable && !partnerMatch) return null;
  if (!identifierMatch && !partnerComparable) return null;

  const signals: string[] = [];
  let score = identifierMatch ? 0.9 : grossMatch ? 0.65 : 0.6;
  if (identifierMatch) signals.push("Source reference exactly matches the order ID.");
  if (grossMatch) {
    signals.push("Gross amount exactly matches the order value.");
    if (identifierMatch) score += 0.05;
  } else if (netMatch) {
    signals.push("Net amount exactly matches the order value.");
  }
  if (partnerMatch) {
    signals.push("Source partner matches the order channel.");
    score += 0.05;
  } else if (partnerComparable) {
    signals.push("Source partner does not match the order channel.");
  } else {
    signals.push("Source partner is not directly comparable to an order channel.");
  }
  if (ageDays <= 7) {
    signals.push("Transaction occurred within 7 days after the order.");
    score += 0.05;
  } else {
    signals.push(`Transaction occurred ${Math.floor(ageDays)} days after the order.`);
  }
  score = Math.min(score, 0.99);
  return { confidence: score.toFixed(4), reason: signals.join(" ") };
}

export async function generateMatchCandidates(input: {
  batchIds?: string[];
  afterId?: string;
  actorId: string;
}) {
  const batchIds = input.batchIds ? [...new Set(input.batchIds)] : undefined;
  const transactions = await prisma.financialTransaction.findMany({
    where: {
      orderId: null,
      ...(input.afterId ? { id: { gt: input.afterId } } : {}),
      ...(batchIds ? { importRow: { batchId: { in: batchIds } } } : {}),
    },
    orderBy: { id: "asc" },
    take: MAX_TRANSACTIONS_PER_GENERATION + 1,
    select: {
      id: true,
      partnerId: true,
      externalReference: true,
      transactionDate: true,
      currency: true,
      grossAmount: true,
      netAmount: true,
      kind: true,
      source: { select: { partner: { select: { kind: true } } } },
      matchSuggestions: { select: { candidateOrderId: true, status: true } },
    },
  });
  const hasMoreTransactions = transactions.length > MAX_TRANSACTIONS_PER_GENERATION;
  const pageTransactions = transactions.slice(0, MAX_TRANSACTIONS_PER_GENERATION);

  const suggestions: Prisma.MatchSuggestionCreateManyInput[] = [];
  let matchedTransactions = 0;
  let tooAmbiguousTransactions = 0;
  for (const transaction of pageTransactions) {
    const minDate = new Date(
      transaction.transactionDate.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    const amountFilters: Prisma.OrderWhereInput[] = [];
    if (transaction.grossAmount.gt(0)) {
      amountFilters.push({ orderValue: transaction.grossAmount });
    }
    if (transaction.netAmount.gt(0) && !transaction.netAmount.eq(transaction.grossAmount)) {
      amountFilters.push({ orderValue: transaction.netAmount });
    }
    const possibleMatches: Prisma.OrderWhereInput[] = [];
    if (transaction.externalReference) {
      possibleMatches.push({ externalId: transaction.externalReference });
    }
    possibleMatches.push(...amountFilters);
    if (possibleMatches.length === 0) continue;

    const orders = await prisma.order.findMany({
      where: {
        currency: transaction.currency,
        orderDate: { gte: minDate, lte: transaction.transactionDate },
        OR: possibleMatches,
      },
      orderBy: [{ orderDate: "desc" }, { id: "asc" }],
      take: MAX_CANDIDATES_PER_TRANSACTION + 1,
      select: {
        id: true,
        externalId: true,
        orderDate: true,
        currency: true,
        orderValue: true,
        channelPartnerId: true,
        channelPartner: { select: { code: true, name: true } },
      },
    });
    if (orders.length > MAX_CANDIDATES_PER_TRANSACTION) {
      tooAmbiguousTransactions += 1;
      continue;
    }
    let transactionHasCandidate = transaction.matchSuggestions.some(
      (suggestion) => suggestion.status === MappingSuggestionStatus.PENDING,
    );
    const existingCandidateIds = new Set(
      transaction.matchSuggestions.map((suggestion) => suggestion.candidateOrderId),
    );
    for (const order of orders) {
      if (existingCandidateIds.has(order.id)) continue;
      const evaluated = evaluateMatchCandidate(
        {
          ...transaction,
          partner: { kind: transaction.source.partner.kind },
        },
        order,
      );
      if (!evaluated) continue;
      transactionHasCandidate = true;
      suggestions.push({
        id: randomUUID(),
        financialTransactionId: transaction.id,
        candidateOrderId: order.id,
        status: MappingSuggestionStatus.PENDING,
        confidence: new Prisma.Decimal(evaluated.confidence),
        reason: evaluated.reason,
      });
    }
    if (transactionHasCandidate) matchedTransactions += 1;
  }

  const created = suggestions.length
    ? await prisma.matchSuggestion.createMany({ data: suggestions, skipDuplicates: true })
    : { count: 0 };
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: "MATCH_CANDIDATES_GENERATED",
      entityType: "MatchCandidateGeneration",
      entityId: batchIds?.[0] ?? "unmatched-queue",
      details: {
        batchIds: batchIds ?? [],
        transactionsReviewed: pageTransactions.length,
        transactionsWithCandidates: matchedTransactions,
        candidateCount: created.count,
        transactionsWithoutCandidates: pageTransactions.length - matchedTransactions - tooAmbiguousTransactions,
        tooAmbiguousTransactions,
        afterId: input.afterId ?? null,
      },
    },
  });
  return {
    transactionsReviewed: pageTransactions.length,
    transactionsWithCandidates: matchedTransactions,
    candidatesCreated: created.count,
    transactionsWithoutCandidates: pageTransactions.length - matchedTransactions - tooAmbiguousTransactions,
    tooAmbiguousTransactions,
    nextCursor: hasMoreTransactions ? pageTransactions[pageTransactions.length - 1]?.id ?? null : null,
    limitReached: hasMoreTransactions,
  };
}

export async function listPendingMatchCandidates(input: {
  page: number;
  limit: number;
}) {
  const where: Prisma.MatchSuggestionWhereInput = {
    status: MappingSuggestionStatus.PENDING,
    transaction: { orderId: null },
  };
  const [total, candidates] = await Promise.all([
    prisma.matchSuggestion.count({ where }),
    prisma.matchSuggestion.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (input.page - 1) * input.limit,
      take: input.limit,
      select: {
        id: true,
        confidence: true,
        reason: true,
        createdAt: true,
        transaction: {
          select: {
            id: true,
            kind: true,
            externalReference: true,
            transactionDate: true,
            currency: true,
            grossAmount: true,
            netAmount: true,
            partner: { select: { code: true, name: true } },
            importRow: { select: { rowNumber: true, batch: { select: { fileName: true } } } },
          },
        },
        candidateOrder: {
          select: {
            id: true,
            externalId: true,
            orderDate: true,
            orderValue: true,
            currency: true,
            channelPartner: { select: { code: true, name: true } },
          },
        },
      },
    }),
  ]);
  const transactionIds = [...new Set(candidates.map((candidate) =>
    candidate.transaction.id,
  ))];
  const alternatives = transactionIds.length
    ? await prisma.matchSuggestion.groupBy({
        by: ["financialTransactionId"],
        where: {
          financialTransactionId: { in: transactionIds },
          status: MappingSuggestionStatus.PENDING,
        },
        _count: { _all: true },
      })
    : [];
  const alternativeCounts = new Map(
    alternatives.map((item) => [item.financialTransactionId, item._count._all]),
  );
  return {
    candidates: candidates.map((candidate) => ({
      ...candidate,
      confidence: candidate.confidence?.toFixed(4) ?? null,
      transaction: {
        ...candidate.transaction,
        grossAmount: candidate.transaction.grossAmount.toFixed(2),
        netAmount: candidate.transaction.netAmount.toFixed(2),
        alternatives: alternativeCounts.get(candidate.transaction.id) ?? 1,
      },
      candidateOrder: {
        ...candidate.candidateOrder,
        orderValue: candidate.candidateOrder.orderValue.toFixed(2),
      },
    })),
    page: input.page,
    limit: input.limit,
    total,
    pageCount: Math.ceil(total / input.limit),
  };
}

export async function decideMatchCandidate(input: {
  suggestionId: string;
  decision: "accept" | "reject";
  actorId: string;
}) {
  const suggestion = await prisma.matchSuggestion.findUnique({
    where: { id: input.suggestionId },
    select: {
      id: true,
      status: true,
      confidence: true,
      reason: true,
      financialTransactionId: true,
      candidateOrderId: true,
      transaction: {
        select: {
          orderId: true,
          id: true,
          partnerId: true,
          externalReference: true,
          transactionDate: true,
          currency: true,
          grossAmount: true,
          netAmount: true,
          source: { select: { partner: { select: { kind: true } } } },
        },
      },
      candidateOrder: {
        select: {
          id: true,
          externalId: true,
          orderDate: true,
          currency: true,
          orderValue: true,
          channelPartnerId: true,
          channelPartner: { select: { code: true, name: true } },
        },
      },
    },
  });
  if (!suggestion || suggestion.status !== MappingSuggestionStatus.PENDING) {
    throw new ReconciliationConflictError("This match suggestion is no longer pending.");
  }
  if (suggestion.transaction.orderId !== null) {
    throw new ReconciliationConflictError("This financial transaction has already been linked.");
  }
  if (input.decision === "accept") {
    const valid = evaluateMatchCandidate(
      {
        ...suggestion.transaction,
        partner: { kind: suggestion.transaction.source.partner.kind },
      },
      suggestion.candidateOrder,
    );
    if (!valid) {
      throw new ReconciliationConflictError(
        "The candidate no longer satisfies the deterministic matching checks.",
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    if (input.decision === "accept") {
      const linked = await tx.financialTransaction.updateMany({
        where: { id: suggestion.financialTransactionId, orderId: null },
        data: { orderId: suggestion.candidateOrderId },
      });
      if (linked.count !== 1) {
        throw new ReconciliationConflictError("This financial transaction was linked by another review.");
      }
    }
    const decided = await tx.matchSuggestion.updateMany({
      where: {
        id: suggestion.id,
        status: MappingSuggestionStatus.PENDING,
      },
      data: {
        status: input.decision === "accept"
          ? MappingSuggestionStatus.APPROVED
          : MappingSuggestionStatus.REJECTED,
        decidedById: input.actorId,
        decidedAt: new Date(),
      },
    });
    if (decided.count !== 1) {
      throw new ReconciliationConflictError("This match suggestion was decided by another reviewer.");
    }

    let supersededCount = 0;
    if (input.decision === "accept") {
      const superseded = await tx.matchSuggestion.updateMany({
        where: {
          financialTransactionId: suggestion.financialTransactionId,
          id: { not: suggestion.id },
          status: MappingSuggestionStatus.PENDING,
        },
        data: {
          status: MappingSuggestionStatus.REJECTED,
          decidedById: input.actorId,
          decidedAt: new Date(),
        },
      });
      supersededCount = superseded.count;
    }
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.decision === "accept" ? "MATCH_CANDIDATE_ACCEPTED" : "MATCH_CANDIDATE_REJECTED",
        entityType: "MatchSuggestion",
        entityId: suggestion.id,
        details: {
          transactionId: suggestion.financialTransactionId,
          orderId: suggestion.candidateOrderId,
          confidence: suggestion.confidence?.toFixed(4) ?? null,
          reason: suggestion.reason,
          supersededCandidateCount: supersededCount,
        },
      },
    });
  });
  return {
    status: input.decision === "accept" ? "APPROVED" : "REJECTED",
    linked: input.decision === "accept",
  };
}
