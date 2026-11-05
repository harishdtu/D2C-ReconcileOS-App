import { NextResponse } from "next/server";
import {
  Prisma,
  ReconciliationRunStatus,
  ReconciliationStatus,
} from "@prisma/client";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/http-errors";
import { runReconciliation } from "@/lib/reconciliation/service";

const runSchema = z.object({
  batchIds: z.array(z.string().uuid()).min(1).max(50),
}).strict();
const reconciliationStatuses = new Set(Object.values(ReconciliationStatus));
const runStatuses = new Set(Object.values(ReconciliationRunStatus));

export async function GET(request: Request) {
  try {
    await requirePermission("READ_FINANCIALS");
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const runId = url.searchParams.get("runId") ?? undefined;
    const search = (url.searchParams.get("search") ?? "").trim();
    const statusText = url.searchParams.get("status") ?? undefined;
    if (
      !Number.isInteger(page) || page < 1 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      search.length > 100 ||
      (runId && !z.string().uuid().safeParse(runId).success) ||
      (statusText &&
        !(runId
          ? reconciliationStatuses.has(statusText as ReconciliationStatus)
          : runStatuses.has(statusText as ReconciliationRunStatus)))
    ) {
      return NextResponse.json({ error: "Invalid reconciliation filters." }, { status: 400 });
    }

    if (!runId) {
      const where = statusText
        ? { status: statusText as ReconciliationRunStatus }
        : {};
      const [total, runs] = await Promise.all([
        prisma.reconciliationRun.count({ where }),
        prisma.reconciliationRun.findMany({
          where,
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            status: true,
            rulesVersion: true,
            startedAt: true,
            completedAt: true,
            initiatedBy: { select: { email: true } },
            _count: { select: { results: true } },
          },
        }),
      ]);
      return NextResponse.json({
        runs,
        page,
        limit,
        total,
        pageCount: Math.ceil(total / limit),
      }, { headers: { "cache-control": "no-store" } });
    }

    const where: Prisma.ReconciliationResultWhereInput = {
      runId,
      ...(statusText ? { status: statusText as ReconciliationStatus } : {}),
      ...(search
        ? {
            order: {
              OR: [
                { externalId: { contains: search, mode: "insensitive" } },
                { channelPartner: { name: { contains: search, mode: "insensitive" } } },
              ],
            },
          }
        : {}),
    };
    const [total, results] = await Promise.all([
      prisma.reconciliationResult.count({ where }),
      prisma.reconciliationResult.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          expectedAmount: true,
          receivedAmount: true,
          differenceAmount: true,
          currency: true,
          reasonCodes: true,
          explanation: true,
          createdAt: true,
          order: {
            select: {
              externalId: true,
              orderValue: true,
              deliveryStatus: true,
              paymentMethod: true,
              channelPartner: { select: { code: true, name: true } },
            },
          },
          matchedTransactions: {
            select: {
              transaction: {
                select: {
                  kind: true,
                  externalReference: true,
                  transactionDate: true,
                  netAmount: true,
                  currency: true,
                },
              },
            },
          },
          exceptions: {
            select: {
              id: true,
              kind: true,
              status: true,
              amountAtRisk: true,
              currency: true,
            },
          },
        },
      }),
    ]);
    return NextResponse.json({
      results,
      page,
      limit,
      total,
      pageCount: Math.ceil(total / limit),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requirePermission("RUN_RECONCILIATION");
    const body = runSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: "Provide 1 to 50 valid import batch IDs." }, { status: 400 });
    }
    return NextResponse.json(await runReconciliation({
      batchIds: body.data.batchIds,
      initiatedById: user.id,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
