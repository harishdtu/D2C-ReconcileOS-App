import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { errorResponse } from "@/lib/http-errors";
import { rollbackMapping } from "@/lib/imports/service";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sourceId: string; version: string }> },
) {
  try {
    const user = await requirePermission("MANAGE_MAPPINGS");
    const { sourceId, version: versionText } = await context.params;
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || version < 1) {
      return NextResponse.json({ error: "Mapping version must be a positive integer." }, { status: 400 });
    }
    const result = await rollbackMapping({ sourceId, version, actorId: user.id });
    return NextResponse.json({
      id: result.id,
      version: result.version,
      rollbackOfId: result.rollbackOfId,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
