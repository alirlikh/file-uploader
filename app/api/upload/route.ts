/**
 * POST /api/upload
 *
 * Authenticated, quota-checked, chunked file upload via SSE stream.
 * Chunks are stored at  uploads/{userId}/{randomHash}{ext}  in S3.
 * File metadata is persisted in SQLite after all chunks succeed.
 *
 * SSE event types:
 *   { type: "progress",   chunkIndex, done, total, percent, attempts }
 *   { type: "retry",      chunkIndex, attempt }
 *   { type: "chunkError", chunkIndex, attempt, message }
 *   { type: "done",       result: UploadResult }
 *   { type: "fatal",      message }
 */

import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto, { randomUUID } from "crypto";
import path from "path";
import { getSession } from "@/lib/auth";
import { reserveQuota, releaseQuota, createFile } from "@/lib/db";
import { BUCKET, s3 } from "@/lib/s3";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB
const SIGNED_URL_EXPIRY = 60 * 60 * 24; // 24 h
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// ── HELPERS ───────────────────────────────────────────────────────────────────

function splitIntoChunks(buffer: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    chunks.push(buffer.subarray(offset, offset + CHUNK_SIZE));
    offset += CHUNK_SIZE;
  }
  return chunks;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildManifest(
  filename: string,
  chunks: {
    chunkIndex: number;
    sizeBytes: number;
    expiresAt: string;
    signedDownloadUrl: string;
  }[],
  reconstructorUrl: string,
  fileHash: string,
): string {
  const lines = [
    "=== CHUNK MANIFEST ===",
    `File: ${filename}`,
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
    reconstructorUrl,
    "",
  );
  return lines.join("\n");
}

// ── ROUTE ─────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // ── Auth check ───────────────────────────────────────────────────────────────
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json(
      { error: "You must be logged in to upload files." },
      { status: 401 },
    );
  }
  const userId = session.sub;

  // ── Parse form data ───────────────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file)
    return NextResponse.json({ error: "No file provided." }, { status: 400 });

  const arrayBuffer = await file.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);
  const fileExt = path.extname(file.name);
  const mimeType = file.type || "application/octet-stream";
  const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const rawChunks = splitIntoChunks(fileBuffer);
  const total = rawChunks.length;

  // ── Quota check (atomic reserve) ──────────────────────────────────────────────
  const quota = reserveQuota(userId, fileBuffer.length);
  if (!quota.allowed) {
    const usedMB = Math.round(quota.used / 1024 / 1024);
    const limitMB = Math.round(quota.limit / 1024 / 1024);
    return NextResponse.json(
      {
        error: `Daily upload limit reached (${usedMB} MB / ${limitMB} MB). Resets at midnight UTC.`,
      },
      { status: 429 },
    );
  }

  // ── SSE stream ────────────────────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // Track chunk metadata for DB persistence
      interface ChunkRecord {
        id: string;
        chunkIndex: number;
        chunkKey: string;
        chunkHash: string;
        sizeBytes: number;
        signedDownloadUrl: string;
        expiresAt: string;
      }
      const chunkRecords: ChunkRecord[] = new Array(total);
      let done = 0;
      let uploadFailed = false;

      try {
        for (let i = 0; i < total; i++) {
          const chunkHash = crypto.randomBytes(32).toString("hex");
          // User-scoped S3 key — bucket policies can restrict per-user paths
          const chunkKey = `uploads/${userId}/${chunkHash}${fileExt}`;
          const expiresAt = new Date(
            Date.now() + SIGNED_URL_EXPIRY * 1000,
          ).toISOString();
          let attempts = 0;

          const uploadChunk = async (): Promise<string> => {
            let lastErr: unknown;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              try {
                if (attempt > 0) {
                  send({ type: "retry", chunkIndex: i, attempt });
                  await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
                }
                attempts = attempt + 1;

                await s3.send(
                  new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: chunkKey,
                    Body: rawChunks[i],
                    ContentType: mimeType,
                    Metadata: {
                      uploadedBy: userId,
                      fileHash,
                      chunkIndex: String(i),
                    },
                  }),
                );

                return await getSignedUrl(
                  s3,
                  new GetObjectCommand({ Bucket: BUCKET, Key: chunkKey }),
                  { expiresIn: SIGNED_URL_EXPIRY },
                );
              } catch (err) {
                lastErr = err;
                console.error(
                  `[upload] user=${userId} chunk ${i} attempt ${attempt + 1}:`,
                  err,
                );
                send({
                  type: "chunkError",
                  chunkIndex: i,
                  attempt: attempt + 1,
                  message: err instanceof Error ? err.message : String(err),
                });
              }
            }
            throw new Error(
              `Chunk ${i} failed after ${MAX_RETRIES} attempts: ${
                lastErr instanceof Error ? lastErr.message : String(lastErr)
              }`,
            );
          };

          const signedUrl = await uploadChunk();
          done++;

          chunkRecords[i] = {
            id: randomUUID(),
            chunkIndex: i,
            chunkKey,
            chunkHash,
            sizeBytes: rawChunks[i].length,
            signedDownloadUrl: signedUrl,
            expiresAt,
          };

          send({
            type: "progress",
            chunkIndex: i,
            done,
            total,
            percent: Math.round((done / total) * 100),
            attempts,
          });
        }

        // ── All chunks uploaded — persist to DB ─────────────────────────────────
        const fileId = randomUUID();
        const baseUrl =
          process.env.NEXT_PUBLIC_BASE_URL ??
          `https://${req.headers.get("host")}`;
        const chunkKeys = chunkRecords.map((c) => c.chunkKey);
        const reconstructorUrl = `${baseUrl}/api/download?keys=${encodeURIComponent(
          JSON.stringify(chunkKeys),
        )}&filename=${encodeURIComponent(file.name)}`;

        createFile({
          id: fileId,
          userId,
          originalFilename: file.name,
          fileSizeBytes: fileBuffer.length,
          fileHash,
          mimeType,
          chunks: chunkRecords.map(
            ({ id, chunkIndex, chunkKey, chunkHash, sizeBytes }) => ({
              id,
              chunkIndex,
              chunkKey,
              chunkHash,
              sizeBytes,
            }),
          ),
        });

        const manifest = buildManifest(
          file.name,
          chunkRecords,
          reconstructorUrl,
          fileHash,
        );

        send({
          type: "done",
          result: {
            success: true,
            fileId,
            originalFilename: file.name,
            totalChunks: total,
            fileSizeBytes: fileBuffer.length,
            fileHash,
            chunks: chunkRecords.map(
              ({
                chunkIndex,
                chunkHash,
                signedDownloadUrl,
                expiresAt,
                sizeBytes,
              }) => ({
                chunkIndex,
                hash: chunkHash,
                signedDownloadUrl,
                expiresAt,
                sizeBytes,
              }),
            ),
            reconstructorUrl,
            manifest,
          },
        });
      } catch (err) {
        uploadFailed = true;
        console.error("[upload] fatal:", err);
        send({
          type: "fatal",
          message: err instanceof Error ? err.message : "Upload failed.",
        });
        // Release the quota reservation since upload didn't complete
        releaseQuota(userId, fileBuffer.length);
      } finally {
        controller.close();
      }

      void uploadFailed; // suppress unused warning
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
