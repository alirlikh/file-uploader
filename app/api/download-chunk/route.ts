import { NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "@/lib/s3";

export async function GET(req: Request) {
  console.log(req);

  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  const data = await s3.send(
    new GetObjectCommand({
      Bucket: process.env.LIARA_BUCKET_NAME!,
      Key: key!,
    }),
  );

  const bytes = await data.Body!.transformToByteArray();
  console.log("data====>", bytes);

  return new NextResponse(bytes);
}
