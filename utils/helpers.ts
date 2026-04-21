import {
  BUCKET,
  CHUNK_SIZE,
  MAX_RETRIES,
  RETRY_BASE_MS,
  s3,
  SIGNED_URL_EXPIRY,
} from "@/lib/config";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import { Readable } from "stream";
import { ChunkMeta, ChunkResult } from "./types";

/**
 * Generates a cryptographically random hash for a chunk.
 * Each chunk gets its OWN isolated hash — nothing in the key
 * reveals which file or position it belongs to.
 *
 * TODO (auth): When user auth is added, prepend userId to the S3 key prefix
 *              so bucket policies can enforce per-user path access:
 *              `uploads/${userId}/${chunkHash}${ext}`
 */
export function generateChunkHash(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Splits a Buffer into an array of 10 MB (or smaller) Buffer chunks.
 */
export function splitIntoChunks(buffer: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    chunks.push(buffer.subarray(offset, offset + CHUNK_SIZE));
    offset += CHUNK_SIZE;
  }
  return chunks;
}

/** Sleep helper for retry back-off. */
export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Uploads one chunk to S3 with automatic retry.
 *
 * Retry strategy: up to MAX_RETRIES attempts.
 * Back-off: RETRY_BASE_MS * 2^attempt  (500 ms → 1 s → 2 s).
 *
 * On success returns a presigned GET URL.
 * On exhausted retries throws with the last error message.
 *
 * TODO (auth): Add Metadata: { uploadedBy: userId } for per-user audit trail.
 * TODO (auth): Use `uploads/${userId}/${hash}${ext}` key prefix for bucket-policy scoping.
 */
export async function uploadChunkWithRetry(
  chunkBuffer: Buffer,
  chunkKey: string,
  mimeType: string,
  chunkIndex: number,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.log(
          `[upload] chunk ${chunkIndex} retry ${attempt}/${MAX_RETRIES - 1} in ${delay} ms`,
        );
        await sleep(delay);
      }

      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: chunkKey,
          Body: chunkBuffer,
          ContentType: mimeType,
        }),
      );

      const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: chunkKey }),
        { expiresIn: SIGNED_URL_EXPIRY },
      );

      return signedUrl; // success
    } catch (err) {
      lastError = err;
      console.error(
        `[upload] chunk ${chunkIndex} attempt ${attempt + 1} failed:`,
        err,
      );
    }
  }

  throw new Error(
    `Chunk ${chunkIndex} failed after ${MAX_RETRIES} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Uploads a single chunk to S3 and returns a presigned download URL.
 */
export async function uploadChunk(
  chunkBuffer: Buffer,
  chunkKey: string,
  originalMimeType: string,
): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: chunkKey,
      Body: chunkBuffer,
      ContentType: originalMimeType,
      // TODO (auth): Add Metadata: { uploadedBy: userId } for audit trail
    }),
  );

  const signedUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: chunkKey }),
    { expiresIn: SIGNED_URL_EXPIRY },
  );

  return signedUrl;
}

/**
 * Builds the manifest.txt content listing every chunk's download URL
 * and the reconstructor endpoint URL.
 */
export function buildManifest(
  originalFilename: string,
  chunks: ChunkMeta[],
  reconstructorUrl: string,
  fileHash: string,
): string {
  const lines: string[] = [
    "=== CHUNK MANIFEST ===",
    `File: ${originalFilename}`,
    `Total chunks: ${chunks.length}`,
    `File hash (SHA-256): ${fileHash}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "--- CHUNK DOWNLOAD LINKS (each expires 24 h) ---",
  ];

  for (const c of chunks) {
    lines.push(
      `Chunk ${c.chunkIndex + 1}/${chunks.length}  |  ${c.sizeBytes} bytes  |  expires: ${c.expiresAt}`,
      c.signedDownloadUrl,
      "",
    );
  }

  lines.push(
    "--- SINGLE RECONSTRUCTED DOWNLOAD LINK ---",
    `This endpoint streams and reassembles all chunks on-the-fly:`,
    reconstructorUrl,
    "",
  );

  return lines.join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function fetchChunk(
  index: number,
  key: string,
): Promise<ChunkResult> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    const stream = res.Body as Readable;
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = [];
      stream.on("data", (d: Buffer) => parts.push(d));
      stream.on("end", () => resolve(Buffer.concat(parts)));
      stream.on("error", reject);
    });
    return { ok: true, index, buffer };
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    const code =
      (err as { Code?: string; $metadata?: { httpStatusCode?: number } })
        .Code ??
      String(
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode ?? "",
      );
    const message = err instanceof Error ? err.message : String(err);

    // ── Missing: object deleted or was never uploaded ─────────────────────────
    if (name === "NoSuchKey" || code === "NoSuchKey" || code === "404") {
      return {
        ok: false,
        index,
        reason: "missing",
        detail: "Object not found in bucket",
      };
    }

    // ── Expired: presigned URL TTL has elapsed (S3 sends 403 AccessDenied
    //    or 400 RequestExpired — we treat both as "expired") ───────────────────
    if (
      name === "AccessDenied" ||
      code === "AccessDenied" ||
      name === "RequestExpired" ||
      code === "RequestExpired" ||
      code === "403"
    ) {
      return {
        ok: false,
        index,
        reason: "expired",
        detail: "Presigned URL has expired",
      };
    }

    return { ok: false, index, reason: "error", detail: message };
  }
}
