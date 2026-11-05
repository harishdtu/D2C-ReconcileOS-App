import { createHash } from "node:crypto";
import {
  ClaimStatus,
  ExceptionKind,
  ExceptionStatus,
  FinancialRecordKind,
  ImportKind,
  ImportRowStatus,
  ImportStatus,
  OrderDeliveryStatus,
  PaymentMethod,
  Prisma,
  PrismaClient,
  RateBasis,
  RateComponentKind,
  ReconciliationRunStatus,
  ReconciliationStatus,
  UserRole,
} from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const demoDate = new Date("2026-10-01T00:00:00.000Z");
const fixtureFingerprint = digest("reconcileos-demo-reconciliation-v1");

const partnerSeeds = [
  { code: "website", name: "Company A Website", kind: "WEBSITE" as const },
  { code: "marketplace-1", name: "Marketplace One", kind: "MARKETPLACE" as const },
  { code: "marketplace-2", name: "Marketplace Two", kind: "MARKETPLACE" as const },
  { code: "marketplace-3", name: "Marketplace Three", kind: "MARKETPLACE" as const },
  { code: "quick-commerce-1", name: "Quick Commerce One", kind: "QUICK_COMMERCE" as const },
  { code: "quick-commerce-2", name: "Quick Commerce Two", kind: "QUICK_COMMERCE" as const },
  { code: "courier-1", name: "Courier One", kind: "COURIER" as const },
  { code: "courier-2", name: "Courier Two", kind: "COURIER" as const },
];

type Scenario = {
  orderId: string;
  channelCode: string;
  orderDate: Date;
  dueAt: Date | null;
  paymentMethod: PaymentMethod;
  deliveryStatus: OrderDeliveryStatus;
  orderValue: string;
  expected: string;
  received: string;
  difference: string;
  resultStatus: ReconciliationStatus;
  transaction?: {
    sourceKey: string;
    importKind: ImportKind;
    recordKind: FinancialRecordKind;
    partnerCode: string;
    transactionDate: Date;
    gross: string;
    fee: string;
    net: string;
    deduplicationKey: string;
  };
  exception?: {
    kind: ExceptionKind;
    risk: string;
  };
};

