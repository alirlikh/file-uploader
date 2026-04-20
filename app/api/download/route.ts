import { fetchChunk } from "@/utils/helpers";
import { NextRequest, NextResponse } from "next/server";

// ─── ROUTE HANDLER ─────────────────────────────────────────────────────────────
/**
 * GET /api/download?keys=[...]&filename=foo.zip&expires=<ms>
 *
 * Fetches all chunks from S3 in order, concatenates them, and streams the
 * reconstructed file back to the browser.
 *
 * The `expires` query param is a basic expiry check (ms since epoch).
 * For production replace this with a signed JWT to prevent tampering.
 *
 * TODO (auth): Verify the requesting user owns the file before serving:
 *   const session = await getServerSession(authOptions);
 *   const ownership = await db.file.findFirst({ where: { userId: session.user.id, fileHash } });
 *   if (!ownership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const keysParam = searchParams.get("keys");
    const filename = searchParams.get("filename") ?? "download";
    const expiresParam = searchParams.get("expires");

    // ── Expiry check ──────────────────────────────────────────────────────────
    if (expiresParam) {
      const expiresAt = parseInt(expiresParam, 10);
      if (Date.now() > expiresAt) {
        return NextResponse.json(
          { error: "Download link has expired." },
          { status: 410 },
        );
      }
    }

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

    // ── Fetch all chunks in order ─────────────────────────────────────────────
    const chunkBuffers = await Promise.all(keys.map(fetchChunk));
    const fullFile = Buffer.concat(chunkBuffers);

    // ── Stream back to client ─────────────────────────────────────────────────
    return new NextResponse(fullFile, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Content-Length": String(fullFile.length),
        // Prevent caching of sensitive file data
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
