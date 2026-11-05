import { describe, expect, it } from "vitest";
import { hasPermission } from "../src/lib/authorization";

describe("role authorization", () => {
  it("allows finance executives to perform core finance operations", () => {
    expect(hasPermission("FINANCE_EXECUTIVE", "MANAGE_IMPORTS")).toBe(true);
    expect(hasPermission("FINANCE_EXECUTIVE", "MANAGE_MAPPINGS")).toBe(true);
    expect(hasPermission("FINANCE_EXECUTIVE", "MANAGE_RATE_CARDS")).toBe(true);
    expect(hasPermission("FINANCE_EXECUTIVE", "RUN_RECONCILIATION")).toBe(true);
    expect(hasPermission("FINANCE_EXECUTIVE", "REVIEW_CLAIMS")).toBe(true);
  });

  it("limits the co-founder to oversight access", () => {
    expect(hasPermission("CO_FOUNDER", "READ_FINANCIALS")).toBe(true);
    expect(hasPermission("CO_FOUNDER", "MANAGE_IMPORTS")).toBe(false);
    expect(hasPermission("CO_FOUNDER", "MANAGE_MAPPINGS")).toBe(false);
    expect(hasPermission("CO_FOUNDER", "MANAGE_RATE_CARDS")).toBe(false);
    expect(hasPermission("CO_FOUNDER", "RUN_RECONCILIATION")).toBe(false);
    expect(hasPermission("CO_FOUNDER", "REVIEW_CLAIMS")).toBe(false);
  });
});