const scenarios: Scenario[] = [
  {
    orderId: "ORD-W-204118",
    channelCode: "website",
    orderDate: new Date("2026-09-20T09:00:00.000Z"),
    dueAt: new Date("2026-09-27T09:00:00.000Z"),
    paymentMethod: PaymentMethod.COD,
    deliveryStatus: OrderDeliveryStatus.DELIVERED,
    orderValue: "1499.00",
    expected: "1409.00",
    received: "0.00",
    difference: "-1409.00",
    resultStatus: ReconciliationStatus.UNPAID_PAST_DUE,
    exception: { kind: ExceptionKind.UNPAID_PAST_DUE, risk: "1409.00" },
  },
  {
    orderId: "ORD-M-88120",
    channelCode: "marketplace-1",
    orderDate: new Date("2026-09-22T09:00:00.000Z"),
    dueAt: new Date("2026-09-29T09:00:00.000Z"),
    paymentMethod: PaymentMethod.PREPAID,
    deliveryStatus: OrderDeliveryStatus.DELIVERED,
    orderValue: "1199.00",
    expected: "899.00",
    received: "862.00",
    difference: "-37.00",
    resultStatus: ReconciliationStatus.SHORT_PAID,
    transaction: {
      sourceKey: "marketplace-one-settlements",
      importKind: ImportKind.SETTLEMENT,
      recordKind: FinancialRecordKind.SETTLEMENT,
      partnerCode: "marketplace-1",
      transactionDate: new Date("2026-09-29T09:00:00.000Z"),
      gross: "1199.00",
      fee: "337.00",
      net: "862.00",
      deduplicationKey: "demo-settlement-ORD-M-88120",
    },
    exception: { kind: ExceptionKind.SHORT_PAYMENT, risk: "37.00" },
  },
  {
    orderId: "ORD-W-204377",
    channelCode: "website",
    orderDate: new Date("2026-09-23T09:00:00.000Z"),
    dueAt: null,
    paymentMethod: PaymentMethod.PREPAID,
    deliveryStatus: OrderDeliveryStatus.RETURN_TO_WAREHOUSE,
    orderValue: "2398.00",
    expected: "-96.00",
    received: "-142.00",
    difference: "-46.00",
    resultStatus: ReconciliationStatus.FREIGHT_OVERCHARGED,
    transaction: {
      sourceKey: "courier-one-freight",
      importKind: ImportKind.FREIGHT_INVOICE,
      recordKind: FinancialRecordKind.FREIGHT_INVOICE,
      partnerCode: "courier-1",
      transactionDate: new Date("2026-09-30T09:00:00.000Z"),
      gross: "0.00",
      fee: "142.00",
      net: "-142.00",
      deduplicationKey: "demo-freight-ORD-W-204377",
    },
    exception: { kind: ExceptionKind.FREIGHT_OVERCHARGE, risk: "46.00" },
  },
  {
    orderId: "ORD-M-88121",
    channelCode: "marketplace-1",
    orderDate: new Date("2026-09-24T09:00:00.000Z"),
    dueAt: new Date("2026-10-01T09:00:00.000Z"),
    paymentMethod: PaymentMethod.PREPAID,
    deliveryStatus: OrderDeliveryStatus.DELIVERED,
    orderValue: "1199.00",
    expected: "899.00",
    received: "899.00",
    difference: "0.00",
    resultStatus: ReconciliationStatus.SETTLED,
    transaction: {
      sourceKey: "marketplace-one-settlements",
      importKind: ImportKind.SETTLEMENT,
      recordKind: FinancialRecordKind.SETTLEMENT,
      partnerCode: "marketplace-1",
      transactionDate: new Date("2026-10-01T09:00:00.000Z"),
      gross: "1199.00",
      fee: "300.00",
      net: "899.00",
      deduplicationKey: "demo-settlement-ORD-M-88121",
    },
  },
  {
    orderId: "ORD-W-204119",
    channelCode: "website",
    orderDate: new Date("2026-09-24T10:00:00.000Z"),
    dueAt: new Date("2026-10-01T10:00:00.000Z"),
    paymentMethod: PaymentMethod.COD,
    deliveryStatus: OrderDeliveryStatus.DELIVERED,
    orderValue: "1299.00",
    expected: "1210.00",
    received: "1210.00",
    difference: "0.00",
    resultStatus: ReconciliationStatus.SETTLED,
    transaction: {
      sourceKey: "courier-one-cod",
      importKind: ImportKind.COD_REMITTANCE,
      recordKind: FinancialRecordKind.COD_REMITTANCE,
      partnerCode: "courier-1",
      transactionDate: new Date("2026-10-01T10:00:00.000Z"),
      gross: "1299.00",
      fee: "89.00",
      net: "1210.00",
      deduplicationKey: "demo-cod-ORD-W-204119",
    },
  },
];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set before seeding demo users.`);
  }
  return value;
}

async function seedUsers() {
  const users = [
    {
      email: requiredEnvironment("SEED_FINANCE_EXECUTIVE_EMAIL").toLowerCase(),
      password: requiredEnvironment("SEED_FINANCE_EXECUTIVE_PASSWORD"),
      role: UserRole.FINANCE_EXECUTIVE,
    },
    {
      email: requiredEnvironment("SEED_COFOUNDER_EMAIL").toLowerCase(),
      password: requiredEnvironment("SEED_COFOUNDER_PASSWORD"),
      role: UserRole.CO_FOUNDER,
    },
  ];

  for (const user of users) {
    if (Buffer.byteLength(user.password, "utf8") < 12 ||
        Buffer.byteLength(user.password, "utf8") > 72) {
      throw new Error("Seed passwords must contain 12 to 72 UTF-8 bytes.");
    }
    const passwordHash = await bcrypt.hash(user.password, 12);
    await prisma.user.upsert({
      where: { email: user.email },
      create: {
        email: user.email,
        passwordHash,
        role: user.role,
      },
      update: {
        passwordHash,
        role: user.role,
        isActive: true,
      },
    });
  }
}

async function upsertSource(
  partnerId: string,
  kind: ImportKind,
  sourceKey: string,
  approvedById: string,
) {
  const source = await prisma.importSource.upsert({
    where: {
      partnerId_kind_sourceKey: { partnerId, kind, sourceKey },
    },
    create: { partnerId, kind, sourceKey },
    update: {},
  });
  const mapping = await prisma.mappingVersion.upsert({
    where: { sourceId_version: { sourceId: source.id, version: 1 } },
    create: {
      sourceId: source.id,
      version: 1,
      mapping: { orderId: "Order ID", amount: "Value ₹", date: "Date" },
      previewRows: Array.from({ length: 20 }, (_, index) => ({
        "Order ID": `DEMO-${index + 1}`,
        "Value ₹": "1200.00",
        Date: "2026-10-01",
      })),
      approvedById,
    },
    update: {},
  });
  await prisma.importSource.update({
    where: { id: source.id },
    data: { activeMappingVersionId: mapping.id },
  });
  return { source, mapping };
}

async function upsertBatch(
  sourceId: string,
  mappingVersionId: string,
  uploaderId: string,
  sourceKey: string,
  totalRows: number,
) {
  return prisma.importBatch.upsert({
    where: {
      sourceId_contentHash: {
        sourceId,
        contentHash: digest(`reconcileos-demo-file-${sourceKey}-v1`),
      },
    },
    create: {
      sourceId,
      mappingVersionId,
      uploadedById: uploaderId,
      fileName: `${sourceKey}.csv`,
      storageKey: `seed://reconcileos/${sourceKey}.csv`,
      contentHash: digest(`reconcileos-demo-file-${sourceKey}-v1`),
      fileSizeBytes: BigInt(0),
      status: ImportStatus.COMPLETED,
      totalRows,
      processedRows: totalRows,
      completedAt: demoDate,
    },
    update: {
      mappingVersionId,
      status: ImportStatus.COMPLETED,
      totalRows,
      processedRows: totalRows,
      completedAt: demoDate,
    },
  });
}

