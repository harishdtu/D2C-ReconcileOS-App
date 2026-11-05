import "server-only";

import {
  ClaimStatus,
  ExceptionStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../db";

export class ExceptionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExceptionTransitionError";
  }
}

const transitions: Record<ExceptionStatus, ReadonlySet<ExceptionStatus>> = {
  OPEN: new Set(["IN_REVIEW", "RESOLVED", "DISMISSED"]),
  IN_REVIEW: new Set(["OPEN", "RESOLVED", "DISMISSED"]),
  RESOLVED: new Set(),
  DISMISSED: new Set(),
};

export async function transitionException(input: {
  exceptionId: string;
  actorId: string;
  status: ExceptionStatus;
  resolutionNote: string;
}) {
  return prisma.$transaction(async (tx) => {
    const exception = await tx.reconciliationException.findUnique({
      where: { id: input.exceptionId },
      include: { claim: true },
    });
    if (!exception) throw new ExceptionTransitionError("Exception was not found.");
    if (!transitions[exception.status].has(input.status)) {
      throw new ExceptionTransitionError(
        `Transition from ${exception.status} to ${input.status} is not allowed.`,
      );
    }
    if (
      (input.status === ExceptionStatus.RESOLVED ||
        input.status === ExceptionStatus.DISMISSED) &&
      input.resolutionNote.trim().length < 10
    ) {
      throw new ExceptionTransitionError(
        "A resolution note of at least 10 characters is required.",
      );
    }
    if (
      input.status === ExceptionStatus.OPEN &&
      exception.claim &&
      exception.claim.recoveredAmount.gt(0)
    ) {
      throw new ExceptionTransitionError(
        "A claim with a recorded recovery cannot be reopened automatically.",
      );
    }

    const updated = await tx.reconciliationException.update({
      where: { id: exception.id },
      data: {
        status: input.status,
        resolutionNote: input.resolutionNote.trim() || null,
      },
    });
    if (exception.claim) {
      const claimStatus =
        input.status === ExceptionStatus.RESOLVED
          ? ClaimStatus.CLOSED
          : input.status === ExceptionStatus.DISMISSED
            ? ClaimStatus.DISMISSED
            : ClaimStatus.OPEN;
      await tx.claim.update({
        where: { id: exception.claim.id },
        data: { status: claimStatus },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "EXCEPTION_STATUS_CHANGED",
        entityType: "ReconciliationException",
        entityId: exception.id,
        details: {
          from: exception.status,
          to: input.status,
          resolutionNote: input.resolutionNote.trim(),
        },
      },
    });
    return updated;
  });
}

export async function exceptionDetails(exceptionId: string) {
  return prisma.reconciliationException.findUnique({
    where: { id: exceptionId },
    include: {
      partner: { select: { id: true, code: true, name: true, kind: true } },
      result: {
        include: {
          order: { select: { externalId: true, orderValue: true, currency: true } },
          matchedTransactions: {
            include: {
              transaction: {
                include: {
                  importRow: {
                    select: { rowNumber: true, batch: { select: { fileName: true } } },
                  },
                },
              },
            },
          },
        },
      },
      financialTransaction: {
        include: {
          importRow: {
            select: { rowNumber: true, batch: { select: { fileName: true } } },
          },
        },
      },
      claim: true,
    },
  });
}

