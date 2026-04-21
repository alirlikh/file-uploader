import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import path from "path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { ChunkMeta } from "@/utils/types";
import {
  buildManifest,
  generateChunkHash,
  sleep,
  splitIntoChunks,
} from "@/utils/helpers";
import {
  BUCKET,
  MAX_RETRIES,
  RETRY_BASE_MS,
  s3,
  SIGNED_URL_EXPIRY,
} from "@/lib/config";

// ─── ROUTE HANDLER ─────────────────────────────────────────────────────────────
// export async function POST(req: NextRequest) {
//   try {
//     const formData = await req.formData();
//     const file = formData.get("file") as File | null;

//     console.log("file= ====>", file);

//     if (!file) {
//       return NextResponse.json({ error: "No file provided." }, { status: 400 });
//     }

//     // TODO (auth): Extract & verify JWT / session here.
//     //   const session = await getServerSession(authOptions);
//     //   if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
//     //   const userId = session.user.id;
//     //
//     // TODO (auth): Check user's remaining storage quota before upload:
//     //   const quota = await getUserQuota(userId);
//     //   if (quota.usedBytes + file.size > quota.maxBytes)
//     //     return NextResponse.json({ error: "Storage quota exceeded." }, { status: 413 });

//     const arrayBuffer = await file.arrayBuffer();
//     const fileBuffer = Buffer.from(arrayBuffer);
//     const fileExt = path.extname(file.name);

//     const mimeType = file.type || "application/octet-stream";

//     // SHA-256 of the whole original file for integrity verification
//     const fileHash = crypto
//       .createHash("sha256")
//       .update(fileBuffer)
//       .digest("hex");

//     const rawChunks = splitIntoChunks(fileBuffer);
//     const chunkMetas: ChunkMeta[] = [];

//     // Upload each chunk in parallel for speed
//     await Promise.all(
//       rawChunks.map(async (chunk, i) => {
//         const hash = generateChunkHash(); // isolated, unrelated hash per chunk
//         // TODO (auth): use `uploads/${userId}/${hash}${fileExt}` for user-scoped paths
//         const chunkKey = `uploads/${hash}${fileExt}`;

//         const expiresAt = new Date(
//           Date.now() + SIGNED_URL_EXPIRY * 1000,
//         ).toISOString();

//         const signedUrl = await uploadChunk(chunk, chunkKey, mimeType);

//         chunkMetas[i] = {
//           chunkIndex: i,
//           chunkKey,
//           hash,
//           signedDownloadUrl: signedUrl,
//           expiresAt,
//           sizeBytes: chunk.length,
//         };
//       }),
//     );

//     // Build the single reconstructor link (expires same as individual chunks)
//     const chunkKeys = chunkMetas.map((c) => c.chunkKey);
//     const encodedKeys = encodeURIComponent(JSON.stringify(chunkKeys));
//     const baseUrl =
//       process.env.NEXT_PUBLIC_BASE_URL ?? `http://${req.headers.get("host")}`;
//     const reconstructorUrl = `${baseUrl}/api/download?keys=${encodedKeys}&filename=${encodeURIComponent(file.name)}&expires=${Date.now() + SIGNED_URL_EXPIRY * 1000}`;

//     // Build manifest text
//     const manifest = buildManifest(
//       file.name,
//       chunkMetas,
//       reconstructorUrl,
//       fileHash,
//     );

//     // TODO (auth): Persist chunk metadata to DB for this user so they can
//     //   re-download or manage files later:
//     //   await db.file.create({ data: { userId, name: file.name, fileHash, chunks: chunkMetas } });
//     //
//     // TODO (auth): Update user's used storage quota:
//     //   await incrementUserQuota(userId, fileBuffer.length);

