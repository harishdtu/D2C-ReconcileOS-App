import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { decideMatchCandidate } from "@/lib/reconciliation/match-candidates";

const decisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept"), confirmed: z.literal(true) }).strict(),
  z.object({ decision: z.literal("reject") }).strict(),
]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ suggestionId: string }> },
) {
  try {
    const user = await requirePermission("RUN_RECONCILIATION");
    const { suggestionId } = await context.params;
    if (!z.string().uuid().safeParse(suggestionId).success) {
      return NextResponse.json({ error: "Invalid match suggestion ID." }, { status: 400 });
    }
    const body = decisionSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: "A valid, explicitly confirmed decision is required." }, { status: 400 });
    }
    return NextResponse.json(await decideMatchCandidate({
      suggestionId,
      decision: body.data.decision,
      actorId: user.id,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
