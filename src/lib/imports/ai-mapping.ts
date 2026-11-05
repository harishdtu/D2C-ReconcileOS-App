import "server-only";

import { ImportKind, MappingSuggestionStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { fieldDefinitions } from "./mapping";
import type { ColumnMapping } from "./service";
import { suggestColumns } from "./mapping";

const providerResponseSchema = z.object({
  explanation: z.string().min(1).max(1000),
  columns: z.array(z.object({
    sourceColumn: z.string().min(1).max(255),
    status: z.enum(["mapped", "ambiguous", "unsupported"]),
    destinationField: z.string().min(1).max(100).optional(),
    confidence: z.number().min(0).max(1),
    explanation: z.string().min(1).max(500),
  }).strict()).max(200),
}).strict();

type ProviderColumn = z.infer<typeof providerResponseSchema>["columns"][number];

export class MappingSuggestionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingSuggestionInputError";
  }
}

class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

function providerConfig() {
  const endpoint = process.env.RECONCILEOS_MAPPING_AI_ENDPOINT;
  const apiKey = process.env.RECONCILEOS_MAPPING_AI_API_KEY;
  const model = process.env.RECONCILEOS_MAPPING_AI_MODEL;
  if (!endpoint || !apiKey || !model) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  const localHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return { endpoint: url.toString(), apiKey, model };
}

function parseStructuredContent(content: unknown): unknown {
  if (typeof content !== "string") {
    throw new ProviderUnavailableError("AI provider returned no structured suggestion.");
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new ProviderUnavailableError("AI provider returned invalid structured data.");
  }
}

function validateProviderColumns(input: {
  headers: string[];
  kind: ImportKind;
  columns: ProviderColumn[];
}) {
  if (input.columns.length !== input.headers.length) {
    throw new ProviderUnavailableError("AI provider did not classify every source column.");
  }
  const seenHeaders = new Set<string>();
  const seenFields = new Set<string>();
  const allowedFields = new Set(fieldDefinitions[input.kind].map((field) => field.key));
  for (const column of input.columns) {
    if (!input.headers.includes(column.sourceColumn) || seenHeaders.has(column.sourceColumn)) {
      throw new ProviderUnavailableError("AI provider returned an unknown or duplicate source column.");
    }
    seenHeaders.add(column.sourceColumn);
    if (column.status === "mapped") {
      if (
        !column.destinationField ||
        !allowedFields.has(column.destinationField) ||
        seenFields.has(column.destinationField)
      ) {
        throw new ProviderUnavailableError("AI provider returned an invalid or duplicate destination field.");
      }
      seenFields.add(column.destinationField);
    } else if (column.destinationField) {
      throw new ProviderUnavailableError("AI provider assigned a destination to an uncertain column.");
    }
  }
  const mapping: ColumnMapping = {};
  for (const column of input.columns) {
    if (column.status === "mapped" && column.destinationField) {
      mapping[column.destinationField] = column.sourceColumn;
    }
  }
  return mapping;
}