//     return NextResponse.json({
//       success: true,
//       originalFilename: file.name,
//       totalChunks: chunkMetas.length,
//       fileSizeBytes: fileBuffer.length,
//       fileHash,
//       chunks: chunkMetas.map(
//         ({ chunkIndex, hash, signedDownloadUrl, expiresAt, sizeBytes }) => ({
//           chunkIndex,
//           hash,
//           signedDownloadUrl,
//           expiresAt,
//           sizeBytes,
//         }),
//       ),
//       reconstructorUrl,
//       manifest, // raw text — frontend offers it as manifest.txt download
//     });
//   } catch (err) {
//     console.error("[upload] error:", err);
//     return NextResponse.json(
//       { error: "Upload failed. Check server logs." },
//       { status: 500 },
//     );
//   }
// }

export async function POST(req: NextRequest) {
  // TODO (auth): Extract & verify JWT / session here:
  //   const session = await getServerSession(authOptions);
  //   if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  //   const userId = session.user.id;
  //
  // TODO (auth): Check storage quota before proceeding:
  //   const quota = await getUserQuota(userId);
  //   if (quota.usedBytes + file.size > quota.maxBytes)
  //     return NextResponse.json({ error: "Storage quota exceeded." }, { status: 413 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }

  // ── Parse file ──────────────────────────────────────────────────────────────
  const arrayBuffer = await file.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);
  const fileExt = path.extname(file.name);
  const mimeType = file.type || "application/octet-stream";
  const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const rawChunks = splitIntoChunks(fileBuffer);
  const total = rawChunks.length;

  // ── Build SSE stream ─────────────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      try {
        const chunkMetas: ChunkMeta[] = new Array(total);
        let done = 0;

        // Upload chunks sequentially so progress increments predictably.
        // Swap to Promise.all() if you prefer speed over progress granularity.
        for (let i = 0; i < total; i++) {
          const hash = generateChunkHash();
          // TODO (auth): prefix key with userId: `uploads/${userId}/${hash}${fileExt}`
          const chunkKey = `uploads/${hash}${fileExt}`;
          const expiresAt = new Date(
            Date.now() + SIGNED_URL_EXPIRY * 1000,
          ).toISOString();

          // Instrument retries — notify client when a retry is happening
          let attempts = 0;
          const uploadWithNotify = async (): Promise<string> => {
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
                  `[upload] chunk ${i} attempt ${attempt + 1} failed:`,
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

          const signedUrl = await uploadWithNotify();
          done++;

          chunkMetas[i] = {
            chunkIndex: i,
            chunkKey,
            hash,
            signedDownloadUrl: signedUrl,
            expiresAt,
            sizeBytes: rawChunks[i].length,
          };

          send({
            type: "progress",
            chunkIndex: i,
            done,
            total,
            percent: Math.round((done / total) * 100),
            attempts, // how many attempts this chunk needed
          });
        }

        // ── Build reconstructor URL ────────────────────────────────────────────
        const chunkKeys = chunkMetas.map((c) => c.chunkKey);
        const encodedKeys = encodeURIComponent(JSON.stringify(chunkKeys));
        const baseUrl =
          process.env.NEXT_PUBLIC_BASE_URL ??
          `https://${req.headers.get("host")}`;
        const reconstructorUrl = `${baseUrl}/api/download?keys=${encodedKeys}&filename=${encodeURIComponent(
          file.name,
        )}&expires=${Date.now() + SIGNED_URL_EXPIRY * 1000}`;

        const manifest = buildManifest(
          file.name,
          chunkMetas,
          reconstructorUrl,
          fileHash,
        );

        // TODO (auth): Persist to DB:
        //   await db.file.create({ data: { userId, name: file.name, fileHash, chunks: chunkMetas } });
        // TODO (auth): Increment user quota:
        //   await incrementUserQuota(userId, fileBuffer.length);

        send({
          type: "done",
          result: {
            success: true,
            originalFilename: file.name,
            totalChunks: total,
            fileSizeBytes: fileBuffer.length,
            fileHash,
            chunks: chunkMetas.map(
              ({
                chunkIndex,
                hash,
                signedDownloadUrl,
                expiresAt,
                sizeBytes,
              }) => ({
                chunkIndex,
                hash,
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
        console.error("[upload] fatal:", err);
        send({
          type: "fatal",
          message: err instanceof Error ? err.message : "Upload failed.",
        });
      } finally {
        controller.close();
      }
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
