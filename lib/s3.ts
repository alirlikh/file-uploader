/**
 * lib/s3.ts
 * Shared S3 client + helpers used by upload, download, and delete routes.
 */

import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  forcePathStyle: true,
  region: process.env.LIARA_REGION!,
  endpoint: process.env.LIARA_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.LIARA_ACCESS_KEY!,
    secretAccessKey: process.env.LIARA_SECRET_KEY!,
  },
});

export const BUCKET = process.env.LIARA_BUCKET_NAME!;

export async function deleteS3Objects(keys: string[]): Promise<void> {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}
