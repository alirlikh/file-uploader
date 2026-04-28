/**
 * POST /api/upload/presign — Step 1 of browser-direct-to-S3 upload.
 *
 * Auth + quota check server-side, returns presigned S3 PUT URLs per chunk.
 * File body NEVER passes through Next.js.
 */
import { NextRequest, NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto, { randomUUID } from "crypto";
import path from "path";
import { getSession } from "@/lib/auth";
import { getUserById, reserveQuota } from "@/lib/db";
import { s3, BUCKET } from "@/lib/s3";

const CHUNK_SIZE = 10 * 1024 * 1024;
const PUT_URL_EXPIRY_SEC = 60 * 15; // 15 min

export const pendingUploads = new Map<string, PendingUpload>();

export interface PendingUpload {
  uploadId: string;
  userId: string;
  filename: string;
  fileSizeBytes: number;
  mimeType: string;
  fileHash: string;
  chunks: {
    chunkIndex: number;
    chunkKey: string;
    chunkHash: string;
    sizeBytes: number;
  }[];
  createdAt: number;
}

function sweepPending() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, p] of pendingUploads) {
    if (p.createdAt < cutoff) pendingUploads.delete(id);
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  const user = await getUserById(session.sub);
  if (!user)
    return NextResponse.json({ error: "User not found." }, { status: 401 });
  if (user.is_blocked)
    return NextResponse.json(
      { error: "Your account has been suspended." },
      { status: 403 },
    );

  let body: {
    filename: string;
    fileSizeBytes: number;
    mimeType: string;
    fileHash: string;
    totalChunks: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { filename, fileSizeBytes, mimeType, fileHash, totalChunks } = body;
  if (!filename || !fileSizeBytes || !mimeType || !fileHash || !totalChunks)
    return NextResponse.json(
      { error: "Missing required fields." },
      { status: 400 },
    );

  const expectedChunks = Math.max(1, Math.ceil(fileSizeBytes / CHUNK_SIZE));
  if (totalChunks !== expectedChunks)
    return NextResponse.json(
      { error: `totalChunks mismatch: expected ${expectedChunks}.` },
      { status: 400 },
    );

  const quota = await reserveQuota(session.sub, fileSizeBytes);
  if (!quota.allowed) {
    const usedGB = (quota.used / 1024 / 1024 / 1024).toFixed(2);
    const limitGB = (quota.limit / 1024 / 1024 / 1024).toFixed(1);
    return NextResponse.json(
      {
        error: `Daily quota reached (${usedGB} GB / ${limitGB} GB). Resets at midnight UTC.`,
      },
      { status: 429 },
    );
  }

  const fileExt = path.extname(filename);
  const uploadId = randomUUID();
  const chunks: PendingUpload["chunks"] = [];
  const chunkUrls: {
    chunkIndex: number;
    putUrl: string;
    chunkKey: string;
    chunkHash: string;
    sizeBytes: number;
  }[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunkHash = crypto.randomBytes(32).toString("hex");
    const chunkKey = `uploads/${session.sub}/${chunkHash}${fileExt}`;
    const start = i * CHUNK_SIZE;
    const sizeBytes = Math.min(CHUNK_SIZE, fileSizeBytes - start);

    const putUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: chunkKey,
        ContentType: mimeType,
        ContentLength: sizeBytes,
        Metadata: {
          uploadedBy: session.sub,
          uploadId,
          chunkIndex: String(i),
          fileHash,
        },
      }),
      { expiresIn: PUT_URL_EXPIRY_SEC },
    );

    chunks.push({ chunkIndex: i, chunkKey, chunkHash, sizeBytes });
    chunkUrls.push({ chunkIndex: i, putUrl, chunkKey, chunkHash, sizeBytes });
  }

  sweepPending();
  pendingUploads.set(uploadId, {
    uploadId,
    userId: session.sub,
    filename,
    fileSizeBytes,
    mimeType,
    fileHash,
    chunks,
    createdAt: Date.now(),
  });

  return NextResponse.json({ uploadId, chunks: chunkUrls });
}
