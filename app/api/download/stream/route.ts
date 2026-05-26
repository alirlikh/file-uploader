/**
 * GET /api/download/stream?token=<downloadToken>
 *
 * Streams the reconstructed file from S3 while emitting real-time progress
 * via Server-Sent Events so the download page can show speed and ETA.
 *
 * Because browsers can't read SSE and receive a binary download simultaneously,
 * we use a two-request pattern:
 *   1. SSE stream:   /api/download/stream?token=X&mode=progress
 *      → emits { type:"progress", loaded, total, speedBps, etaSeconds }
 *         then  { type:"ready",   downloadUrl }  (a presigned one-time URL)
 *   2. File download: browser follows the downloadUrl returned in "ready"
 *
 * Alternatively, with mode=direct the response IS the file (no SSE).
 * The download page uses mode=progress for the progress bar, then redirects.
 */
import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getFileByToken, incrementDownloadCount } from "@/lib/db";
import { s3, BUCKET } from "@/lib/s3";
import { Readable } from "stream";

const SIGNED_EXPIRY = 60 * 15; // 15-min one-time download URL

type ChunkFetch =
  | { ok: true; index: number; buffer: Buffer; sizeBytes: number }
  | {
      ok: false;
      index: number;
      reason: "missing" | "expired" | "error";
      detail: string;
    };

async function fetchChunk(index: number, key: string): Promise<ChunkFetch> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    const stream = res.Body as Readable;
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = [];
      stream.on("data", (d: Buffer) => parts.push(d));
      stream.on("end", () => resolve(Buffer.concat(parts)));
      stream.on("error", reject);
    });
    return { ok: true, index, buffer, sizeBytes: buffer.length };
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    const code = (err as { Code?: string })?.Code ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "NoSuchKey" || code === "NoSuchKey")
      return {
        ok: false,
        index,
        reason: "missing",
        detail: "Not found in storage",
      };
    if (
      name === "AccessDenied" ||
      code === "AccessDenied" ||
      name === "RequestExpired"
    )
      return { ok: false, index, reason: "expired", detail: "Link expired" };
    return { ok: false, index, reason: "error", detail: msg };
  }
}

function fmtSpeed(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}
function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "–";
  if (sec >= 3600)
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec)}s`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  const mode = searchParams.get("mode") ?? "progress"; // "progress" | "direct"

  if (!token)
    return NextResponse.json({ error: "Missing token." }, { status: 400 });

  const file = await getFileByToken(token);
  if (!file)
    return NextResponse.json({ error: "File not found." }, { status: 404 });

  const keys = file.chunks.map((c) => c.chunk_key);
  const totalBytes = Number(file.file_size_bytes);

  // ── mode=direct: serve file directly (no progress) ─────────────────────────
  if (mode === "direct") {
    const results = await Promise.all(keys.map((k, i) => fetchChunk(i, k)));
    const failures = results.filter(
      (r): r is Extract<ChunkFetch, { ok: false }> => !r.ok,
    );
    if (failures.length) {
      const msgs = failures
        .map((f) => `Chunk #${f.index + 1}: ${f.reason}`)
        .join(", ");
      return NextResponse.json({ error: msgs }, { status: 422 });
    }
    const ordered = (results as Extract<ChunkFetch, { ok: true }>[]).sort(
      (a, b) => a.index - b.index,
    );
    const fullFile = Buffer.concat(ordered.map((r) => r.buffer));
    await incrementDownloadCount(file.id);
    return new NextResponse(fullFile, {
      status: 200,
      headers: {
        "Content-Type": file.mime_type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(file.original_filename)}"`,
        "Content-Length": String(fullFile.length),
        "Cache-Control": "no-store",
      },
    });
  }

  // ── mode=progress: SSE stream ──────────────────────────────────────────────
  // Fetch all chunks from S3, emit progress events, then return a signed URL
  // the browser can use to immediately download the assembled file.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      try {
        const buffers: Buffer[] = new Array(keys.length);
        let loaded = 0;
        const startMs = Date.now();

        // Fetch chunks sequentially so progress increments smoothly
        for (let i = 0; i < keys.length; i++) {
          const result = await fetchChunk(i, keys[i]);

          console.log("res ===>", result);

          if (!result.ok) {
            send({
              type: "error",
              chunkIndex: i,
              reason: result.reason,
              detail: result.detail,
              message: `Chunk #${i + 1} is ${result.reason === "missing" ? "missing from storage" : result.reason === "expired" ? "inaccessible (link expired)" : "unavailable: " + result.detail}`,
            });
            controller.close();
            return;
          }

          buffers[i] = result.buffer;
          loaded += result.sizeBytes;

          const elapsedSec = (Date.now() - startMs) / 1000;
          const speedBps = elapsedSec > 0 ? loaded / elapsedSec : 0;
          const remaining = totalBytes - loaded;
          const etaSec = speedBps > 0 ? remaining / speedBps : Infinity;

          send({
            type: "progress",
            chunkIndex: i,
            done: i + 1,
            total: keys.length,
            loaded,
            totalBytes,
            percent: Math.round((loaded / totalBytes) * 100),
            speedBps: Math.round(speedBps),
            speedLabel: fmtSpeed(speedBps),
            etaSeconds: Math.round(etaSec),
            etaLabel: fmtEta(etaSec),
          });
        }

        // All chunks fetched — assemble and store temporarily in S3
        // We upload the reassembled file as a temp object with a 15-min signed URL
        const fullFile = Buffer.concat(buffers);
        const tempKey = `temp-downloads/${file.download_token}-${Date.now()}`;

        const { PutObjectCommand } = await import("@aws-sdk/client-s3");
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: tempKey,
            Body: fullFile,
            ContentType: file.mime_type || "application/octet-stream",
            // Auto-delete after 1 hour via bucket lifecycle rule (recommended)
            // or manually: the presigned URL expires in 15 min anyway
          }),
        );

        const downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: tempKey,
            ResponseContentDisposition: `attachment; filename="${encodeURIComponent(file.original_filename)}"`,
          }),
          { expiresIn: SIGNED_EXPIRY },
        );

        await incrementDownloadCount(file.id);

        send({
          type: "ready",
          downloadUrl,
          filename: file.original_filename,
          totalBytes,
          speedLabel: fmtSpeed(loaded / ((Date.now() - startMs) / 1000)),
        });
      } catch (err) {
        console.error("[download/stream]", err);
        send({
          type: "fatal",
          message: err instanceof Error ? err.message : "Download failed.",
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
