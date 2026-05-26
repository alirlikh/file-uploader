/**
 * POST /api/upload/complete
 * Body: { uploadId, comment? }
 */
import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID, randomBytes } from "crypto";
import { getSession } from "@/lib/auth";
import { createFile, releaseQuota, withRetry } from "@/lib/db";
import { s3, BUCKET } from "@/lib/s3";
import { pendingUploads } from "@/app/api/upload/presign/route";

const GET_URL_EXPIRY_SEC = 60 * 60 * 24;

function generateDownloadToken(): string {
  return randomBytes(12).toString("base64url");
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  let body: { uploadId: string; comment?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const { uploadId, comment } = body;
  if (!uploadId)
    return NextResponse.json({ error: "Missing uploadId." }, { status: 400 });

  const pending = pendingUploads.get(uploadId);
  if (!pending)
    return NextResponse.json(
      { error: "Upload session not found or expired." },
      { status: 404 },
    );
  if (pending.userId !== session.sub)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  const fileId = randomUUID();
  const downloadToken = generateDownloadToken();
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ?? `https://${req.headers.get("host")}`;
  const keys = pending.chunks.map((c) => c.chunkKey);
  const reconstructorUrl = `${base}/api/download?keys=${encodeURIComponent(JSON.stringify(keys))}&filename=${encodeURIComponent(pending.filename)}`;
  const downloadPageUrl = `${base}/download/${downloadToken}`;

  try {
    await withRetry(() =>
      createFile({
        id: fileId,
        userId: pending.userId,
        originalFilename: pending.filename,
        fileSizeBytes: pending.fileSizeBytes,
        fileHash: pending.fileHash,
        mimeType: pending.mimeType,
        comment: comment?.trim() || null,
        downloadToken,
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
    console.error("[upload/complete] DB persist failed:", err);
    await releaseQuota(pending.userId, pending.fileSizeBytes).catch(() => {});
    pendingUploads.delete(uploadId);
    return NextResponse.json(
      { error: "Failed to save file record." },
      { status: 500 },
    );
  }

  const chunksWithUrls = await Promise.all(
    pending.chunks.map(async (c) => ({
      ...c,
      expiresAt: new Date(Date.now() + GET_URL_EXPIRY_SEC * 1000).toISOString(),
      signedDownloadUrl: await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: c.chunkKey }),
        { expiresIn: GET_URL_EXPIRY_SEC },
      ),
    })),
  );

  pendingUploads.delete(uploadId);

  const manifestLines = [
    "=== CHUNK MANIFEST ===",
    `File: ${pending.filename}`,
    `Chunks: ${pending.chunks.length}`,
    `SHA-256: ${pending.fileHash}`,
    comment?.trim() ? `Comment: ${comment.trim()}` : "",
    `Download page: ${downloadPageUrl}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "--- CHUNK LINKS ---",
  ].filter(Boolean);

  for (const c of chunksWithUrls)
    manifestLines.push(
      `Chunk ${c.chunkIndex + 1}/${pending.chunks.length}  |  ${c.sizeBytes} bytes  |  expires: ${c.expiresAt}`,
      c.signedDownloadUrl,
      "",
    );
  manifestLines.push("--- RECONSTRUCTED DOWNLOAD ---", reconstructorUrl, "");

  return NextResponse.json({
    success: true,
    fileId,
    downloadToken,
    downloadPageUrl,
    originalFilename: pending.filename,
    totalChunks: pending.chunks.length,
    fileSizeBytes: pending.fileSizeBytes,
    fileHash: pending.fileHash,
    comment: comment?.trim() || null,
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
