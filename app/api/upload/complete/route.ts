/**
 * POST /api/upload/complete
 *
 * Step 2 of the browser-direct-to-S3 upload flow.
 *
 * Called by the client after every chunk has been PUT to S3 directly.
 * Verifies each chunk actually exists in S3 (HeadObject), then persists
 * the file record to SQLite and returns signed GET download URLs.
 *
 * Body: { uploadId }
 *
 * Response: same UploadResult shape the old SSE "done" event produced,
 *           so the UI code requires zero changes after this call.
 */
import { NextRequest, NextResponse } from "next/server";
import { HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { getSession } from "@/lib/auth";
import { createFile, releaseQuota } from "@/lib/db";
import { s3, BUCKET } from "@/lib/s3";
import { pendingUploads } from "@/app/api/upload/presign/route";

const GET_URL_EXPIRY_SEC = 60 * 60 * 24; // 24 h download links

export async function POST(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  // ── Parse ────────────────────────────────────────────────────────────────────
  let body: { uploadId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { uploadId } = body;
  if (!uploadId)
    return NextResponse.json({ error: "Missing uploadId." }, { status: 400 });

  // ── Look up pending upload ────────────────────────────────────────────────────
  const pending = pendingUploads.get(uploadId);
  if (!pending)
    return NextResponse.json(
      { error: "Upload session not found or expired." },
      { status: 404 },
    );
  if (pending.userId !== session.sub)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  // ── Verify every chunk exists in S3 ──────────────────────────────────────────
  const missingChunks: number[] = [];
  await Promise.all(
    pending.chunks.map(async (c) => {
      try {
        await s3.send(
          new HeadObjectCommand({ Bucket: BUCKET, Key: c.chunkKey }),
        );
      } catch {
        missingChunks.push(c.chunkIndex);
      }
    }),
  );

  if (missingChunks.length > 0) {
    // Don't release quota — client should retry the missing chunks and call complete again
    return NextResponse.json(
      {
        error: `${missingChunks.length} chunk(s) not found in storage. Re-upload the missing chunks and try again.`,
        missingChunks: missingChunks.sort((a, b) => a - b),
      },
      { status: 422 },
    );
  }

  // ── Generate signed GET URLs for each chunk ───────────────────────────────────
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

  // ── Persist to DB ──────────────────────────────────────────────────────────
  const fileId = randomUUID();
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ?? `https://${req.headers.get("host")}`;
  const keys = pending.chunks.map((c) => c.chunkKey);

  const reconstructorUrl =
    `${base}/api/download` +
    `?keys=${encodeURIComponent(JSON.stringify(keys))}` +
    `&filename=${encodeURIComponent(pending.filename)}`;

  try {
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
    });
  } catch (err) {
    console.error("[upload/complete] DB persist failed:", err);
    // Release quota since we can't track the file
    releaseQuota(pending.userId, pending.fileSizeBytes);
    pendingUploads.delete(uploadId);
    return NextResponse.json(
      { error: "Failed to save file record." },
      { status: 500 },
    );
  }

  // ── Clean up pending state ────────────────────────────────────────────────────
  pendingUploads.delete(uploadId);

  // ── Build manifest ───────────────────────────────────────────────────────────
  const manifestLines = [
    "=== CHUNK MANIFEST ===",
    `File: ${pending.filename}`,
    `Total chunks: ${pending.chunks.length}`,
    `SHA-256: ${pending.fileHash}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "--- CHUNK DOWNLOAD LINKS (each expires 24 h) ---",
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
