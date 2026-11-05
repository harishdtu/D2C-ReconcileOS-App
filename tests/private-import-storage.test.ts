import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ImportKind, UserRole } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuditCreate,
  mockBatchCreate,
  mockFindUnique,
  mockPartnerFindUnique,
  mockRequirePermission,
  mockSend,
  mockSourceUpsert,
} = vi.hoisted(() => ({
  mockAuditCreate: vi.fn(),
  mockBatchCreate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockPartnerFindUnique: vi.fn(),
  mockRequirePermission: vi.fn(),
  mockSend: vi.fn(),
  mockSourceUpsert: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = mockSend;
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@/lib/auth", () => {
  class AuthenticationError extends Error {}
  class AuthorizationError extends Error {}
  return {
    AuthenticationError,
    AuthorizationError,
    requirePermission: mockRequirePermission,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: mockAuditCreate },
    importBatch: { create: mockBatchCreate, findUnique: mockFindUnique },
    importSource: { upsert: mockSourceUpsert },
    partner: { findUnique: mockPartnerFindUnique },
  },
}));

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GET } from "../src/app/api/imports/[batchId]/file/route";
import { AuthorizationError } from "../src/lib/auth";
import { hasPermission } from "../src/lib/authorization";
import { uploadImportPreview } from "../src/lib/imports/service";
import { ImportStorageError, putImportFile, withImportFile } from "../src/lib/imports/storage";

const key = `${"a".repeat(64)}.csv`;
const fileBytes = Buffer.from("Order ID,Value\r\nORD-1,125.00\r\n");

function s3ObjectBody(contents: Buffer) {
  return { transformToByteArray: async () => new Uint8Array(contents) };
}

