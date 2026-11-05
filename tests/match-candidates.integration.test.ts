import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionCookie = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => sessionCookie.value ? { value: sessionCookie.value } : undefined,
    set: (_name: string, value: string) => { sessionCookie.value = value; },
    delete: () => { sessionCookie.value = null; },
  }),
}));

import { POST as login } from "../src/app/api/auth/login/route";
import { POST as logout } from "../src/app/api/auth/logout/route";
import { GET as listCandidates, POST as generateCandidates } from "../src/app/api/match-suggestions/route";
import { PATCH as decideCandidate } from "../src/app/api/match-suggestions/[suggestionId]/route";
import { prisma } from "../src/lib/db";
import { runReconciliation } from "../src/lib/reconciliation/service";

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

describe("human-reviewed missing-order matching", () => {
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

  it("shows competing candidates, rejects and confirms links, audits decisions, and reruns idempotently", async () => {
    const financeLogin = await signIn(
      process.env.SEED_FINANCE_EXECUTIVE_EMAIL,
      process.env.SEED_FINANCE_EXECUTIVE_PASSWORD,
    );
    expect(financeLogin.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: process.env.SEED_FINANCE_EXECUTIVE_EMAIL },
      select: { id: true },
    });
    const partner = await prisma.partner.findUniqueOrThrow({
      where: { code: "marketplace-1" },
      select: { id: true },
    });
    const suffix = randomUUID();
    const sourceKey = `milestone-5-match-${suffix}`;
    const source = await prisma.importSource.create({
      data: { partnerId: partner.id, kind: "SETTLEMENT", sourceKey },
    });
    let batchId: string | undefined;
    const rowIds: string[] = [];
    const transactionIds: string[] = [];
    const orderIds: string[] = [];
    const runIds: string[] = [];
    let suggestionIds: string[] = [];

    try {
      const batch = await prisma.importBatch.create({
        data: {
          sourceId: source.id,
          uploadedById: user.id,
          fileName: "match-candidate-fixture.csv",
          storageKey: `test/${suffix}.csv`,
          contentHash: suffix.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
          fileSizeBytes: BigInt(1),
          status: "COMPLETED",
          totalRows: 2,
          acceptedRows: 2,
          processedRows: 2,
          completedAt: new Date(),
        },
      });
      batchId = batch.id;
      const row1 = await prisma.importRow.create({
        data: {
          batchId,
          rowNumber: 1,
          rawData: { "Net amount": "1000.00" },
          normalizedData: { sourceRowNumber: 1 },
          status: "PROCESSED",
        },
      });
      const row2 = await prisma.importRow.create({
        data: {
          batchId,
          rowNumber: 2,
          rawData: { "Net amount": "1275.00" },
          normalizedData: { sourceRowNumber: 2 },
          status: "PROCESSED",
        },
      });
      rowIds.push(row1.id, row2.id);

      const orderDate = new Date("2026-10-08T00:00:00.000Z");
      const order1 = await prisma.order.create({
        data: {
          channelPartnerId: partner.id,
          externalId: `M5-ORD-A-${suffix}`,
          orderDate,
          paymentMethod: "PREPAID",
          deliveryStatus: "DELIVERED",
          orderValue: "1000.00",
          currency: "INR",
        },
      });
      const order2 = await prisma.order.create({
        data: {
          channelPartnerId: partner.id,
          externalId: `M5-ORD-B-${suffix}`,
          orderDate: new Date("2026-10-09T00:00:00.000Z"),
          paymentMethod: "PREPAID",
          deliveryStatus: "DELIVERED",
          orderValue: "1000.00",
          currency: "INR",
        },
      });
      orderIds.push(order1.id, order2.id);

      const transactionDate = new Date("2026-10-10T00:00:00.000Z");
      const transaction1 = await prisma.financialTransaction.create({
        data: {
          sourceId: source.id,
          partnerId: partner.id,
          importRowId: row1.id,
          kind: "SETTLEMENT",
          transactionDate,
          currency: "INR",
          grossAmount: "1000.00",
          netAmount: "1000.00",
          deduplicationKey: `tx-a-${suffix}`,
        },
      });
      const transaction2 = await prisma.financialTransaction.create({
        data: {
          sourceId: source.id,
          partnerId: partner.id,
          importRowId: row2.id,
          kind: "SETTLEMENT",
          transactionDate,
          currency: "INR",
          grossAmount: "1275.00",
          netAmount: "1275.00",
          deduplicationKey: `tx-b-${suffix}`,
        },
      });
      transactionIds.push(transaction1.id, transaction2.id);

      const originalRun = await runReconciliation({ batchIds: [batchId], initiatedById: user.id });
      runIds.push(originalRun.runId);
      expect(originalRun.resultCount).toBe(0);
      expect(originalRun.unmatchedTransactionCount).toBe(2);

      const generatedResponse = await generateCandidates(request("/api/match-suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchIds: [batchId] }),
      }));
      expect(generatedResponse.status).toBe(200);
      expect(await generatedResponse.json()).toMatchObject({
        transactionsReviewed: 2,
        transactionsWithCandidates: 1,
        candidatesCreated: 2,
        transactionsWithoutCandidates: 1,
      });
      const repeatedGeneration = await generateCandidates(request("/api/match-suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchIds: [batchId] }),
      }));
      expect(await repeatedGeneration.json()).toMatchObject({
        candidatesCreated: 0,
        transactionsWithCandidates: 1,
        transactionsWithoutCandidates: 1,
      });

      const queueResponse = await listCandidates(request("/api/match-suggestions?limit=10"));
      expect(queueResponse.status).toBe(200);
      const queue = await queueResponse.json() as {
        candidates: Array<{
          id: string;
          transaction: { id: string; alternatives: number };
          candidateOrder: { id: string };
          reason: string;
        }>;
        total: number;
      };
      const transactionCandidates = queue.candidates.filter((candidate) =>
        candidate.transaction.id === transaction1.id,
      );
      expect(transactionCandidates).toHaveLength(2);
      expect(transactionCandidates.every((candidate) => candidate.transaction.alternatives === 2)).toBe(true);
      expect(transactionCandidates[0].reason).toContain("Gross amount exactly matches");
      suggestionIds = transactionCandidates.map((candidate) => candidate.id);
      expect(queue.candidates.some((candidate) => candidate.transaction.id === transaction2.id)).toBe(false);
      expect(queue.total).toBe(2);

      await logout();
      const cofounderLogin = await signIn(
        process.env.SEED_COFOUNDER_EMAIL,
        process.env.SEED_COFOUNDER_PASSWORD,
      );
      expect(cofounderLogin.status).toBe(200);
      const deniedGeneration = await generateCandidates(request("/api/match-suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchIds: [batchId] }),
      }));
      expect(deniedGeneration.status).toBe(403);
      const deniedDecision = await decideCandidate(
        request(`/api/match-suggestions/${suggestionIds[0]}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "accept", confirmed: true }),
        }),
        { params: Promise.resolve({ suggestionId: suggestionIds[0] }) },
      );
      expect(deniedDecision.status).toBe(403);

      await logout();
      const renewedLogin = await signIn(
        process.env.SEED_FINANCE_EXECUTIVE_EMAIL,
        process.env.SEED_FINANCE_EXECUTIVE_PASSWORD,
      );
      expect(renewedLogin.status).toBe(200);

      const rejected = await decideCandidate(
        request(`/api/match-suggestions/${suggestionIds[1]}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "reject" }),
        }),
        { params: Promise.resolve({ suggestionId: suggestionIds[1] }) },
      );
      expect(rejected.status).toBe(200);

      const unconfirmed = await decideCandidate(
        request(`/api/match-suggestions/${suggestionIds[0]}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "accept" }),
        }),
        { params: Promise.resolve({ suggestionId: suggestionIds[0] }) },
      );
      expect(unconfirmed.status).toBe(400);

      const accepted = await decideCandidate(
        request(`/api/match-suggestions/${suggestionIds[0]}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "accept", confirmed: true }),
        }),
        { params: Promise.resolve({ suggestionId: suggestionIds[0] }) },
      );
      expect(accepted.status).toBe(200);
      expect(await prisma.financialTransaction.findUniqueOrThrow({
        where: { id: transaction1.id },
        select: { orderId: true },
      })).toMatchObject({ orderId: transactionCandidates[0].candidateOrder.id });
      const decisionStatuses = (await prisma.matchSuggestion.findMany({
        where: { id: { in: suggestionIds } },
        select: { status: true },
      })).map((suggestion) => suggestion.status).sort();
      expect(decisionStatuses).toEqual(["APPROVED", "REJECTED"]);
      expect(await prisma.reconciliationException.findFirstOrThrow({
        where: { financialTransactionId: transaction1.id },
        select: { status: true },
      })).toMatchObject({ status: "OPEN" });
      expect(await prisma.auditLog.count({
        where: {
          entityType: "MatchSuggestion",
          entityId: { in: suggestionIds },
          action: { in: ["MATCH_CANDIDATE_ACCEPTED", "MATCH_CANDIDATE_REJECTED"] },
        },
      })).toBe(2);

      const postDecisionRun = await runReconciliation({ batchIds: [batchId], initiatedById: user.id });
      runIds.push(postDecisionRun.runId);
      expect(postDecisionRun.idempotentReplay).toBe(false);
      expect(postDecisionRun.resultCount).toBe(1);
      const replay = await runReconciliation({ batchIds: [batchId], initiatedById: user.id });
      expect(replay).toMatchObject({
        runId: postDecisionRun.runId,
        idempotentReplay: true,
      });
    } finally {
      await logout();
      if (batchId) {
        const testExceptions = await prisma.reconciliationException.findMany({
          where: { financialTransactionId: { in: transactionIds } },
          select: { id: true },
        });
        const exceptionIds = testExceptions.map((exception) => exception.id);
        const allSuggestionIds = [
          ...suggestionIds,
          ...(await prisma.matchSuggestion.findMany({
            where: { financialTransactionId: { in: transactionIds } },
            select: { id: true },
          })).map((suggestion) => suggestion.id),
        ];
        await prisma.$transaction(async (tx) => {
          await tx.auditLog.deleteMany({
            where: {
              OR: [
                { entityType: "MatchCandidateGeneration", entityId: batchId },
                { entityType: "MatchSuggestion", entityId: { in: allSuggestionIds } },
                { entityType: "ReconciliationRun", entityId: { in: runIds } },
                { entityType: "ReconciliationException", entityId: { in: exceptionIds } },
              ],
            },
          });
          await tx.claim.deleteMany({
            where: { exceptionId: { in: exceptionIds } },
          });
          await tx.reconciliationException.deleteMany({
            where: { id: { in: exceptionIds } },
          });
          await tx.reconciliationTransaction.deleteMany({
            where: { result: { runId: { in: runIds } } },
          });
          await tx.reconciliationResult.deleteMany({ where: { runId: { in: runIds } } });
          await tx.reconciliationRun.deleteMany({ where: { id: { in: runIds } } });
          await tx.matchSuggestion.deleteMany({
            where: { financialTransactionId: { in: transactionIds } },
          });
          await tx.financialTransaction.deleteMany({ where: { id: { in: transactionIds } } });
          await tx.importRow.deleteMany({ where: { id: { in: rowIds } } });
          await tx.importBatch.deleteMany({ where: { id: batchId } });
          await tx.order.deleteMany({ where: { id: { in: orderIds } } });
          await tx.importSource.delete({ where: { id: source.id } });
        });
      }
      sessionCookie.value = null;
    }
  });
});
