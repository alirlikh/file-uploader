import { fetchChunk } from "@/utils/helpers";

import { NextRequest, NextResponse } from "next/server";

// ─── ROUTE HANDLER ─────────────────────────────────────────────────────────────
/**
 * GET /api/download?keys=[...]&filename=foo.zip
 *
 * NOTE: The `?expires=` query param is intentionally IGNORED for security.
 *       Expiry is enforced by S3 itself via the presigned URL TTL — the client
 *       cannot forge the expiration time by manipulating this URL.
 *
 * Probes ALL chunks in parallel first, then reports every missing/expired chunk
 * before giving up — so the user sees the full picture in one request, not one
 * failure at a time.
 *
 * TODO (auth): Verify the requesting user owns these chunks before serving:
 *   const session = await getServerSession(authOptions);
 *   const record  = await db.file.findFirst({ where: { userId: session.user.id, fileHash } });
 *   if (!record) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 */

type ChunkResult =
  | { ok: true; index: number; buffer: Buffer }
  | {
      ok: false;
      index: number;
      reason: "missing" | "expired" | "error";
      detail: string;
    };

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const keysParam = searchParams.get("keys");
    const filename = searchParams.get("filename") ?? "download";
    // `expires` param is deliberately NOT read — expiry is validated by S3 itself.

    if (!keysParam) {
      return NextResponse.json(
        { error: "Missing chunk keys." },
        { status: 400 },
      );
    }

    let keys: string[];
    try {
      keys = JSON.parse(decodeURIComponent(keysParam));
    } catch {
      return NextResponse.json(
        { error: "Invalid keys parameter." },
        { status: 400 },
      );
    }

    if (!Array.isArray(keys) || keys.length === 0) {
      return NextResponse.json(
        { error: "No chunk keys provided." },
        { status: 400 },
      );
    }

    // ── Probe ALL chunks in parallel ─────────────────────────────────────────
    const results = await Promise.all(keys.map((key, i) => fetchChunk(i, key)));

    const failures = results.filter(
      (r): r is Extract<ChunkResult, { ok: false }> => !r.ok,
    );

    if (failures.length > 0) {
      // Separate by reason so the error message is precise
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
            ? `Chunk ${nums} download link has expired. Re-upload or regenerate the link.`
            : `Chunks ${nums} download links have expired. Re-upload or regenerate the links.`,
        );
      }

      if (errors.length > 0) {
        const nums = errors.map((f) => `#${f.index + 1}`).join(", ");
        parts.push(
          `Chunk${errors.length > 1 ? "s" : ""} ${nums} failed to fetch: ${errors[0].detail}`,
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

    // ── All chunks OK — assemble and stream ───────────────────────────────────
    const ordered = results as Extract<ChunkResult, { ok: true }>[];
    ordered.sort((a, b) => a.index - b.index); // ensure correct order
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
    return NextResponse.json(
      { error: "Download failed. Check server logs." },
      { status: 500 },
    );
  }
}
