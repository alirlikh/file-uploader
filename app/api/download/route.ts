import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSession } from "@/lib/auth";
import { s3, BUCKET } from "@/lib/s3";
import { Readable } from "stream";

type ChunkResult =
  | { ok: true; index: number; buffer: Buffer }
  | {
      ok: false;
      index: number;
      reason: "missing" | "expired" | "error";
      detail: string;
    };

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
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "NoSuchKey" || code === "NoSuchKey" || code === "404")
      return {
        ok: false,
        index,
        reason: "missing",
        detail: "Object not found",
      };
    if (
      name === "AccessDenied" ||
      code === "AccessDenied" ||
      name === "RequestExpired" ||
      code === "403"
    )
      return { ok: false, index, reason: "expired", detail: "Link expired" };
    return { ok: false, index, reason: "error", detail: msg };
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  try {
    const { searchParams } = new URL(req.url);
    const keysParam = searchParams.get("keys");
    const filename = searchParams.get("filename") ?? "download";
    if (!keysParam)
      return NextResponse.json({ error: "Missing keys." }, { status: 400 });

    let keys: string[];
    try {
      keys = JSON.parse(decodeURIComponent(keysParam));
    } catch {
      return NextResponse.json({ error: "Invalid keys." }, { status: 400 });
    }

    const results = await Promise.all(keys.map((k, i) => fetchChunk(i, k)));
    const failures = results.filter(
      (r): r is Extract<ChunkResult, { ok: false }> => !r.ok,
    );

    if (failures.length) {
      const missing = failures.filter((f) => f.reason === "missing");
      const expired = failures.filter((f) => f.reason === "expired");
      const errors = failures.filter((f) => f.reason === "error");
      const parts: string[] = [];
      if (missing.length)
        parts.push(
          `Chunk${missing.length > 1 ? "s" : ""} ${missing.map((f) => `#${f.index + 1}`).join(", ")} ${missing.length > 1 ? "are" : "is"} missing from storage.`,
        );
      if (expired.length)
        parts.push(
          `Chunk${expired.length > 1 ? "s" : ""} ${expired.map((f) => `#${f.index + 1}`).join(", ")} link${expired.length > 1 ? "s have" : " has"} expired.`,
        );
      if (errors.length)
        parts.push(
          `Chunk${errors.length > 1 ? "s" : ""} ${errors.map((f) => `#${f.index + 1}`).join(", ")} failed: ${errors[0].detail}`,
        );
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
        { status: missing.length ? 404 : expired.length ? 410 : 502 },
      );
    }

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
    console.error("[download]", err);
    return NextResponse.json({ error: "Download failed." }, { status: 500 });
  }
}