export async function listClaims(input: {
  partnerCode?: string;
  status?: ClaimStatus;
  search?: string;
  cursor?: string;
  limit: number;
}) {
  const partner = input.partnerCode
    ? await prisma.partner.findUnique({
        where: { code: input.partnerCode },
        select: { id: true },
      })
    : null;
  if (input.partnerCode && !partner) return { claims: [], nextCursor: null };
  const where: Prisma.ClaimWhereInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(partner ? { partnerId: partner.id } : {}),
    ...(input.search
      ? {
          OR: [
            { partner: { name: { contains: input.search, mode: "insensitive" } } },
            {
              exception: {
                result: {
                  order: { externalId: { contains: input.search, mode: "insensitive" } },
                },
              },
            },
            {
              exception: {
                financialTransaction: {
                  externalReference: { contains: input.search, mode: "insensitive" },
                },
              },
            },
          ],
        }
      : {}),
  };
  const claims = await prisma.claim.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
    include: {
      partner: { select: { code: true, name: true } },
      exception: {
        include: {
          result: {
            include: {
              order: { select: { externalId: true } },
              matchedTransactions: {
                include: {
                  transaction: {
                    include: {
                      importRow: { select: { rowNumber: true, batch: { select: { fileName: true } } } },
                    },
                  },
                },
              },
            },
          },
          financialTransaction: {
            include: {
              importRow: { select: { rowNumber: true, batch: { select: { fileName: true } } } },
            },
          },
        },
      },
    },
  });
  const hasMore = claims.length > input.limit;
  if (hasMore) claims.pop();
  return {
    claims,
    nextCursor: hasMore ? claims[claims.length - 1]?.id ?? null : null,
  };
}

export async function moneyAtRiskByPartner(asOf = new Date()) {
  const openExceptions = {
    status: { in: [ExceptionStatus.OPEN, ExceptionStatus.IN_REVIEW] },
    amountAtRisk: { gt: new Prisma.Decimal(0) },
  } satisfies Prisma.ReconciliationExceptionWhereInput;
  const partners = await prisma.partner.findMany({
    where: { exceptions: { some: openExceptions } },
    select: {
      id: true,
      code: true,
      name: true,
      exceptions: {
        where: openExceptions,
        select: { amountAtRisk: true, currency: true, createdAt: true, dueAt: true },
      },
    },
  });
  const day = 24 * 60 * 60 * 1000;
  return partners.map((partner) => {
    const totals = new Map<string, {
      total: Prisma.Decimal;
      age0To7: Prisma.Decimal;
      age8To30: Prisma.Decimal;
      age31Plus: Prisma.Decimal;
    }>();
    for (const exception of partner.exceptions) {
      const bucket = totals.get(exception.currency) ?? {
        total: new Prisma.Decimal(0),
        age0To7: new Prisma.Decimal(0),
        age8To30: new Prisma.Decimal(0),
        age31Plus: new Prisma.Decimal(0),
      };
      const age = Math.max(0, Math.floor((asOf.getTime() - exception.createdAt.getTime()) / day));
      bucket.total = bucket.total.plus(exception.amountAtRisk);
      if (age <= 7) bucket.age0To7 = bucket.age0To7.plus(exception.amountAtRisk);
      else if (age <= 30) bucket.age8To30 = bucket.age8To30.plus(exception.amountAtRisk);
      else bucket.age31Plus = bucket.age31Plus.plus(exception.amountAtRisk);
      totals.set(exception.currency, bucket);
    }
    return {
      partner: { id: partner.id, code: partner.code, name: partner.name },
      currencies: [...totals.entries()].map(([currency, amounts]) => ({
        currency,
        total: amounts.total.toFixed(2),
        age0To7: amounts.age0To7.toFixed(2),
        age8To30: amounts.age8To30.toFixed(2),
        age31Plus: amounts.age31Plus.toFixed(2),
      })),
    };
  });
}

export function claimExportRows(
  claims: Awaited<ReturnType<typeof listClaims>>["claims"],
): string {
  const fields = [
    "claim_id",
    "partner",
    "order_id",
    "status",
    "claim_amount",
    "recovered_amount",
    "currency",
    "exception_kind",
    "expected",
    "received",
    "difference",
    "evidence",
  ];
  const quote = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = claims.map((claim) => {
    const result = claim.exception.result;
    const snapshot = claim.evidenceSnapshot as Prisma.JsonObject;
    return [
      claim.id,
      claim.partner.name,
      result?.order.externalId ?? "",
      claim.status,
      claim.claimAmount.toFixed(2),
      claim.recoveredAmount.toFixed(2),
      claim.currency,
      claim.exception.kind,
      snapshot.expected ?? snapshot.expectedFreight ?? "",
      snapshot.received ?? snapshot.billedFreight ?? "",
      snapshot.difference ?? "",
      JSON.stringify(snapshot),
    ].map(quote).join(",");
  });
  return [fields.join(","), ...rows].join("\r\n");
}
