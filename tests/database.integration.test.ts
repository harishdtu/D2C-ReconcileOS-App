import "dotenv/config";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticateCredentials } from "../src/lib/auth";
import { prisma } from "../src/lib/db";

describe("PostgreSQL database foundation", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be configured for database integration tests.");
    }
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("connects and runs a real PostgreSQL query", async () => {
    const [result] = await prisma.$queryRaw<
      Array<{ database: string; role: string; port: number }>
    >`SELECT current_database() AS database, current_user AS role, inet_server_port() AS port`;

    expect(result).toEqual({
      database: "reconcileos",
      role: "reconcileos_app",
      port: 5433,
    });
  });

  it("enforces relationships between orders, imported evidence, and transactions", async () => {
    const order = await prisma.order.findUniqueOrThrow({
      where: {
        channelPartnerId_externalId: {
          channelPartnerId: (
            await prisma.partner.findUniqueOrThrow({
              where: { code: "marketplace-1" },
              select: { id: true },
            })
          ).id,
          externalId: "ORD-M-88120",
        },
      },
      include: {
        channelPartner: true,
        transactions: { include: { importRow: { include: { batch: true } } } },
        reconciliationResults: {
          include: {
            matchedTransactions: { include: { transaction: true } },
            exceptions: true,
          },
        },
      },
    });

    expect(order.channelPartner.code).toBe("marketplace-1");
    expect(order.orderValue.toString()).toBe("1199");
    expect(order.transactions).toHaveLength(1);
    expect(order.transactions[0].importRow.batch.status).toBe("COMPLETED");
    expect(order.reconciliationResults[0].differenceAmount.toString()).toBe("-37");
    expect(order.reconciliationResults[0].exceptions[0].amountAtRisk.toString()).toBe("37");
  });

  it("preserves exact decimal precision and rejects duplicate channel order IDs", async () => {
    const channel = await prisma.partner.findUniqueOrThrow({
      where: { code: "website" },
      select: { id: true },
    });
    const externalId = `TEST-${randomUUID()}`;
    let orderId: string | undefined;

    try {
      const saved = await prisma.order.create({
        data: {
          channelPartnerId: channel.id,
          externalId,
          orderDate: new Date("2026-10-01T00:00:00.000Z"),
          paymentMethod: "PREPAID",
          orderValue: new Prisma.Decimal("123456789012.34"),
          currency: "INR",
        },
      });
      orderId = saved.id;

      const fetched = await prisma.order.findUniqueOrThrow({
        where: { id: saved.id },
      });
      expect(fetched.orderValue.toString()).toBe("123456789012.34");

      await expect(
        prisma.order.create({
          data: {
            channelPartnerId: channel.id,
            externalId,
            orderDate: new Date("2026-10-01T00:00:00.000Z"),
            paymentMethod: "PREPAID",
            orderValue: new Prisma.Decimal("1.00"),
            currency: "INR",
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      if (orderId) {
        await prisma.order.delete({ where: { id: orderId } });
      }
    }
  });

  it("authenticates seeded users without returning password hashes", async () => {
    const email = process.env.SEED_FINANCE_EXECUTIVE_EMAIL;
    const password = process.env.SEED_FINANCE_EXECUTIVE_PASSWORD;
    if (!email || !password) {
      throw new Error("Seed finance-executive credentials are required for auth tests.");
    }

    const user = await authenticateCredentials(email, password);
    expect(user).toMatchObject({
      email: email.toLowerCase(),
      role: "FINANCE_EXECUTIVE",
    });
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("keeps the demo seed idempotent across two executions", async () => {
    const seedScript = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const snapshot = async () => ({
      users: await prisma.user.count({
        where: {
          email: {
            in: [
              process.env.SEED_FINANCE_EXECUTIVE_EMAIL!.toLowerCase(),
              process.env.SEED_COFOUNDER_EMAIL!.toLowerCase(),
            ],
          },
        },
      }),
      partners: await prisma.partner.count({
        where: { code: { in: ["website", "marketplace-1", "courier-1"] } },
      }),
      orders: await prisma.order.count({
        where: {
          externalId: {
            in: [
              "ORD-W-204118",
              "ORD-M-88120",
              "ORD-W-204377",
              "ORD-M-88121",
              "ORD-W-204119",
            ],
          },
        },
      }),
      transactions: await prisma.financialTransaction.count({
        where: { deduplicationKey: { startsWith: "demo-" } },
      }),
      claims: await prisma.claim.count({
        where: { exception: { result: { run: { inputFingerprint: { not: "" } } } } },
      }),
    });

    execFileSync(process.execPath, [seedScript, "prisma/seed.ts"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
    });
    const first = await snapshot();
    execFileSync(process.execPath, [seedScript, "prisma/seed.ts"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
    });
    const second = await snapshot();

    expect(first).toEqual(second);
    expect(second).toMatchObject({
      users: 2,
      partners: 3,
      orders: 5,
      transactions: 4,
      claims: 3,
    });
  });
});
