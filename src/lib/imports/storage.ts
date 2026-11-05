import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export class ImportStorageError extends Error {
  constructor() {
    super("Import storage operation failed.");
    this.name = "ImportStorageError";
  }
}

type S3Configuration = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

let cachedClient: { signature: string; client: S3Client } | undefined;

function storageKeyPath(key: string): string {
  if (!/^[a-f0-9]{64}\.(?:csv|xlsx)$/.test(key)) {
    throw new ImportStorageError();
  }
  return key;
}

function s3Configuration(): S3Configuration | null {
  const names = [
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ] as const;
  const values = names.map((name) => process.env[name]?.trim() ?? "");
  const hasAnyConfiguration = [
    ...values,
    process.env.S3_ENDPOINT?.trim() ?? "",
    process.env.S3_FORCE_PATH_STYLE?.trim() ?? "",
  ].some(Boolean);

  if (values.every(Boolean)) {
    const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
    if (endpoint) {
      try {
        const parsedEndpoint = new URL(endpoint);
        const isLocalDevelopment =
          process.env.NODE_ENV !== "production" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(parsedEndpoint.hostname);
        if (
          parsedEndpoint.username ||
          parsedEndpoint.password ||
          parsedEndpoint.search ||
          parsedEndpoint.hash ||
          (parsedEndpoint.protocol !== "https:" &&
            !(isLocalDevelopment && parsedEndpoint.protocol === "http:"))
        ) {
          throw new Error("Invalid S3 endpoint.");
        }
      } catch {
        throw new ImportStorageError();
      }
    }
    return {
      bucket: values[0],
      region: values[1],
      accessKeyId: values[2],
      secretAccessKey: values[3],
      endpoint,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE?.toLowerCase() !== "false",
    };
  }

  if (hasAnyConfiguration || process.env.NODE_ENV === "production") {
    throw new ImportStorageError();
  }
  return null;
}

function s3Client(configuration: S3Configuration): S3Client {
  const signature = JSON.stringify(configuration);
  if (!cachedClient || cachedClient.signature !== signature) {
    cachedClient = {
      signature,
      client: new S3Client({
        region: configuration.region,
        endpoint: configuration.endpoint,
        forcePathStyle: configuration.forcePathStyle,
        credentials: {
          accessKeyId: configuration.accessKeyId,
          secretAccessKey: configuration.secretAccessKey,
        },
      }),
    };
  }
  return cachedClient.client;
}

function localObjectPath(key: string): string {
  return path.join(process.cwd(), ".data", "imports", storageKeyPath(key));
}

export async function putImportFile(key: string, contents: Buffer): Promise<void> {
  const safeKey = storageKeyPath(key);
  const configuration = s3Configuration();

  if (configuration) {
    try {
      await s3Client(configuration).send(
        new PutObjectCommand({
          Bucket: configuration.bucket,
          Key: safeKey,
          Body: contents,
          ContentType: safeKey.endsWith(".csv")
            ? "text/csv"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
    } catch {
      throw new ImportStorageError();
    }
    return;
  }

  const filePath = localObjectPath(safeKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, contents, { flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw new ImportStorageError();
    }
  }
}

export async function withImportFile<T>(
  key: string,
  operation: (filePath: string) => Promise<T>,
): Promise<T> {
  const safeKey = storageKeyPath(key);
  const configuration = s3Configuration();
  if (!configuration) {
    return operation(localObjectPath(safeKey));
  }

  const workingDirectory = path.join(process.cwd(), ".data", "import-working");
  const workingFile = path.join(
    workingDirectory,
    `${randomUUID()}${path.extname(safeKey)}`,
  );
  await mkdir(workingDirectory, { recursive: true });
  try {
    let response;
    try {
      response = await s3Client(configuration).send(
        new GetObjectCommand({
          Bucket: configuration.bucket,
          Key: safeKey,
        }),
      );
      if (!response.Body) throw new Error("Missing object body.");
      const contents = await response.Body.transformToByteArray();
      await writeFile(workingFile, contents, { flag: "wx" });
    } catch {
      throw new ImportStorageError();
    }

    return await operation(workingFile);
  } finally {
    try {
      await rm(workingFile, { force: true });
    } catch {
      throw new ImportStorageError();
    }
  }
}

export async function readImportFile(key: string): Promise<Buffer> {
  return withImportFile(key, (filePath) => readFile(filePath));
}