async function requestProvider(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  kind: ImportKind;
  headers: string[];
}) {
  let response: Response;
  try {
    response = await fetch(input.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Suggest source-column mappings only. Return JSON with an explanation and a columns array. Classify every provided source column exactly once as mapped, ambiguous, or unsupported. Map only to allowed destination field keys. For ambiguous or unsupported columns, omit destinationField and explain uncertainty. Give each column a confidence from 0 to 1; this is a model estimate, not a calibrated probability. Never infer values from rows; none are supplied.",
          },
          {
            role: "user",
            content: JSON.stringify({
              importKind: input.kind,
              sourceColumnHeaders: input.headers,
              allowedDestinationFields: fieldDefinitions[input.kind].map(({ key, label, required }) => ({
                key,
                label,
                required: required === true,
              })),
            }),
          },
        ],
      }),
    });
  } catch (error) {
    const detail = error instanceof Error && error.name === "TimeoutError"
      ? "AI mapping provider timed out."
      : "AI mapping provider is unavailable.";
    throw new ProviderUnavailableError(detail);
  }
  if (!response.ok) {
    throw new ProviderUnavailableError(`AI mapping provider returned HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderUnavailableError("AI mapping provider returned an invalid response.");
  }
  const content = z.object({
    choices: z.array(z.object({
      message: z.object({ content: z.unknown() }).passthrough(),
    }).passthrough()).min(1),
  }).passthrough().safeParse(payload);
  if (!content.success) {
    throw new ProviderUnavailableError("AI mapping provider returned no suggestion.");
  }
  const structured = providerResponseSchema.safeParse(
    parseStructuredContent(content.data.choices[0].message.content),
  );
  if (!structured.success) {
    throw new ProviderUnavailableError("AI mapping provider returned an invalid suggestion.");
  }
  const mapping = validateProviderColumns({
    headers: input.headers,
    kind: input.kind,
    columns: structured.data.columns,
  });
  return { ...structured.data, mapping };
}

export async function suggestSourceMapping(batchId: string, actorId: string) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      sourceId: true,
      status: true,
      previewHeaders: true,
      source: { select: { kind: true } },
    },
  });
  if (!batch) throw new MappingSuggestionInputError("Import batch was not found.");
  if (batch.status !== "PREVIEWED") {
    throw new MappingSuggestionInputError("Mapping suggestions are available only for previewed imports.");
  }
  const headers = Array.isArray(batch.previewHeaders) &&
    batch.previewHeaders.every((header): header is string => typeof header === "string")
    ? batch.previewHeaders
    : [];
  if (headers.length === 0) {
    throw new MappingSuggestionInputError("This import has no source-column headers.");
  }

  const config = providerConfig();
  if (!config || headers.length > 200) {
    const fallback = suggestColumns(headers, batch.source.kind);
    const unavailableReason = headers.length > 200
      ? "AI mapping suggestions are limited to files with no more than 200 source columns."
      : "Configure the mapping AI endpoint, model, and API key on the server to enable AI suggestions.";
    return {
      mode: "DETERMINISTIC" as const,
      mapping: fallback.mapping,
      columns: fallback.columns,
      explanation: `${unavailableReason} Exact normalized header aliases are shown as deterministic suggestions; review them before importing.`,
      unavailableReason,
    };
  }

  try {
    const suggestion = await requestProvider({
      ...config,
      kind: batch.source.kind,
      headers,
    });
    const mappedColumns = suggestion.columns.filter((column) => column.status === "mapped");
    const confidence = mappedColumns.length
      ? mappedColumns.reduce((sum, column) => sum + column.confidence, 0) / mappedColumns.length
      : null;
    const saved = await prisma.$transaction(async (tx) => {
      const created = await tx.mappingSuggestion.create({
        data: {
          sourceId: batch.sourceId,
          batchId: batch.id,
          proposed: {
            source: "ai",
            model: config.model,
            mapping: suggestion.mapping,
            columns: suggestion.columns,
            explanation: suggestion.explanation,
          } as Prisma.InputJsonObject,
          confidence: confidence === null ? null : new Prisma.Decimal(confidence.toFixed(4)),
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: "AI_MAPPING_SUGGESTION_CREATED",
          entityType: "MappingSuggestion",
          entityId: created.id,
          details: {
            batchId: batch.id,
            sourceId: batch.sourceId,
            model: config.model,
            mappedColumns: mappedColumns.length,
            uncertainColumns: suggestion.columns.length - mappedColumns.length,
          },
        },
      });
      return created;
    });
    return {
      id: saved.id,
      mode: "AI" as const,
      mapping: suggestion.mapping,
      columns: suggestion.columns,
      confidence,
      explanation: suggestion.explanation,
      unavailableReason: null,
    };
  } catch (error) {
    if (!(error instanceof ProviderUnavailableError)) throw error;
    const fallback = suggestColumns(headers, batch.source.kind);
    return {
      mode: "DETERMINISTIC" as const,
      mapping: fallback.mapping,
      columns: fallback.columns,
      explanation: `${error.message} Exact normalized header aliases are provided as deterministic suggestions; review them before importing.`,
      unavailableReason: error.message,
    };
  }
}

export async function recordMappingSuggestionDecision(input: {
  suggestionId: string;
  batchId: string;
  sourceId: string;
  mapping: ColumnMapping;
  actorId: string;
}) {
  const suggestion = await prisma.mappingSuggestion.findFirst({
    where: {
      id: input.suggestionId,
      batchId: input.batchId,
      sourceId: input.sourceId,
      status: MappingSuggestionStatus.PENDING,
    },
    select: { id: true, proposed: true },
  });
  if (!suggestion) {
    throw new MappingSuggestionInputError("The AI mapping suggestion is no longer pending for this import.");
  }
  const proposed = z.object({
    mapping: z.record(z.string(), z.string()),
  }).safeParse(suggestion.proposed);
  const proposedMapping = proposed.success ? proposed.data.mapping : null;
  const approved = proposedMapping !== null &&
    JSON.stringify(Object.entries(proposedMapping).sort(([a], [b]) => a.localeCompare(b))) ===
      JSON.stringify(Object.entries(input.mapping).sort(([a], [b]) => a.localeCompare(b)));
  const status = approved ? MappingSuggestionStatus.APPROVED : MappingSuggestionStatus.REJECTED;
  await prisma.$transaction(async (tx) => {
    const result = await tx.mappingSuggestion.updateMany({
      where: { id: suggestion.id, status: MappingSuggestionStatus.PENDING },
      data: {
        status,
        decidedById: input.actorId,
        decidedAt: new Date(),
      },
    });
    if (result.count !== 1) {
      throw new MappingSuggestionInputError("The AI mapping suggestion was already decided.");
    }
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: approved ? "AI_MAPPING_SUGGESTION_APPROVED" : "AI_MAPPING_SUGGESTION_REJECTED",
        entityType: "MappingSuggestion",
        entityId: suggestion.id,
        details: { batchId: input.batchId, sourceId: input.sourceId },
      },
    });
  });
}
