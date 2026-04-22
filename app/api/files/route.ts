/**
 * GET    /api/files        — list all files for the authenticated user
 * DELETE /api/files?id=XX  — delete one file (DB + all S3 chunks)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFilesByUser, getFileById, deleteFile } from "@/lib/db";
// import { deleteS3Objects } from "@/lib/s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { BUCKET, deleteS3Objects, s3 } from "@/lib/s3";
// import { s3, BUCKET } from "@/lib/s3";

const SIGNED_URL_EXPIRY = 60 * 60 * 24; // 24 h

// ── GET — list files ──────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const rawFiles = getFilesByUser(session.sub);

  // Generate fresh signed URLs for every chunk of every file
  const files = await Promise.all(
    rawFiles.map(async (file) => {
      const chunks = await Promise.all(
        file.chunks.map(async (c) => {
          const signedDownloadUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: c.chunk_key }),
            { expiresIn: SIGNED_URL_EXPIRY },
          );
          const expiresAt = new Date(
            Date.now() + SIGNED_URL_EXPIRY * 1000,
          ).toISOString();
          return {
            chunkIndex: c.chunk_index,
            hash: c.chunk_hash,
            chunkKey: c.chunk_key,
            sizeBytes: c.size_bytes,
            signedDownloadUrl,
            expiresAt,
          };
        }),
      );

      // Build reconstructor URL
      const chunkKeys = chunks.map((c) => c.chunkKey);
      const baseUrl =
        process.env.NEXT_PUBLIC_BASE_URL ??
        `https://${req.headers.get("host")}`;
      const reconstructorUrl = `${baseUrl}/api/download?keys=${encodeURIComponent(
        JSON.stringify(chunkKeys),
      )}&filename=${encodeURIComponent(file.original_filename)}`;

      return {
        id: file.id,
        originalFilename: file.original_filename,
        fileSizeBytes: file.file_size_bytes,
        fileHash: file.file_hash,
        mimeType: file.mime_type,
        totalChunks: file.total_chunks,
        uploadedAt: file.uploaded_at,
        reconstructorUrl,
        chunks,
      };
    }),
  );

  return NextResponse.json({ files });
}

// ── DELETE — remove file + S3 chunks ─────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const fileId = new URL(req.url).searchParams.get("id");
  if (!fileId)
    return NextResponse.json({ error: "Missing file id." }, { status: 400 });

  // Load file to get chunk keys before deleting from DB
  const file = getFileById(fileId);
  if (!file || file.user_id !== session.sub) {
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  }

  const chunkKeys = file.chunks.map((c) => c.chunk_key);

  // Delete from DB first (cascade removes chunks row)
  const deleted = deleteFile(fileId, session.sub);
  if (!deleted)
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });

  // Delete from S3 (best-effort — don't fail the response if S3 errors)
  try {
    await deleteS3Objects(chunkKeys);
  } catch (err) {
    console.error("[files/delete] S3 cleanup failed:", err);
  }

  return NextResponse.json({ ok: true });
}
