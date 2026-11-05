import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

const sessionCookie = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => sessionCookie.value ? { value: sessionCookie.value } : undefined,
    set: (_name: string, value: string) => { sessionCookie.value = value; },
    delete: () => { sessionCookie.value = null; },
  }),
}));

import { GET as getSession } from "../src/app/api/auth/session/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as logout } from "../src/app/api/auth/logout/route";
import { GET as getAudit } from "../src/app/api/audit/route";
import { GET as getClaims } from "../src/app/api/claims/route";
import { GET as getDashboard } from "../src/app/api/dashboard/overview/route";
import { GET as getExceptions } from "../src/app/api/exceptions/route";
import { GET as getImports } from "../src/app/api/imports/route";
import { POST as uploadImport } from "../src/app/api/imports/route";
import { POST as previewImportMapping } from "../src/app/api/imports/[batchId]/mapping-preview/route";
import { POST as approveImport } from "../src/app/api/imports/[batchId]/approve/route";
import { POST as suggestMapping } from "../src/app/api/imports/[batchId]/suggest-mapping/route";
import { GET as getOrders } from "../src/app/api/orders/route";
import { GET as getReconciliation } from "../src/app/api/reconciliation/route";
import { POST as postReconciliation } from "../src/app/api/reconciliation/route";
import { PATCH as patchException } from "../src/app/api/exceptions/[exceptionId]/route";
import { prisma } from "../src/lib/db";

