import { PartnerKind, Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  evaluateMatchCandidate,
  type CandidateOrder,
  type CandidateTransaction,
} from "../src/lib/reconciliation/match-candidates";

const transaction: CandidateTransaction = {
  id: "tx-1",
  partnerId: "partner-1",
  partner: { kind: PartnerKind.MARKETPLACE },
  externalReference: null,
  transactionDate: new Date("2026-10-10T00:00:00.000Z"),
  currency: "INR",
  grossAmount: new Prisma.Decimal("1000.00"),
  netAmount: new Prisma.Decimal("1000.00"),
};

function order(overrides: Partial<CandidateOrder> = {}): CandidateOrder {
  return {
    id: "order-1",
    externalId: "ORD-1",
    orderDate: new Date("2026-10-08T00:00:00.000Z"),
    currency: "INR",
    orderValue: new Prisma.Decimal("1000.00"),
    channelPartnerId: "partner-1",
    channelPartner: { code: "marketplace-1", name: "Marketplace One" },
    ...overrides,
  };
}

describe("deterministic missing-order candidate scoring", () => {
  it("keeps all equally supported candidates visible instead of selecting one", () => {
    const candidates = [
      evaluateMatchCandidate(transaction, order()),
      evaluateMatchCandidate(transaction, order({
        id: "order-2",
        externalId: "ORD-2",
      })),
    ];

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual(candidates[1]);
    expect(candidates[0]?.reason).toContain("Gross amount exactly matches");
    expect(candidates[0]?.reason).toContain("Source partner matches");
  });

  it("rejects amount-only false matches with an unrelated channel partner", () => {
    expect(evaluateMatchCandidate(transaction, order({ channelPartnerId: "other-partner" })))
      .toBeNull();
  });

  it("rejects currency conflicts, future orders, and orders outside the date window", () => {
    expect(evaluateMatchCandidate(transaction, order({ currency: "USD" }))).toBeNull();
    expect(evaluateMatchCandidate(transaction, order({
      orderDate: new Date("2026-10-11T00:00:00.000Z"),
    }))).toBeNull();
    expect(evaluateMatchCandidate(transaction, order({
      orderDate: new Date("2026-09-01T00:00:00.000Z"),
    }))).toBeNull();
  });

  it("allows an exact reference signal to remain reviewable when amounts differ", () => {
    const candidate = evaluateMatchCandidate({
      ...transaction,
      externalReference: "ORD-1",
      netAmount: new Prisma.Decimal("930.00"),
    }, order());

    expect(candidate?.reason).toContain("Source reference exactly matches");
    expect(candidate?.confidence).toBe("0.9900");
  });

  it("returns no candidate when neither identifiers nor exact amounts support a match", () => {
    expect(evaluateMatchCandidate({
      ...transaction,
      grossAmount: new Prisma.Decimal("999.99"),
      netAmount: new Prisma.Decimal("930.00"),
    }, order())).toBeNull();
  });
});
