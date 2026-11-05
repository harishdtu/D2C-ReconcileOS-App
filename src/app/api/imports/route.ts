import { NextResponse } from "next/server";
import { ImportKind, ImportStatus, Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/http-errors";
import { uploadImportPreview } from "@/lib/imports/service";

const allowedKinds = new Set(Object.values(ImportKind));
const allowedStatuses = new Set(Object.values(ImportStatus));

export async function GET(request: Request) {
  try {
    await requirePermission("READ_FINANCIALS");
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "25");
    const statusText = url.searchParams.get("status") ?? undefined;
    const kindText = url.searchParams.get("kind") ?? undefined;
    const search = (url.searchParams.get("search") ?? "").trim();
    if (
      !Number.isInteger(page) || page < 1 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (statusText && !allowedStatuses.has(statusText as ImportStatus)) ||
      (kindText && !allowedKinds.has(kindText as ImportKind)) ||
      search.length > 100
    ) {
      return NextResponse.json({ error: "Invalid import filters." }, { status: 400 });
    }

    const where: Prisma.ImportBatchWhereInput = {
      ...(statusText ? { status: statusText as ImportStatus } : {}),
      ...(kindText ? { source: { kind: kindText as ImportKind } } : {}),
      ...(search
        ? {
            OR: [
              { fileName: { contains: search, mode: "insensitive" } },
              { source: { sourceKey: { contains: search, mode: "insensitive" } } },
              { source: { partner: { name: { contains: search, mode: "insensitive" } } } },
            ],
          }
        : {}),
    };
    const [total, batches] = await Promise.all([
      prisma.importBatch.count({ where }),
      prisma.importBatch.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          fileName: true,
          status: true,
          totalRows: true,
          acceptedRows: true,
          rejectedRows: true,
          duplicateRows: true,
          createdAt: true,
          completedAt: true,
          source: {
            select: {
              id: true,
              kind: true,
              sourceKey: true,
              partner: { select: { code: true, name: true } },
            },
          },
          mappingVersion: { select: { version: true } },
        },
      }),
    ]);
    return NextResponse.json({
      batches,
      page,
      limit,
      total,
      pageCount: Math.ceil(total / limit),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requirePermission("MANAGE_IMPORTS");
    const form = await request.formData();
    const file = form.get("file");
    const partnerCode = form.get("partnerCode");
    const sourceKey = form.get("sourceKey");
    const kind = form.get("kind");
    if (
      !(file instanceof File) ||
      typeof partnerCode !== "string" ||
      typeof sourceKey !== "string" ||
      typeof kind !== "string" ||
      !allowedKinds.has(kind as ImportKind)
    ) {
      return NextResponse.json(
        { error: "file, partnerCode, sourceKey, and a valid kind are required." },
        { status: 400 },
      );
    }

    const result = await uploadImportPreview({
      partnerCode,
      sourceKey,
      kind: kind as ImportKind,
      fileName: file.name,
      file: Buffer.from(await file.arrayBuffer()),
      uploadedById: user.id,
    });
    return NextResponse.json(result, { status: result.duplicateUpload ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
