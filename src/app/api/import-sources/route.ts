import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/http-errors";

export async function GET() {
  try {
    await requirePermission("READ_FINANCIALS");
    const [partners, sources] = await Promise.all([
      prisma.partner.findMany({
        where: { isActive: true },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
        select: { id: true, code: true, name: true, kind: true },
      }),
      prisma.importSource.findMany({
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          kind: true,
          sourceKey: true,
          activeMappingVersionId: true,
          partner: { select: { code: true, name: true } },
          mappingVersions: {
            orderBy: { version: "desc" },
            take: 10,
            select: {
              id: true,
              version: true,
              rollbackOfId: true,
              approvedAt: true,
              mapping: true,
            },
          },
        },
      }),
    ]);
    return NextResponse.json({ partners, sources }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
