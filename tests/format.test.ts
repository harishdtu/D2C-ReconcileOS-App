import { describe, expect, it } from "vitest";
import { formatMoney, humanize } from "../src/lib/format";

describe("product display formatting", () => {
  it("groups INR amounts without converting the decimal string through floating point", () => {
    expect(formatMoney("100000000.00", "INR")).toBe("₹10,00,00,000.00");
    expect(formatMoney("-1234567.25", "INR")).toBe("-₹12,34,567.25");
  });

  it("uses the source currency and readable status labels", () => {
    expect(formatMoney("1234.50", "USD")).toBe("$1,234.50");
    expect(humanize("UNPAID_PAST_DUE")).toBe("Unpaid Past Due");
  });
});
