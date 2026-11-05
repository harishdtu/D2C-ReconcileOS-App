import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getDashboardOverview } from "@/lib/dashboard/service";
import { errorResponse } from "@/lib/http-errors";

export async function GET() {
  try {
    await requirePermission("READ_FINANCIALS");
    return NextResponse.json(await getDashboardOverview(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
