import { ImportKind } from "@prisma/client";

export type MappingFieldDefinition = {
  key: string;
  label: string;
  required?: boolean;
};

export const fieldDefinitions: Record<ImportKind, MappingFieldDefinition[]> = {
  ORDER: [
    { key: "externalId", label: "Order ID", required: true },
    { key: "orderDate", label: "Order date", required: true },
    { key: "orderValue", label: "Order value", required: true },
    { key: "paymentMethod", label: "Payment method", required: true },
    { key: "deliveryStatus", label: "Delivery status", required: true },
    { key: "deliveredAt", label: "Delivered at" },
    { key: "settlementDueAt", label: "Settlement due" },
    { key: "currency", label: "Currency" },
  ],
  SETTLEMENT: [
    { key: "transactionDate", label: "Transaction date", required: true },
    { key: "netAmount", label: "Net amount", required: true },
    { key: "orderId", label: "Order ID" },
    { key: "externalReference", label: "Transaction reference" },
    { key: "grossAmount", label: "Gross amount" },
    { key: "feeAmount", label: "Fee amount" },
    { key: "tcsAmount", label: "TCS amount" },
    { key: "tdsAmount", label: "TDS amount" },
    { key: "currency", label: "Currency" },
  ],
  COD_REMITTANCE: [
    { key: "transactionDate", label: "Transaction date", required: true },
    { key: "netAmount", label: "Net amount", required: true },
    { key: "orderId", label: "Order ID" },
    { key: "externalReference", label: "Transaction reference" },
    { key: "grossAmount", label: "Gross amount" },
    { key: "feeAmount", label: "Fee amount" },
    { key: "tcsAmount", label: "TCS amount" },
    { key: "tdsAmount", label: "TDS amount" },
    { key: "currency", label: "Currency" },
  ],
  FREIGHT_INVOICE: [
    { key: "transactionDate", label: "Invoice date", required: true },
    { key: "feeAmount", label: "Billed freight", required: true },
    { key: "orderId", label: "Order ID" },
    { key: "externalReference", label: "Invoice reference" },
    { key: "billedWeightKg", label: "Billed weight (kg)" },
    { key: "currency", label: "Currency" },
  ],
  RETURN_RECEIPT: [
    { key: "externalOrderId", label: "Order ID", required: true },
    { key: "expectedReceiptAt", label: "Expected receipt date", required: true },
    { key: "receivedAt", label: "Received date" },
    { key: "warehouseReceiptReference", label: "Warehouse receipt reference" },
  ],
  REFUND: [
    { key: "orderId", label: "Order ID", required: true },
    { key: "transactionDate", label: "Refund date", required: true },
    { key: "netAmount", label: "Refund amount", required: true },
    { key: "expectedAmount", label: "Expected refund amount", required: true },
    { key: "externalReference", label: "Refund reference" },
    { key: "currency", label: "Currency" },
  ],
};

const aliases: Record<string, string[]> = {
  externalId: ["orderid", "externalid", "orderreference"],
  externalOrderId: ["orderid", "externalorderid", "orderreference"],
  orderDate: ["orderdate", "date"],
  orderValue: ["ordervalue", "orderamount", "amount"],
  paymentMethod: ["paymentmethod", "paymenttype"],
  deliveryStatus: ["deliverystatus", "status"],
  deliveredAt: ["deliveredat", "deliverydate"],
  settlementDueAt: ["settlementdueat", "duedate"],
  expectedReceiptAt: ["expectedreceiptat", "expectedreceiptdate"],
  receivedAt: ["receivedat", "warehousereceivedat"],
  warehouseReceiptReference: ["warehousereceiptreference", "receiptreference"],
  transactionDate: ["transactiondate", "settlementdate", "paymentdate", "invoicedate", "refunddate"],
  netAmount: ["netamount", "netremittance", "remittedamount", "refundamount"],
  orderId: ["orderid", "externalorderid", "orderreference"],
  externalReference: ["transactionreference", "referencenumber", "settlementid", "invoiceid", "refundreference"],
  grossAmount: ["grossamount", "gross"],
  expectedAmount: ["expectedamount", "expectedrefundamount"],
  feeAmount: ["feeamount", "freightamount", "billedfreight", "fee"],
  tcsAmount: ["tcsamount", "tcs"],
  tdsAmount: ["tdsamount", "tds"],
  billedWeightKg: ["billedweightkg", "weightkg"],
  currency: ["currency", "currencycode"],
};

export type DeterministicMappingColumn = {
  sourceColumn: string;
  status: "mapped" | "ambiguous" | "unsupported";
  destinationField?: string;
  explanation: string;
};

export function suggestColumns(headers: string[], kind: ImportKind) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const columns: DeterministicMappingColumn[] = headers.map((sourceColumn) => {
    const matches = fieldDefinitions[kind].filter((field) =>
      (aliases[field.key] ?? [normalize(field.key)]).includes(normalize(sourceColumn)),
    );
    if (matches.length > 1) {
      return {
        sourceColumn,
        status: "ambiguous",
        explanation: "This header matches more than one allowed destination.",
      };
    }
    if (matches.length === 0) {
      return {
        sourceColumn,
        status: "unsupported",
        explanation: "No exact normalized header alias is available for this column.",
      };
    }
    return {
      sourceColumn,
      status: "mapped",
      destinationField: matches[0].key,
      explanation: "The normalized header exactly matches a configured alias.",
    };
  });

  const fieldsByColumn = new Map<string, DeterministicMappingColumn[]>();
  for (const column of columns) {
    if (!column.destinationField) continue;
    const candidates = fieldsByColumn.get(column.destinationField) ?? [];
    candidates.push(column);
    fieldsByColumn.set(column.destinationField, candidates);
  }
  for (const candidates of fieldsByColumn.values()) {
    if (candidates.length > 1) {
      for (const column of candidates) {
        column.status = "ambiguous";
        delete column.destinationField;
        column.explanation = "Multiple source headers match this destination.";
      }
    }
  }

  const mapping = Object.fromEntries(
    columns.flatMap((column) =>
      column.status === "mapped" && column.destinationField
        ? [[column.destinationField, column.sourceColumn]]
        : [],
    ),
  );
  return { mapping, columns };
}
