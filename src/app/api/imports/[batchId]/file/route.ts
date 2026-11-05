import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorResponse } from "@/lib/http-errors";
import { readImportFile } from "@/lib/imports/storage";

function contentDisposition(fileName: string): string {
  const safeName = fileName
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "_");
  const fallback = safeName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "import-file";
  const encoded = encodeURIComponent(safeName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  try {
    await requirePermission("MANAGE_IMPORTS");
    const { batchId } = await context.params;
    const batch = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { fileName: true, storageKey: true },
    });
    if (!batch) {
      return NextResponse.json({ error: "Import batch was not found." }, { status: 404 });
    }

    const contents = await readImportFile(batch.storageKey);
    return new Response(new Uint8Array(contents), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": contentDisposition(batch.fileName),
        "content-length": String(contents.byteLength),
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
