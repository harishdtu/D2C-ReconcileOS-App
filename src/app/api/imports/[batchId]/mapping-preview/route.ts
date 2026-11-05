import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { previewMapping } from "@/lib/imports/service";

const mappingSchema = z.object({
  mapping: z.record(z.string(), z.string().min(1).max(255)),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  try {
    await requirePermission("MANAGE_MAPPINGS");
    const { batchId } = await context.params;
    const body = mappingSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: "Invalid column mapping." }, { status: 400 });
    }
    return NextResponse.json(await previewMapping({
      batchId,
      mapping: body.data.mapping,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
