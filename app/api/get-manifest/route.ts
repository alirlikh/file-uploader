import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "@/lib/s3";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  const data = await s3.send(
    new GetObjectCommand({
      Bucket: process.env.LIARA_BUCKET_NAME!,
      Key: key,
    }),
  );

  const body = await data.Body!.transformToString();

  return NextResponse.json({
    manifest: body.split("\n"),
  });
}
