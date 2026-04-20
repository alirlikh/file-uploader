import { BUCKET, CHUNK_SIZE, s3, SIGNED_URL_EXPIRY } from "@/lib/config";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import { Readable } from "stream";
import { ChunkMeta } from "./types";

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

export async function fetchChunk(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const stream = res.Body as Readable;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (d: Buffer) => chunks.push(d));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