async function seedRateCards(partners: Map<string, string>) {
  const cards = [
    {
      key: "website-demo",
      name: "Website demo settlement rates",
      channelCode: "website",
      courierCode: null,
      component: {
        code: "cod-fee",
        kind: RateComponentKind.COD_FEE,
        basis: RateBasis.FLAT_PER_ORDER,
        rate: "90.0000",
      },
    },
    {
      key: "marketplace-one-demo",
      name: "Marketplace One demo settlement rates",
      channelCode: "marketplace-1",
      courierCode: null,
      component: {
        code: "marketplace-fee",
        kind: RateComponentKind.MARKETPLACE_FEE,
        basis: RateBasis.FLAT_PER_ORDER,
        rate: "300.0000",
      },
    },
    {
      key: "website-courier-one-demo",
      name: "Website and Courier One demo freight rates",
      channelCode: "website",
      courierCode: "courier-1",
      component: {
        code: "freight-up-to-one-kg",
        kind: RateComponentKind.FREIGHT_FEE,
        basis: RateBasis.WEIGHT_SLAB,
        rate: "96.0000",
        minWeightKg: new Prisma.Decimal("0.000"),
        maxWeightKg: new Prisma.Decimal("1.000"),
      },
    },
  ];

  for (const card of cards) {
    const rateCard = await prisma.rateCard.upsert({
      where: { key_version: { key: card.key, version: 1 } },
      create: {
        key: card.key,
        name: card.name,
        version: 1,
        channelPartnerId: partners.get(card.channelCode)!,
        courierPartnerId: card.courierCode
          ? partners.get(card.courierCode)
          : null,
        effectiveFrom: demoDate,
        currency: "INR",
      },
      update: {
        name: card.name,
        channelPartnerId: partners.get(card.channelCode)!,
        courierPartnerId: card.courierCode
          ? partners.get(card.courierCode)
          : null,
      },
    });
    await prisma.rateCardComponent.upsert({
      where: {
        rateCardId_code: { rateCardId: rateCard.id, code: card.component.code },
      },
      create: {
        rateCardId: rateCard.id,
        ...card.component,
      },
      update: {
        kind: card.component.kind,
        basis: card.component.basis,
        rate: new Prisma.Decimal(card.component.rate),
      },
    });
  }
}

