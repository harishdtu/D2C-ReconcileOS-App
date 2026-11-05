import { NextResponse } from "next/server";
import { OrderDeliveryStatus, Prisma, ReconciliationStatus } from "@prisma/client";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/http-errors";

const deliveryStatuses = new Set(Object.values(OrderDeliveryStatus));
const reconciliationStatuses = new Set(Object.values(ReconciliationStatus));

export async function GET(request: Request) {
  try {
    await requirePermission("READ_FINANCIALS");
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const search = (url.searchParams.get("search") ?? "").trim();
    const deliveryText = url.searchParams.get("deliveryStatus") ?? undefined;
    const reconciliationText = url.searchParams.get("status") ?? undefined;
    const currency = url.searchParams.get("currency")?.toUpperCase();
    const sortBy = url.searchParams.get("sortBy") ?? "orderDate";
    const sortOrderText = url.searchParams.get("sortOrder") ?? "desc";
    const sortOrder = sortOrderText === "asc" ? "asc" : "desc";
    if (
      !Number.isInteger(page) || page < 1 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      search.length > 100 ||
      !["orderDate", "orderValue", "externalId"].includes(sortBy) ||
      !["asc", "desc"].includes(sortOrderText) ||
      (deliveryText && !deliveryStatuses.has(deliveryText as OrderDeliveryStatus)) ||
      (reconciliationText && !reconciliationStatuses.has(reconciliationText as ReconciliationStatus)) ||
      (currency && !/^[A-Z]{3}$/.test(currency))
    ) {
      return NextResponse.json({ error: "Invalid order filters." }, { status: 400 });
    }

    const where: Prisma.OrderWhereInput = {
      ...(deliveryText ? { deliveryStatus: deliveryText as OrderDeliveryStatus } : {}),
      ...(currency ? { currency } : {}),
      ...(reconciliationText
        ? { reconciliationResults: { some: { status: reconciliationText as ReconciliationStatus } } }
        : {}),
      ...(search
        ? {
            OR: [
              { externalId: { contains: search, mode: "insensitive" } },
              { channelPartner: { name: { contains: search, mode: "insensitive" } } },
              { channelPartner: { code: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: [
          { [sortBy]: sortOrder },
          { id: sortOrder },
        ],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          externalId: true,
          orderDate: true,
          deliveryStatus: true,
          paymentMethod: true,
          orderValue: true,
          currency: true,
          channelPartner: { select: { code: true, name: true } },
          reconciliationResults: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              status: true,
              expectedAmount: true,
              receivedAmount: true,
              differenceAmount: true,
              currency: true,
              explanation: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);
    return NextResponse.json({
      orders,
      page,
      limit,
      total,
      pageCount: Math.ceil(total / limit),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
