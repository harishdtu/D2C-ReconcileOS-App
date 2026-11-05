import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { approveAndProcessImport } from "@/lib/imports/service";

const approvalSchema = z.object({
  mapping: z.record(z.string(), z.string().min(1).max(255)),
  mappingPreviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  mappingSuggestionId: z.string().uuid().optional(),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  try {
    const user = await requirePermission("MANAGE_MAPPINGS");
    const { batchId } = await context.params;
    const body = approvalSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: "Invalid mapping approval." }, { status: 400 });
    }
    return NextResponse.json(await approveAndProcessImport({
      batchId,
      mapping: body.data.mapping,
      mappingPreviewHash: body.data.mappingPreviewHash,
      mappingSuggestionId: body.data.mappingSuggestionId,
      approvedById: user.id,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
