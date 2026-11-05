import { ExceptionKind, ExceptionStatus, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/http-errors";

const statuses = new Set(Object.values(ExceptionStatus));
const kinds = new Set(Object.values(ExceptionKind));

export async function GET(request: Request) {
  try {
    await requirePermission("READ_FINANCIALS");
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const search = (url.searchParams.get("search") ?? "").trim();
    const statusText = url.searchParams.get("status") ?? undefined;
    const kindText = url.searchParams.get("kind") ?? undefined;
    if (
      !Number.isInteger(page) || page < 1 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      search.length > 100 ||
      (statusText && !statuses.has(statusText as ExceptionStatus)) ||
      (kindText && !kinds.has(kindText as ExceptionKind))
    ) {
      return NextResponse.json({ error: "Invalid exception filters." }, { status: 400 });
    }
    const where: Prisma.ReconciliationExceptionWhereInput = {
      ...(statusText ? { status: statusText as ExceptionStatus } : {}),
      ...(kindText ? { kind: kindText as ExceptionKind } : {}),
      ...(search
        ? {
            OR: [
              { partner: { name: { contains: search, mode: "insensitive" } } },
              { result: { order: { externalId: { contains: search, mode: "insensitive" } } } },
              { financialTransaction: { externalReference: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const [total, exceptions] = await Promise.all([
      prisma.reconciliationException.count({ where }),
      prisma.reconciliationException.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          kind: true,
          status: true,
          amountAtRisk: true,
          currency: true,
          dueAt: true,
          resolutionNote: true,
          createdAt: true,
          partner: { select: { code: true, name: true } },
          result: {
            select: {
              expectedAmount: true,
              receivedAmount: true,
              differenceAmount: true,
              explanation: true,
              order: { select: { externalId: true } },
            },
          },
          financialTransaction: {
            select: {
              externalReference: true,
              transactionDate: true,
              importRow: {
                select: { rowNumber: true, batch: { select: { fileName: true } } },
              },
            },
          },
          claim: { select: { id: true, status: true, claimAmount: true } },
        },
      }),
    ]);
    return NextResponse.json({
      exceptions,
      page,
      limit,
      total,
      pageCount: Math.ceil(total / limit),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
