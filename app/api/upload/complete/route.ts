/**
 * POST /api/upload/complete — Step 2: persist file + chunks to DB.
 *
 * Called by the client after every chunk has been PUT to S3 directly.
 *
 * Design decisions for large-file reliability:
 *
 * 1. NO S3 HeadObject verification loop.
 *    The original version called HeadObjectCommand for every chunk before
 *    persisting. For 100 chunks that's 100 sequential AWS API round-trips
 *    (~1-5 s each in the worst case) = minutes of wall time before the DB
 *    call. We skip this: the chunk keys were generated server-side in
 *    /presign, the client PUT to those exact keys, and S3 PUT is atomic.
 *    If a chunk is missing the /api/download route will detect it clearly.
 *
 * 2. Bulk chunk insert (single SQL round-trip).
 *    createFile() in lib/db.ts now uses one INSERT ... VALUES (...),(...)
 *    statement for all chunks instead of a loop of N queries.
 *
 * 3. withRetry wraps the DB persist.
 *    If the Postgres connection was killed while S3 uploads ran (common on
 *    cloud DBs with short proxy timeouts), withRetry grabs a fresh connection
 *    from the pool and retries up to 3 times with exponential back-off.
 */
import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { getSession } from "@/lib/auth";
import { createFile, releaseQuota, withRetry } from "@/lib/db";
import { s3, BUCKET } from "@/lib/s3";
import { pendingUploads } from "@/app/api/upload/presign/route";

const GET_URL_EXPIRY_SEC = 60 * 60 * 24; // 24 h

export async function POST(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  // ── Parse ──────────────────────────────────────────────────────────────────
  let body: { uploadId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { uploadId } = body;
  if (!uploadId)
    return NextResponse.json({ error: "Missing uploadId." }, { status: 400 });

  // ── Look up pending upload ─────────────────────────────────────────────────
  const pending = pendingUploads.get(uploadId);
  if (!pending)
    return NextResponse.json(
      {
        error:
          "Upload session not found or expired. If this was a large file, try refreshing and re-uploading.",
      },
      { status: 404 },
    );
  if (pending.userId !== session.sub)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  // ── Build reconstructor URL ────────────────────────────────────────────────
  const fileId = randomUUID();
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ?? `https://${req.headers.get("host")}`;
  const keys = pending.chunks.map((c) => c.chunkKey);
  const reconstructorUrl =
    `${base}/api/download` +
    `?keys=${encodeURIComponent(JSON.stringify(keys))}` +
    `&filename=${encodeURIComponent(pending.filename)}`;

  // ── Persist to DB (with retry on stale connection) ─────────────────────────
  // withRetry handles "Connection terminated unexpectedly" errors that occur
  // when the Postgres connection was idle during the S3 upload phase. It grabs
  // a fresh connection from the pool and retries up to 3 times.
  try {
    await withRetry(() =>
      createFile({
        id: fileId,
        userId: pending.userId,
        originalFilename: pending.filename,
        fileSizeBytes: pending.fileSizeBytes,
        fileHash: pending.fileHash,
        mimeType: pending.mimeType,
        chunks: pending.chunks.map((c) => ({
          id: randomUUID(),
          chunkIndex: c.chunkIndex,
          chunkKey: c.chunkKey,
          chunkHash: c.chunkHash,
          sizeBytes: c.sizeBytes,
        })),
      }),
    );
  } catch (err) {
    console.error("[upload/complete] DB persist failed after retries:", err);
    // Release quota since we can't track the file
    await releaseQuota(pending.userId, pending.fileSizeBytes).catch(() => {});
    pendingUploads.delete(uploadId);
    return NextResponse.json(
      {
        error:
          "Failed to save file record after multiple attempts. Your chunks are safely stored in S3 — please contact support with upload ID: " +
          uploadId,
      },
      { status: 500 },
    );
  }

  // ── Generate signed GET URLs (after DB success) ───────────────────────────
  // Done after DB persist so a DB failure doesn't waste presigning work.
  const chunksWithUrls = await Promise.all(
    pending.chunks.map(async (c) => {
      const expiresAt = new Date(
        Date.now() + GET_URL_EXPIRY_SEC * 1000,
      ).toISOString();
      const signedDownloadUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: c.chunkKey }),
        { expiresIn: GET_URL_EXPIRY_SEC },
      );
      return { ...c, signedDownloadUrl, expiresAt };
    }),
  );

  // ── Clean up pending state ─────────────────────────────────────────────────
  pendingUploads.delete(uploadId);

  // ── Build manifest ─────────────────────────────────────────────────────────
  const manifestLines = [
    "=== CHUNK MANIFEST ===",
    `File: ${pending.filename}`,
    `Total chunks: ${pending.chunks.length}`,
    `SHA-256: ${pending.fileHash}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "--- CHUNK DOWNLOAD LINKS ---",
  ];
  for (const c of chunksWithUrls) {
    manifestLines.push(
      `Chunk ${c.chunkIndex + 1}/${pending.chunks.length}  |  ${c.sizeBytes} bytes  |  expires: ${c.expiresAt}`,
      c.signedDownloadUrl,
      "",
    );
  }
  manifestLines.push("--- RECONSTRUCTED DOWNLOAD ---", reconstructorUrl, "");

  return NextResponse.json({
    success: true,
    fileId,
    originalFilename: pending.filename,
    totalChunks: pending.chunks.length,
    fileSizeBytes: pending.fileSizeBytes,
    fileHash: pending.fileHash,
    chunks: chunksWithUrls.map((c) => ({
      chunkIndex: c.chunkIndex,
      hash: c.chunkHash,
      signedDownloadUrl: c.signedDownloadUrl,
      expiresAt: c.expiresAt,
      sizeBytes: c.sizeBytes,
    })),
    reconstructorUrl,
    manifest: manifestLines.join("\n"),
  });
}