async function main() {
  await seedUsers();
  const financeExecutive = await prisma.user.findUniqueOrThrow({
    where: {
      email: requiredEnvironment("SEED_FINANCE_EXECUTIVE_EMAIL").toLowerCase(),
    },
  });

  const partners = new Map<string, string>();
  for (const partner of partnerSeeds) {
    const saved = await prisma.partner.upsert({
      where: { code: partner.code },
      create: { ...partner, settlementTermsDays: 7 },
      update: { name: partner.name, kind: partner.kind, isActive: true },
    });
    partners.set(partner.code, saved.id);
  }

  const sources = new Map<string, Awaited<ReturnType<typeof upsertSource>>>();
  const sourceSpecs = [
    ["website", ImportKind.ORDER, "website-orders"],
    ["website", ImportKind.COD_REMITTANCE, "courier-one-cod"],
    ["marketplace-1", ImportKind.ORDER, "marketplace-one-orders"],
    ["marketplace-1", ImportKind.SETTLEMENT, "marketplace-one-settlements"],
    ["courier-1", ImportKind.FREIGHT_INVOICE, "courier-one-freight"],
  ] as const;

  for (const [partnerCode, kind, sourceKey] of sourceSpecs) {
    const partnerCodeForSource =
      kind === ImportKind.COD_REMITTANCE ||
      kind === ImportKind.FREIGHT_INVOICE
        ? "courier-1"
        : partnerCode;
    const source = await upsertSource(
      partners.get(partnerCodeForSource)!,
      kind,
      sourceKey,
      financeExecutive.id,
    );
    sources.set(sourceKey, source);
  }

  const orderRowsBySource = new Map<string, Scenario[]>();
  for (const scenario of scenarios) {
    const sourceKey =
      scenario.channelCode === "website"
        ? "website-orders"
        : "marketplace-one-orders";
    orderRowsBySource.set(sourceKey, [
      ...(orderRowsBySource.get(sourceKey) ?? []),
      scenario,
    ]);
  }

  const batches = new Map<string, string>();
  for (const [sourceKey, rows] of orderRowsBySource) {
    const source = sources.get(sourceKey)!;
    const batch = await upsertBatch(
      source.source.id,
      source.mapping.id,
      financeExecutive.id,
      sourceKey,
      rows.length,
    );
    batches.set(sourceKey, batch.id);
    for (const [index, scenario] of rows.entries()) {
      const order = await prisma.order.upsert({
        where: {
          channelPartnerId_externalId: {
            channelPartnerId: partners.get(scenario.channelCode)!,
            externalId: scenario.orderId,
          },
        },
        create: {
          channelPartnerId: partners.get(scenario.channelCode)!,
          externalId: scenario.orderId,
          orderDate: scenario.orderDate,
          deliveredAt:
            scenario.deliveryStatus === OrderDeliveryStatus.DELIVERED
              ? scenario.orderDate
              : null,
          settlementDueAt: scenario.dueAt,
          paymentMethod: scenario.paymentMethod,
          deliveryStatus: scenario.deliveryStatus,
          orderValue: new Prisma.Decimal(scenario.orderValue),
          currency: "INR",
        },
        update: {
          orderDate: scenario.orderDate,
          settlementDueAt: scenario.dueAt,
          paymentMethod: scenario.paymentMethod,
          deliveryStatus: scenario.deliveryStatus,
          orderValue: new Prisma.Decimal(scenario.orderValue),
          currency: "INR",
        },
      });
      await prisma.importRow.upsert({
        where: {
          batchId_rowNumber: { batchId: batch.id, rowNumber: index + 1 },
        },
        create: {
          batchId: batch.id,
          rowNumber: index + 1,
          rawData: {
            "Order ID": scenario.orderId,
            "Channel": scenario.channelCode,
            "Value ₹": scenario.orderValue,
          },
          normalizedData: {
            externalId: scenario.orderId,
            orderValue: scenario.orderValue,
          },
          status: ImportRowStatus.PROCESSED,
          orderId: order.id,
        },
        update: {
          normalizedData: {
            externalId: scenario.orderId,
            orderValue: scenario.orderValue,
          },
          status: ImportRowStatus.PROCESSED,
          orderId: order.id,
        },
      });
    }
  }

  const transactions = new Map<string, string>();
  const transactionRows = scenarios.filter((scenario) => scenario.transaction);
  const transactionRowsBySource = new Map<string, Scenario[]>();
  for (const scenario of transactionRows) {
    const sourceKey = scenario.transaction!.sourceKey;
    transactionRowsBySource.set(sourceKey, [
      ...(transactionRowsBySource.get(sourceKey) ?? []),
      scenario,
    ]);
  }

  for (const [sourceKey, rows] of transactionRowsBySource) {
    const source = sources.get(sourceKey)!;
    const batch = await upsertBatch(
      source.source.id,
      source.mapping.id,
      financeExecutive.id,
      sourceKey,
      rows.length,
    );
    batches.set(sourceKey, batch.id);
    for (const [index, scenario] of rows.entries()) {
      const transactionData = scenario.transaction!;
      const order = await prisma.order.findFirstOrThrow({
        where: { externalId: scenario.orderId },
      });
      const importRow = await prisma.importRow.upsert({
        where: {
          batchId_rowNumber: { batchId: batch.id, rowNumber: index + 1 },
        },
        create: {
          batchId: batch.id,
          rowNumber: index + 1,
          rawData: {
            "Order ID": scenario.orderId,
            "Transaction ID": transactionData.deduplicationKey,
            "Net Amount": transactionData.net,
          },
          normalizedData: {
            orderId: scenario.orderId,
            netAmount: transactionData.net,
          },
          status: ImportRowStatus.PROCESSED,
          orderId: order.id,
        },
        update: {
          normalizedData: {
            orderId: scenario.orderId,
            netAmount: transactionData.net,
          },
          status: ImportRowStatus.PROCESSED,
          orderId: order.id,
        },
      });
      const financialRecord = await prisma.financialTransaction.upsert({
        where: {
          sourceId_deduplicationKey: {
            sourceId: source.source.id,
            deduplicationKey: transactionData.deduplicationKey,
          },
        },
        create: {
          sourceId: source.source.id,
          partnerId: partners.get(transactionData.partnerCode)!,
          importRowId: importRow.id,
          orderId: order.id,
          kind: transactionData.recordKind,
          externalReference: transactionData.deduplicationKey,
          transactionDate: transactionData.transactionDate,
          currency: "INR",
          grossAmount: new Prisma.Decimal(transactionData.gross),
          feeAmount: new Prisma.Decimal(transactionData.fee),
          netAmount: new Prisma.Decimal(transactionData.net),
          deduplicationKey: transactionData.deduplicationKey,
        },
        update: {
          importRowId: importRow.id,
          orderId: order.id,
          netAmount: new Prisma.Decimal(transactionData.net),
        },
      });
      transactions.set(scenario.orderId, financialRecord.id);
    }
  }

  await seedRateCards(partners);

  const run = await prisma.reconciliationRun.upsert({
    where: { inputFingerprint: fixtureFingerprint },
    create: {
      initiatedById: financeExecutive.id,
      inputFingerprint: fixtureFingerprint,
      rulesVersion: "demo-v1",
      status: ReconciliationRunStatus.COMPLETED,
      startedAt: demoDate,
      completedAt: demoDate,
    },
    update: {
      status: ReconciliationRunStatus.COMPLETED,
      completedAt: demoDate,
    },
  });

  for (const scenario of scenarios) {
    const order = await prisma.order.findFirstOrThrow({
      where: { externalId: scenario.orderId },
    });
    const rateCard = await prisma.rateCard.findFirst({
      where: {
        channelPartnerId: order.channelPartnerId,
        courierPartnerId:
          scenario.resultStatus === ReconciliationStatus.FREIGHT_OVERCHARGED
            ? partners.get("courier-1")
            : null,
      },
      orderBy: { version: "desc" },
    });
    const result = await prisma.reconciliationResult.upsert({
      where: { runId_orderId: { runId: run.id, orderId: order.id } },
      create: {
        runId: run.id,
        orderId: order.id,
        rateCardId: rateCard?.id,
        status: scenario.resultStatus,
        expectedAmount: new Prisma.Decimal(scenario.expected),
        receivedAmount: new Prisma.Decimal(scenario.received),
        differenceAmount: new Prisma.Decimal(scenario.difference),
        currency: "INR",
        reasonCodes: [scenario.resultStatus],
        explanation: `Fictional demo scenario for ${scenario.orderId}; amounts are illustrative.`,
      },
      update: {
        rateCardId: rateCard?.id,
        status: scenario.resultStatus,
        expectedAmount: new Prisma.Decimal(scenario.expected),
        receivedAmount: new Prisma.Decimal(scenario.received),
        differenceAmount: new Prisma.Decimal(scenario.difference),
        reasonCodes: [scenario.resultStatus],
      },
    });

    const transactionId = transactions.get(scenario.orderId);
    if (transactionId) {
      await prisma.reconciliationTransaction.upsert({
        where: {
          resultId_transactionId: { resultId: result.id, transactionId },
        },
        create: { resultId: result.id, transactionId },
        update: {},
      });
    }

    if (scenario.exception) {
      const exception = await prisma.reconciliationException.upsert({
        where: {
          resultId_kind: { resultId: result.id, kind: scenario.exception.kind },
        },
        create: {
          resultId: result.id,
          partnerId:
            scenario.exception.kind === ExceptionKind.FREIGHT_OVERCHARGE
              ? partners.get("courier-1")!
              : partners.get(scenario.channelCode)!,
          kind: scenario.exception.kind,
          status: ExceptionStatus.OPEN,
          amountAtRisk: new Prisma.Decimal(scenario.exception.risk),
          currency: "INR",
          dueAt: scenario.dueAt,
          evidenceSnapshot: {
            demo: true,
            orderId: scenario.orderId,
            expected: scenario.expected,
            received: scenario.received,
            difference: scenario.difference,
            sourceRows: scenario.transaction ? [scenario.transaction.deduplicationKey] : [],
          },
        },
        update: {
          status: ExceptionStatus.OPEN,
          amountAtRisk: new Prisma.Decimal(scenario.exception.risk),
          evidenceSnapshot: {
            demo: true,
            orderId: scenario.orderId,
            expected: scenario.expected,
            received: scenario.received,
            difference: scenario.difference,
            sourceRows: scenario.transaction ? [scenario.transaction.deduplicationKey] : [],
          },
        },
      });
      await prisma.claim.upsert({
        where: { exceptionId: exception.id },
        create: {
          exceptionId: exception.id,
          partnerId: exception.partnerId,
          status: ClaimStatus.OPEN,
          claimAmount: new Prisma.Decimal(scenario.exception.risk),
          recoveredAmount: new Prisma.Decimal("0.00"),
          currency: "INR",
          evidenceSnapshot: exception.evidenceSnapshot as Prisma.InputJsonValue,
        },
        update: {
          status: ClaimStatus.OPEN,
          claimAmount: new Prisma.Decimal(scenario.exception.risk),
          recoveredAmount: new Prisma.Decimal("0.00"),
        },
      });
    }
  }

  const sourceCounts = [...sources.keys()].length;
  const batchCount = batches.size;
  const orderCount = await prisma.order.count({
    where: {
      externalId: { in: scenarios.map((scenario) => scenario.orderId) },
    },
  });
  const transactionCount = await prisma.financialTransaction.count({
    where: {
      deduplicationKey: {
        in: transactionRows.map(
          (scenario) => scenario.transaction!.deduplicationKey,
        ),
      },
    },
  });
  const exceptionCount = await prisma.reconciliationException.count({
    where: { result: { runId: run.id } },
  });
  const claimCount = await prisma.claim.count({
    where: { exception: { result: { runId: run.id } } },
  });

  console.info(
    JSON.stringify({
      seed: "demo",
      users: 2,
      partners: partnerSeeds.length,
      sources: sourceCounts,
      batches: batchCount,
      orders: orderCount,
      financialTransactions: transactionCount,
      reconciliationResults: scenarios.length,
      exceptions: exceptionCount,
      claims: claimCount,
    }),
  );
}

main()
  .catch((error: unknown) => {
    console.error("Demo seed failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
