import { NextResponse } from "next/server";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "@/lib/s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const CHUNK_SIZE = 1024 * 1024 * 10; // 10MB chunks
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
          Bucket: process.env.LIARA_BUCKET_NAME!,
          Key: key,
          Body: chunks[i],
          ContentType: "application/octet-stream",

          // optional encryption
          // ServerSideEncryption: "AES256",
        }),
      );

      // IMPORTANT: store ONLY S3 object key (not full URL recommended)
      chunkUrls.push(key);
    }

    // 2. create manifest file (your requirement)
    let manifestContentUrl: string[] | string = [];
    const manifestContentKey = chunkUrls.join("\n");

    for (const ch of chunkUrls) {
      const command = new GetObjectCommand({
        Bucket: process.env.LIARA_BUCKET_NAME,
        Key: ch,
      });

      const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
      manifestContentUrl.push(url);
    }

    manifestContentUrl = manifestContentUrl.join("\n");
    const manifestUrlKey = `manifests/${fileId}-manifest.txt`;
    const manifestKey = `manifests/${fileId}-manifest-key.txt`;

    //to save the all chunk urls
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.LIARA_BUCKET_NAME!,
        Key: manifestUrlKey,
        Body: manifestContentUrl,
        ContentType: "text/plain",
      }),
    );

    //to save the chunks key
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.LIARA_BUCKET_NAME!,
        Key: manifestKey,
        Body: manifestContentKey,
        ContentType: "text/plain",
        // ServerSideEncryption: "AES256",
      }),
    );

    const manifesCommand = new GetObjectCommand({
      Bucket: process.env.LIARA_BUCKET_NAME,
      Key: manifestKey,
    });

    const manifesUrl = await getSignedUrl(s3, manifesCommand, {
      expiresIn: 3600,
    });

    return NextResponse.json({
      message: "Uploaded successfully",
      manifesUrl,
      manifestKey,
      chunkCount: chunks.length,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
