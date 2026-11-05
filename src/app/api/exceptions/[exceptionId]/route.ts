import { NextResponse } from "next/server";
import { ExceptionStatus } from "@prisma/client";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { exceptionDetails, transitionException } from "@/lib/exceptions/service";

const updateSchema = z.object({
  status: z.nativeEnum(ExceptionStatus),
  resolutionNote: z.string().max(4000).default(""),
}).strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ exceptionId: string }> },
) {
  try {
    await requirePermission("READ_FINANCIALS");
    const { exceptionId } = await context.params;
    const exception = await exceptionDetails(exceptionId);
    if (!exception) {
      return NextResponse.json({ error: "Exception was not found." }, { status: 404 });
    }
    return NextResponse.json(exception);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ exceptionId: string }> },
) {
  try {
    const user = await requirePermission("REVIEW_CLAIMS");
    const { exceptionId } = await context.params;
    const body = updateSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: "Invalid exception status update." }, { status: 400 });
    }
    const updated = await transitionException({
      exceptionId,
      actorId: user.id,
      status: body.data.status,
      resolutionNote: body.data.resolutionNote,
    });
    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      resolutionNote: updated.resolutionNote,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