function request(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

async function signIn(email: string | undefined, password: string | undefined) {
  if (!email || !password) throw new Error("Seed authentication credentials are required.");
  return login(request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
}

describe("Milestone 4 authenticated product API", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be configured for product integration tests.");
    }
    await prisma.$connect();
  });

  afterAll(async () => {
    sessionCookie.value = null;
    await prisma.$disconnect();
  });

  it("supports login, authenticated reads, logout, and invalidates the session", async () => {
    const response = await signIn(
      process.env.SEED_FINANCE_EXECUTIVE_EMAIL,
      process.env.SEED_FINANCE_EXECUTIVE_PASSWORD,
    );
    expect(response.status).toBe(200);
    const user = await response.json() as { user: { email: string; role: string } };
    expect(user.user.role).toBe("FINANCE_EXECUTIVE");
    expect(user).not.toHaveProperty("passwordHash");

    const session = await getSession();
    expect(session.status).toBe(200);
    for (const readResponse of [
      await getImports(request("/api/imports?limit=5")),
      await getOrders(request("/api/orders?limit=5")),
      await getReconciliation(request("/api/reconciliation?limit=5")),
      await getExceptions(request("/api/exceptions?limit=5")),
      await getClaims(request("/api/claims?limit=5")),
      await getAudit(request("/api/audit?limit=5")),
    ]) {
      expect(readResponse.status).toBe(200);
    }
    const dashboard = await getDashboard();
    expect(dashboard.status).toBe(200);
    const overview = await dashboard.json() as {
      orderCount: number;
      byCurrency: Array<{ currency: string; orderValue: string; paymentsReceived: string }>;
      recentRuns: Array<{ id: string; status: string }>;
    };
    expect(overview.orderCount).toBe(await prisma.order.count());
    expect(overview.byCurrency.length).toBeGreaterThan(0);
    for (const row of overview.byCurrency) {
      const aggregate = await prisma.order.aggregate({
        where: { currency: row.currency },
        _sum: { orderValue: true },
      });
      expect(row.orderValue).toBe(aggregate._sum.orderValue?.toFixed(2) ?? "0.00");
      expect(Number.isNaN(Number(row.paymentsReceived))).toBe(false);
    }
    expect(overview.recentRuns.length).toBeLessThanOrEqual(5);

    const signedOut = await logout();
    expect(signedOut.status).toBe(204);
    expect((await getSession()).status).toBe(401);
    expect((await getDashboard()).status).toBe(401);
  });

  it("allows co-founder oversight but rejects protected financial mutations", async () => {
    const response = await signIn(
      process.env.SEED_COFOUNDER_EMAIL,
      process.env.SEED_COFOUNDER_PASSWORD,
    );
    expect(response.status).toBe(200);
    expect((await getDashboard()).status).toBe(200);
    expect((await uploadImport(request("/api/imports", { method: "POST" }))).status).toBe(403);
    expect((await postReconciliation(request("/api/reconciliation", { method: "POST" }))).status).toBe(403);
    await logout();
  });

  it("completes file upload, mapping approval, reconciliation and audited exception review through APIs", async () => {
    const loginResponse = await signIn(
      process.env.SEED_FINANCE_EXECUTIVE_EMAIL,
      process.env.SEED_FINANCE_EXECUTIVE_PASSWORD,
    );
    expect(loginResponse.status).toBe(200);
    const suffix = randomUUID();
    const externalId = `M4-${suffix}`;
    const sourceKey = `milestone-4-${suffix}`;
    const csv = [
      "Order ID,Order Date,Order Value,Payment Method,Delivery Status,Customer Phone",
      `${externalId},2026-10-01,1000.00,PREPAID,DELIVERED,9876543210`,
    ].join("\r\n");
    const form = new FormData();
    form.set("file", new File([csv], "milestone-4.csv", { type: "text/csv" }));
    form.set("partnerCode", "website");
    form.set("sourceKey", sourceKey);
    form.set("kind", "ORDER");

    let batchId: string | undefined;
    let runId: string | undefined;
    let resultId: string | undefined;
    let exceptionId: string | undefined;
    let storageKey: string | undefined;
    let mappingSuggestionId: string | undefined;
    const previousMappingAiEnvironment = {
      endpoint: process.env.RECONCILEOS_MAPPING_AI_ENDPOINT,
      apiKey: process.env.RECONCILEOS_MAPPING_AI_API_KEY,
      model: process.env.RECONCILEOS_MAPPING_AI_MODEL,
    };
    const mapping = {
      externalId: "Order ID",
      orderDate: "Order Date",
      orderValue: "Order Value",
      paymentMethod: "Payment Method",
      deliveryStatus: "Delivery Status",
    };

    try {
      const uploadResponse = await uploadImport(request("/api/imports", {
        method: "POST",
        body: form,
      }));
      expect(uploadResponse.status).toBe(201);
      const uploaded = await uploadResponse.json() as { id: string; totalRows: number };
      batchId = uploaded.id;
      expect(uploaded.totalRows).toBe(1);

      delete process.env.RECONCILEOS_MAPPING_AI_ENDPOINT;
      delete process.env.RECONCILEOS_MAPPING_AI_API_KEY;
      delete process.env.RECONCILEOS_MAPPING_AI_MODEL;
      const fallbackResponse = await suggestMapping(
        request(`/api/imports/${batchId}/suggest-mapping`, { method: "POST" }),
        { params: Promise.resolve({ batchId }) },
      );
      expect(fallbackResponse.status).toBe(200);
      expect(await fallbackResponse.json()).toMatchObject({
        mode: "DETERMINISTIC",
        unavailableReason: expect.stringContaining("Configure the mapping AI endpoint"),
        mapping: { externalId: "Order ID", orderDate: "Order Date" },
      });

      process.env.RECONCILEOS_MAPPING_AI_ENDPOINT = "https://provider.test/v1/chat/completions";
      process.env.RECONCILEOS_MAPPING_AI_API_KEY = "test-provider-key";
      process.env.RECONCILEOS_MAPPING_AI_MODEL = "mapping-test-model";
      let providerRequestBody = "";
      let providerCallCount = 0;
      vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        providerRequestBody = String(init?.body ?? "");
        providerCallCount += 1;
        if (providerCallCount === 1) return new Response(null, { status: 503 });
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                explanation: "Order headers are directly recognizable; the phone column is unsupported.",
                columns: [
                  { sourceColumn: "Order ID", status: "mapped", destinationField: "externalId", confidence: 0.99, explanation: "Order identifier header." },
                  { sourceColumn: "Order Date", status: "mapped", destinationField: "orderDate", confidence: 0.98, explanation: "Order date header." },
                  { sourceColumn: "Order Value", status: "mapped", destinationField: "orderValue", confidence: 0.98, explanation: "Order value header." },
                  { sourceColumn: "Payment Method", status: "mapped", destinationField: "paymentMethod", confidence: 0.97, explanation: "Payment method header." },
                  { sourceColumn: "Delivery Status", status: "mapped", destinationField: "deliveryStatus", confidence: 0.96, explanation: "Delivery state header." },
                  { sourceColumn: "Customer Phone", status: "unsupported", confidence: 0.99, explanation: "Customer contact data is not an allowed destination." },
                ],
              }),
            },
          }],
        });
      }));
      const outageResponse = await suggestMapping(
        request(`/api/imports/${batchId}/suggest-mapping`, { method: "POST" }),
        { params: Promise.resolve({ batchId }) },
      );
      expect(outageResponse.status).toBe(200);
      expect(await outageResponse.json()).toMatchObject({
        mode: "DETERMINISTIC",
        unavailableReason: "AI mapping provider returned HTTP 503.",
      });
      const aiSuggestionResponse = await suggestMapping(
        request(`/api/imports/${batchId}/suggest-mapping`, { method: "POST" }),
        { params: Promise.resolve({ batchId }) },
      );
      expect(aiSuggestionResponse.status).toBe(200);
      const aiSuggestion = await aiSuggestionResponse.json() as {
        id: string;
        mode: string;
        confidence: number;
        mapping: Record<string, string>;
        columns: Array<{ sourceColumn: string; status: string }>;
      };
      mappingSuggestionId = aiSuggestion.id;
      expect(aiSuggestion.mode).toBe("AI");
      expect(aiSuggestion.confidence).toBeGreaterThan(0.9);
      expect(aiSuggestion.mapping).toMatchObject(mapping);
      expect(aiSuggestion.columns.find((column) => column.sourceColumn === "Customer Phone")?.status)
        .toBe("unsupported");
      expect(providerRequestBody).toContain("Customer Phone");
      expect(providerRequestBody).not.toContain(externalId);
      expect(providerRequestBody).not.toContain("9876543210");

      const previewResponse = await previewImportMapping(
        request(`/api/imports/${batchId}/mapping-preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mapping }),
        }),
        { params: Promise.resolve({ batchId }) },
      );
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { mappingPreviewHash: string; previewRows: Array<{ errors: string[] }> };
      expect(preview.previewRows[0].errors).toEqual([]);

      const approvalResponse = await approveImport(
        request(`/api/imports/${batchId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mapping,
            mappingPreviewHash: preview.mappingPreviewHash,
            mappingSuggestionId,
          }),
        }),
        { params: Promise.resolve({ batchId }) },
      );
      expect(approvalResponse.status).toBe(200);
      expect(await prisma.mappingSuggestion.findUniqueOrThrow({
        where: { id: mappingSuggestionId },
        select: { status: true },
      })).toMatchObject({ status: "APPROVED" });
      expect(await approvalResponse.json()).toMatchObject({
        status: "COMPLETED",
        acceptedRows: 1,
        rejectedRows: 0,
        duplicateRows: 0,
      });

      const storedBatch = await prisma.importBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { storageKey: true },
      });
      storageKey = storedBatch.storageKey;
      const importRow = await prisma.importRow.findFirstOrThrow({ where: { batchId } });
      expect(importRow.rawData).toMatchObject({ "Customer Phone": "[REDACTED]" });

      const runResponse = await postReconciliation(request("/api/reconciliation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchIds: [batchId] }),
      }));
      expect(runResponse.status).toBe(200);
      const run = await runResponse.json() as { runId: string; resultCount: number };
      runId = run.runId;
      expect(run.resultCount).toBe(1);

      const resultsResponse = await getReconciliation(
        request(`/api/reconciliation?runId=${runId}&limit=5`),
      );
      expect(resultsResponse.status).toBe(200);
      const results = await resultsResponse.json() as {
        results: Array<{ id: string; order: { externalId: string }; explanation: string }>;
      };
      expect(results.results).toHaveLength(1);
      expect(results.results[0].order.externalId).toBe(externalId);
      expect(results.results[0].explanation.length).toBeGreaterThan(0);
      resultId = results.results[0].id;

      const partner = await prisma.partner.findUniqueOrThrow({
        where: { code: "website" },
        select: { id: true },
      });
      const createdException = await prisma.reconciliationException.create({
        data: {
          resultId,
          partnerId: partner.id,
          kind: "OTHER",
          amountAtRisk: "25.10",
          currency: "INR",
          evidenceSnapshot: { source: "milestone-4-api-integration" },
        },
      });
      exceptionId = createdException.id;
      for (const [status, resolutionNote] of [
        ["IN_REVIEW", "Finance investigation started."],
        ["RESOLVED", "Verified against the partner statement."],
      ]) {
        const transition = await patchException(
          request(`/api/exceptions/${exceptionId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status, resolutionNote }),
          }),
          { params: Promise.resolve({ exceptionId }) },
        );
        expect(transition.status).toBe(200);
      }
      expect(await prisma.auditLog.count({
        where: { entityType: "ReconciliationException", entityId: exceptionId },
      })).toBe(2);
    } finally {
      await logout();
      const source = await prisma.importSource.findUnique({
        where: {
          partnerId_kind_sourceKey: {
            partnerId: (await prisma.partner.findUniqueOrThrow({
              where: { code: "website" },
              select: { id: true },
            })).id,
            kind: "ORDER",
            sourceKey,
          },
        },
        include: { batches: true, mappingVersions: true },
      });
      if (source) {
        const batchIds = source.batches.map((batch) => batch.id);
        const mappingIds = source.mappingVersions.map((version) => version.id);
        const mappingSuggestions = await prisma.mappingSuggestion.findMany({
          where: { batchId: { in: batchIds } },
          select: { id: true },
        });
        const suggestionIds = mappingSuggestions.map((suggestion) => suggestion.id);
        await prisma.$transaction(async (tx) => {
          await tx.auditLog.deleteMany({
            where: {
              OR: [
                { entityType: "ImportBatch", entityId: { in: batchIds } },
                { entityType: "MappingVersion", entityId: { in: mappingIds } },
                { entityType: "MappingSuggestion", entityId: { in: suggestionIds } },
                { entityType: "ReconciliationRun", entityId: { in: runId ? [runId] : [] } },
                { entityType: "ReconciliationException", entityId: { in: exceptionId ? [exceptionId] : [] } },
              ],
            },
          });
          if (exceptionId) {
            await tx.claim.deleteMany({ where: { exceptionId } });
            await tx.reconciliationException.deleteMany({ where: { id: exceptionId } });
          }
          if (runId) {
            await tx.reconciliationTransaction.deleteMany({ where: { result: { runId } } });
            await tx.claim.deleteMany({ where: { exception: { result: { runId } } } });
            await tx.reconciliationException.deleteMany({ where: { result: { runId } } });
            await tx.reconciliationResult.deleteMany({ where: { runId } });
            await tx.reconciliationRun.deleteMany({ where: { id: runId } });
          }
          await tx.mappingSuggestion.deleteMany({ where: { id: { in: suggestionIds } } });
          await tx.importRow.deleteMany({ where: { batchId: { in: batchIds } } });
          const partner = await tx.partner.findUniqueOrThrow({
            where: { code: "website" },
            select: { id: true },
          });
          await tx.order.deleteMany({
            where: { channelPartnerId: partner.id, externalId },
          });
          await tx.importBatch.updateMany({
            where: { id: { in: batchIds } },
            data: { mappingVersionId: null },
          });
          await tx.importBatch.deleteMany({ where: { id: { in: batchIds } } });
          await tx.importSource.update({
            where: { id: source.id },
            data: { activeMappingVersionId: null },
          });
          await tx.mappingVersion.deleteMany({ where: { id: { in: mappingIds } } });
          await tx.importSource.delete({ where: { id: source.id } });
        });
      }
      if (storageKey) {
        await rm(path.join(process.cwd(), ".data", "imports", storageKey), { force: true });
      }
      if (previousMappingAiEnvironment.endpoint === undefined) delete process.env.RECONCILEOS_MAPPING_AI_ENDPOINT;
      else process.env.RECONCILEOS_MAPPING_AI_ENDPOINT = previousMappingAiEnvironment.endpoint;
      if (previousMappingAiEnvironment.apiKey === undefined) delete process.env.RECONCILEOS_MAPPING_AI_API_KEY;
      else process.env.RECONCILEOS_MAPPING_AI_API_KEY = previousMappingAiEnvironment.apiKey;
      if (previousMappingAiEnvironment.model === undefined) delete process.env.RECONCILEOS_MAPPING_AI_MODEL;
      else process.env.RECONCILEOS_MAPPING_AI_MODEL = previousMappingAiEnvironment.model;
      vi.unstubAllGlobals();
      sessionCookie.value = null;
    }
  });
});
