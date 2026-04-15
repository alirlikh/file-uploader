import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "@/lib/s3";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const CHUNK_SIZE = 1024 * 1024 * 2; // 2MB chunks
    const chunks: Buffer[] = [];

    for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
      chunks.push(buffer.subarray(i, i + CHUNK_SIZE));
    }

    const chunkUrls: string[] = [];
    const fileId = Date.now().toString();

    // 1. upload chunks
    for (let i = 0; i < chunks.length; i++) {
      const key = `chunks/${fileId}/chunk-${i}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME!,
          Key: key,
          Body: chunks[i],
          ContentType: "application/octet-stream",

          // optional encryption
          ServerSideEncryption: "AES256",
        }),
      );

      // IMPORTANT: store ONLY S3 object key (not full URL recommended)
      chunkUrls.push(key);
    }

    // 2. create manifest file (your requirement)
    const manifestContent = chunkUrls.join("\n");

    const manifestKey = `manifests/${fileId}-manifest.txt`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME!,
        Key: manifestKey,
        Body: manifestContent,
        ContentType: "text/plain",
        ServerSideEncryption: "AES256",
      }),
    );

    return NextResponse.json({
      message: "Uploaded successfully",
      manifestKey,
      chunkCount: chunks.length,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