describe("private import file storage", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("S3_BUCKET", "private-imports");
    vi.stubEnv("S3_REGION", "us-east-1");
    vi.stubEnv("S3_ENDPOINT", "https://s3.example.test");
    vi.stubEnv("S3_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("S3_FORCE_PATH_STYLE", "true");
    mockAuditCreate.mockReset();
    mockBatchCreate.mockReset();
    mockFindUnique.mockReset();
    mockPartnerFindUnique.mockReset();
    mockRequirePermission.mockReset();
    mockSend.mockReset();
    mockSourceUpsert.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uploads privately and retrieves the original through an authenticated no-store route", async () => {
    mockRequirePermission.mockResolvedValue({ id: "finance-user", role: "FINANCE_EXECUTIVE" });
    mockFindUnique.mockResolvedValue({ fileName: "orders.csv", storageKey: key });
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: s3ObjectBody(fileBytes) };
      }
      return {};
    });

    await putImportFile(key, fileBytes);
    const response = await GET(
      new Request("https://app.example.test/api/imports/batch-1/file"),
      { params: Promise.resolve({ batchId: "batch-1" }) },
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fileBytes);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain(
      "attachment; filename=\"orders.csv\"",
    );
    expect(mockRequirePermission).toHaveBeenCalledWith("MANAGE_IMPORTS");
    const putCommand = mockSend.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(putCommand.input).toMatchObject({
      Bucket: "private-imports",
      Key: key,
      Body: fileBytes,
    });
    expect(putCommand.input).not.toHaveProperty("ACL");
    expect(mockSend.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(true);
    expect(response.headers.get("location")).toBeNull();
  });

  it("uses private S3 storage for import upload and preview parsing", async () => {
    mockPartnerFindUnique.mockResolvedValue({ id: "partner-1" });
    mockSourceUpsert.mockResolvedValue({ id: "source-1" });
    mockFindUnique.mockResolvedValue(null);
    mockBatchCreate.mockResolvedValue({ id: "batch-1", status: "PREVIEWED" });
    mockAuditCreate.mockResolvedValue({});
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === "GetObjectCommand"
        ? { Body: s3ObjectBody(fileBytes) }
        : {},
    );

    const result = await uploadImportPreview({
      partnerCode: "website",
      kind: ImportKind.ORDER,
      sourceKey: "private-storage-test",
      fileName: "orders.csv",
      file: fileBytes,
      uploadedById: "finance-user",
    });

    const contentHash = createHash("sha256").update(fileBytes).digest("hex");
    expect(result).toMatchObject({
      id: "batch-1",
      status: "PREVIEWED",
      totalRows: 1,
      headers: ["Order ID", "Value"],
    });
    expect(mockSend.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(true);
    expect(mockSend.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(true);
    expect(mockBatchCreate.mock.calls[0][0].data.storageKey).toBe(`${contentHash}.csv`);
  });

  it("removes its S3 working file after the callback completes", async () => {
    let workingFile = "";
    mockSend.mockResolvedValue({ Body: s3ObjectBody(fileBytes) });

    await expect(
      withImportFile(key, async (filePath) => {
        workingFile = filePath;
        return readFile(filePath);
      }),
    ).resolves.toEqual(fileBytes);

    await expect(access(workingFile)).rejects.toThrow();
  });

  it("removes its S3 working file when import processing fails", async () => {
    let workingFile = "";
    mockSend.mockResolvedValue({ Body: s3ObjectBody(fileBytes) });

    await expect(
      withImportFile(key, async (filePath) => {
        workingFile = filePath;
        throw new Error("parser failure");
      }),
    ).rejects.toThrow("parser failure");

    await expect(access(workingFile)).rejects.toThrow();
  });

  it("prevents a stored filename from injecting response headers", async () => {
    mockRequirePermission.mockResolvedValue({ id: "finance-user", role: "FINANCE_EXECUTIVE" });
    mockFindUnique.mockResolvedValue({
      fileName: 'orders.csv"\r\nX-Injected: yes',
      storageKey: key,
    });
    mockSend.mockResolvedValue({ Body: s3ObjectBody(fileBytes) });

    const response = await GET(
      new Request("https://app.example.test/api/imports/batch-1/file"),
      { params: Promise.resolve({ batchId: "batch-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-injected")).toBeNull();
    expect(response.headers.get("content-disposition")).not.toContain("\r");
  });

  it("denies a Co-Founder before looking up or downloading an import", async () => {
    expect(hasPermission(UserRole.CO_FOUNDER, "MANAGE_IMPORTS")).toBe(false);
    mockRequirePermission.mockRejectedValue(new AuthorizationError("Not permitted."));

    const response = await GET(
      new Request("https://app.example.test/api/imports/batch-1/file"),
      { params: Promise.resolve({ batchId: "batch-1" }) },
    );

    expect(response.status).toBe(403);
    expect(mockRequirePermission).toHaveBeenCalledWith("MANAGE_IMPORTS");
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("fails closed when production has no S3 configuration", async () => {
    vi.stubEnv("S3_BUCKET", "");
    vi.stubEnv("S3_REGION", "");
    vi.stubEnv("S3_ENDPOINT", "");
    vi.stubEnv("S3_ACCESS_KEY_ID", "");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "");

    await expect(putImportFile(key, fileBytes)).rejects.toBeInstanceOf(ImportStorageError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("rejects insecure or credential-bearing production S3 endpoints", async () => {
    vi.stubEnv("S3_ENDPOINT", "http://objects.example.test");
    await expect(putImportFile(key, fileBytes)).rejects.toBeInstanceOf(ImportStorageError);
    vi.stubEnv("S3_ENDPOINT", "https://user:password@objects.example.test");
    await expect(putImportFile(key, fileBytes)).rejects.toBeInstanceOf(ImportStorageError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns a generic server error when S3 fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRequirePermission.mockResolvedValue({ id: "finance-user", role: "FINANCE_EXECUTIVE" });
    mockFindUnique.mockResolvedValue({ fileName: "orders.csv", storageKey: key });
    mockSend.mockRejectedValue(new Error("provider details and credentials must not escape"));

    try {
      const response = await GET(
        new Request("https://app.example.test/api/imports/batch-1/file"),
        { params: Promise.resolve({ batchId: "batch-1" }) },
      );
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"Internal server error."}');
      expect(mockRequirePermission).toHaveBeenCalledWith("MANAGE_IMPORTS");
    } finally {
      consoleError.mockRestore();
    }
  });
});
