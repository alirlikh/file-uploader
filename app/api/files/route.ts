import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFilesByUser, getFileById, deleteFile } from "@/lib/db";
import { deleteS3Objects, s3, BUCKET } from "@/lib/s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const EXPIRY = 60 * 60 * 24;

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const raw = await getFilesByUser(session.sub);
  const files = await Promise.all(
    raw.map(async (f) => {
      const chunks = await Promise.all(
        f.chunks.map(async (c) => {
          const signedDownloadUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: BUCKET, Key: c.chunk_key }),
            { expiresIn: EXPIRY },
          );
          return {
            chunkIndex: c.chunk_index,
            hash: c.chunk_hash,
            chunkKey: c.chunk_key,
            sizeBytes: Number(c.size_bytes),
            signedDownloadUrl,
            expiresAt: new Date(Date.now() + EXPIRY * 1000).toISOString(),
          };
        }),
      );
      const base =
        process.env.NEXT_PUBLIC_BASE_URL ??
        `https://${req.headers.get("host")}`;
      const reconstructorUrl = `${base}/api/download?keys=${encodeURIComponent(JSON.stringify(chunks.map((c) => c.chunkKey)))}&filename=${encodeURIComponent(f.original_filename)}`;
      return {
        id: f.id,
        originalFilename: f.original_filename,
        fileSizeBytes: Number(f.file_size_bytes),
        fileHash: f.file_hash,
        mimeType: f.mime_type,
        totalChunks: f.total_chunks,
        uploadedAt: f.uploaded_at,
        reconstructorUrl,
        chunks,
      };
    }),
  );
  return NextResponse.json({ files });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const file = await getFileById(id);
  if (!file || file.user_id !== session.sub)
    return NextResponse.json({ error: "File not found." }, { status: 404 });

  const keys = file.chunks.map((c) => c.chunk_key);
  if (!(await deleteFile(id, session.sub)))
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });

  try {
    await deleteS3Objects(keys);
  } catch (err) {
    console.error("[files/delete] S3 cleanup:", err);
  }

  return NextResponse.json({ ok: true });
}
