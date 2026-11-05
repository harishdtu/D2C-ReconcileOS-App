import { NextResponse } from "next/server";
import { ClaimStatus } from "@prisma/client";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { claimExportRows, listClaims } from "@/lib/exceptions/service";

const statuses = new Set(Object.values(ClaimStatus));

export async function GET(request: Request) {
  try {
    await requirePermission("READ_FINANCIALS");
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    if (status && !statuses.has(status as ClaimStatus)) {
      return NextResponse.json({ error: "Invalid claim status." }, { status: 400 });
    }
    const result = await listClaims({
      partnerCode: url.searchParams.get("partner") ?? undefined,
      status: status as ClaimStatus | undefined,
      limit: 500,
    });
    if (result.nextCursor) {
      return NextResponse.json(
        { error: "Export is limited to 500 claims per request; filter by partner or status." },
        { status: 413 },
      );
    }
    return new NextResponse(claimExportRows(result.claims), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="reconcileos-claims.csv"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
