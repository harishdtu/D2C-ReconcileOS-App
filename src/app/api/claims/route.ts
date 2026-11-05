import { NextResponse } from "next/server";
import { ClaimStatus } from "@prisma/client";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { listClaims } from "@/lib/exceptions/service";

const statuses = new Set(Object.values(ClaimStatus));

export async function GET(request: Request) {
  try {
    await requirePermission("READ_FINANCIALS");
    const url = new URL(request.url);
    const limitText = url.searchParams.get("limit") ?? "100";
    const limit = Number(limitText);
    const statusText = url.searchParams.get("status") ?? undefined;
    const search = (url.searchParams.get("search") ?? "").trim();
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      (statusText && !statuses.has(statusText as ClaimStatus)) ||
      search.length > 100
    ) {
      return NextResponse.json({ error: "Invalid claim filters." }, { status: 400 });
    }
    const result = await listClaims({
      partnerCode: url.searchParams.get("partner") ?? undefined,
      status: statusText as ClaimStatus | undefined,
      search: search || undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
