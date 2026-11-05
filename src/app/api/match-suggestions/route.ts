import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import {
  generateMatchCandidates,
  listPendingMatchCandidates,
} from "@/lib/reconciliation/match-candidates";

const generationSchema = z.object({
  batchIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  afterId: z.string().uuid().optional(),
}).strict();

export async function GET(request: Request) {
  try {
    await requirePermission("READ_FINANCIALS");
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "25");
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return NextResponse.json({ error: "Invalid match-review page." }, { status: 400 });
    }
    return NextResponse.json(await listPendingMatchCandidates({ page, limit }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requirePermission("RUN_RECONCILIATION");
    const body = generationSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: "Invalid candidate-generation request." }, { status: 400 });
    }
    return NextResponse.json(await generateMatchCandidates({
      batchIds: body.data.batchIds,
      afterId: body.data.afterId,
      actorId: user.id,
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
