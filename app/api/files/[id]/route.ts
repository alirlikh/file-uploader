/**
 * GET   /api/files/[id]?token=<downloadToken>  — public file info (no auth)
 * PATCH /api/files/[id]                        — update comment (owner only)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getFileByToken,
  getFileUploaderName,
  updateFileComment,
  getFileById,
} from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = new URL(req.url).searchParams.get("token");

  // Allow lookup by download token (public) or by file id + auth (owner)
  let file;
  if (token) {
    file = await getFileByToken(token);
  } else {
    const session = await getSession(req);
    if (!session)
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    file = await getFileById(id);
    if (file && file.user_id !== session.sub && !session.isAdmin)
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  if (!file)
    return NextResponse.json({ error: "File not found." }, { status: 404 });

  const uploaderName = await getFileUploaderName(file.id);

  return NextResponse.json({
    file: {
      id: file.id,
      originalFilename: file.original_filename,
      fileSizeBytes: Number(file.file_size_bytes),
      fileHash: file.file_hash,
      mimeType: file.mime_type,
      totalChunks: file.total_chunks,
      comment: file.comment,
      downloadToken: file.download_token,
      downloadCount: file.download_count,
      uploadedAt: file.uploaded_at,
      uploaderName: uploaderName ?? "Unknown",
      // Expose chunk keys so download page can construct the stream URL
      chunkKeys: file.chunks.map((c) => c.chunk_key),
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { id } = await params;
  const { comment } = await req.json().catch(() => ({}));

  const updated = await updateFileComment(
    id,
    session.sub,
    typeof comment === "string" ? comment.trim() || null : null,
  );

  if (!updated)
    return NextResponse.json(
      { error: "File not found or not yours." },
      { status: 404 },
    );
  return NextResponse.json({ ok: true });
}
