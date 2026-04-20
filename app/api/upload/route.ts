import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import path from "path";
import { SIGNED_URL_EXPIRY } from "@/lib/config";
import { ChunkMeta } from "@/utils/types";
import {
  buildManifest,
  generateChunkHash,
  splitIntoChunks,
  uploadChunk,
} from "@/utils/helpers";

// ─── ROUTE HANDLER ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    console.log("file= ====>", file);

    if (!file) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    // TODO (auth): Extract & verify JWT / session here.
    //   const session = await getServerSession(authOptions);
    //   if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    //   const userId = session.user.id;
    //
    // TODO (auth): Check user's remaining storage quota before upload:
    //   const quota = await getUserQuota(userId);
    //   if (quota.usedBytes + file.size > quota.maxBytes)
    //     return NextResponse.json({ error: "Storage quota exceeded." }, { status: 413 });

    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const fileExt = path.extname(file.name);

    const mimeType = file.type || "application/octet-stream";

    // SHA-256 of the whole original file for integrity verification
    const fileHash = crypto
      .createHash("sha256")
      .update(fileBuffer)
      .digest("hex");

    const rawChunks = splitIntoChunks(fileBuffer);
    const chunkMetas: ChunkMeta[] = [];

    // Upload each chunk in parallel for speed
    await Promise.all(
      rawChunks.map(async (chunk, i) => {
        const hash = generateChunkHash(); // isolated, unrelated hash per chunk
        // TODO (auth): use `uploads/${userId}/${hash}${fileExt}` for user-scoped paths
        const chunkKey = `uploads/${hash}${fileExt}`;

        const expiresAt = new Date(
          Date.now() + SIGNED_URL_EXPIRY * 1000,
        ).toISOString();

        const signedUrl = await uploadChunk(chunk, chunkKey, mimeType);

        chunkMetas[i] = {
          chunkIndex: i,
          chunkKey,
          hash,
          signedDownloadUrl: signedUrl,
          expiresAt,
          sizeBytes: chunk.length,
        };
      }),
    );

    // Build the single reconstructor link (expires same as individual chunks)
    const chunkKeys = chunkMetas.map((c) => c.chunkKey);
    const encodedKeys = encodeURIComponent(JSON.stringify(chunkKeys));
    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ?? `http://${req.headers.get("host")}`;
    const reconstructorUrl = `${baseUrl}/api/download?keys=${encodedKeys}&filename=${encodeURIComponent(file.name)}&expires=${Date.now() + SIGNED_URL_EXPIRY * 1000}`;

    // Build manifest text
    const manifest = buildManifest(
      file.name,
      chunkMetas,
      reconstructorUrl,
      fileHash,
    );

    // TODO (auth): Persist chunk metadata to DB for this user so they can
    //   re-download or manage files later:
    //   await db.file.create({ data: { userId, name: file.name, fileHash, chunks: chunkMetas } });
    //
    // TODO (auth): Update user's used storage quota:
    //   await incrementUserQuota(userId, fileBuffer.length);

    return NextResponse.json({
      success: true,
      originalFilename: file.name,
      totalChunks: chunkMetas.length,
      fileSizeBytes: fileBuffer.length,
      fileHash,
      chunks: chunkMetas.map(
        ({ chunkIndex, hash, signedDownloadUrl, expiresAt, sizeBytes }) => ({
          chunkIndex,
          hash,
          signedDownloadUrl,
          expiresAt,
          sizeBytes,
        }),
      ),
      reconstructorUrl,
      manifest, // raw text — frontend offers it as manifest.txt download
    });
  } catch (err) {
    console.error("[upload] error:", err);
    return NextResponse.json(
      { error: "Upload failed. Check server logs." },
      { status: 500 },
    );
  }
}
