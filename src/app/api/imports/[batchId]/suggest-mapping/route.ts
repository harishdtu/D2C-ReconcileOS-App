import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { suggestSourceMapping } from "@/lib/imports/ai-mapping";

export async function POST(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  try {
    const user = await requirePermission("MANAGE_MAPPINGS");
    const { batchId } = await context.params;
    return NextResponse.json(await suggestSourceMapping(batchId, user.id), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
