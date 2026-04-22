/**
 * GET /api/download?keys=[...]&filename=foo.zip
 *
 * Fetches all S3 chunks in order, classifies each failure precisely
 * (missing vs expired vs error), then either streams the full file
 * or returns a detailed error listing every affected chunk.
 *
 * Expiry is validated by S3's REAL response — NOT a URL query param.
 */

import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSession } from "@/lib/auth";
import { Readable } from "stream";
import { BUCKET, s3 } from "@/lib/s3";

// ── TYPES ─────────────────────────────────────────────────────────────────────
type ChunkResult =
  | { ok: true; index: number; buffer: Buffer }
  | {
      ok: false;
      index: number;
      reason: "missing" | "expired" | "error";
      detail: string;
    };

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function fetchChunk(index: number, key: string): Promise<ChunkResult> {
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
    return { ok: true, index, buffer };
  } catch (err: unknown) {
    const name = (err as { name?: string }).name ?? "";
    const code =
      (err as { Code?: string; $metadata?: { httpStatusCode?: number } })
        .Code ??
      String(
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode ?? "",
      );
    const message = err instanceof Error ? err.message : String(err);

    if (name === "NoSuchKey" || code === "NoSuchKey" || code === "404")
      return {
        ok: false,
        index,
        reason: "missing",
        detail: "Object not found in bucket",
      };

    if (
      name === "AccessDenied" ||
      code === "AccessDenied" ||
      name === "RequestExpired" ||
      code === "RequestExpired" ||
      code === "403"
    )
      return {
        ok: false,
        index,
        reason: "expired",
        detail: "Presigned URL has expired",
      };

    return { ok: false, index, reason: "error", detail: message };
  }
}

// ── ROUTE ─────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  // Auth required — only logged-in users can reconstruct files
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json(
      { error: "You must be logged in to download files." },
      { status: 401 },
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const keysParam = searchParams.get("keys");
    const filename = searchParams.get("filename") ?? "download";
    // `expires` param intentionally ignored — expiry enforced by S3 itself

    if (!keysParam)
      return NextResponse.json(
        { error: "Missing chunk keys." },
        { status: 400 },
      );

    let keys: string[];
    try {
      keys = JSON.parse(decodeURIComponent(keysParam));
    } catch {
      return NextResponse.json(
        { error: "Invalid keys parameter." },
        { status: 400 },
      );
    }

    if (!Array.isArray(keys) || keys.length === 0)
      return NextResponse.json(
        { error: "No chunk keys provided." },
        { status: 400 },
      );

    // ── Probe ALL chunks in parallel ─────────────────────────────────────────
    const results = await Promise.all(keys.map((k, i) => fetchChunk(i, k)));
    const failures = results.filter(
      (r): r is Extract<ChunkResult, { ok: false }> => !r.ok,
    );

    if (failures.length > 0) {
      const missing = failures.filter((f) => f.reason === "missing");
      const expired = failures.filter((f) => f.reason === "expired");
      const errors = failures.filter((f) => f.reason === "error");
      const parts: string[] = [];

      if (missing.length > 0) {
        const nums = missing.map((f) => `#${f.index + 1}`).join(", ");
        parts.push(
          missing.length === 1
            ? `Chunk ${nums} is missing from storage. It may have been deleted.`
            : `Chunks ${nums} are missing from storage. They may have been deleted.`,
        );
      }
      if (expired.length > 0) {
        const nums = expired.map((f) => `#${f.index + 1}`).join(", ");
        parts.push(
          expired.length === 1
            ? `Chunk ${nums} download link has expired. Re-upload or regenerate.`
            : `Chunks ${nums} download links have expired. Re-upload or regenerate.`,
        );
      }
      if (errors.length > 0) {
        const nums = errors.map((f) => `#${f.index + 1}`).join(", ");
        parts.push(
          `Chunk${errors.length > 1 ? "s" : ""} ${nums} failed: ${errors[0].detail}`,
        );
      }

      return NextResponse.json(
        {
          error: parts.join(" "),
          failures: failures.map(({ index, reason, detail }) => ({
            index,
            reason,
            detail,
          })),
          total: keys.length,
        },
        {
          status: failures.some((f) => f.reason === "missing")
            ? 404
            : failures.some((f) => f.reason === "expired")
              ? 410
              : 502,
        },
      );
    }

    // ── Assemble + stream ─────────────────────────────────────────────────────
    const ordered = (results as Extract<ChunkResult, { ok: true }>[]).sort(
      (a, b) => a.index - b.index,
    );
    const fullFile = Buffer.concat(ordered.map((r) => r.buffer));

    return new NextResponse(fullFile, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Content-Length": String(fullFile.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[download] error:", err);
    return NextResponse.json({ error: "Download failed." }, { status: 500 });
  }
}
