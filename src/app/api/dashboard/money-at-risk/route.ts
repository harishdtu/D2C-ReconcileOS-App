import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { moneyAtRiskByPartner } from "@/lib/exceptions/service";

export async function GET() {
  try {
    await requirePermission("READ_FINANCIALS");
    return NextResponse.json(await moneyAtRiskByPartner());
  } catch (error) {
    return errorResponse(error);
  }
}
