/**
 * lib/s3.ts
 * Shared S3 client + helpers used by upload, download, and delete routes.
 */

import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  region: "default",
  endpoint: process.env.LIARA_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.LIARA_ACCESS_KEY!,
    secretAccessKey: process.env.LIARA_SECRET_KEY!,
  },
});

export const BUCKET = process.env.LIARA_BUCKET_NAME!;

/**
 * Delete a single S3 object. Silently ignores NoSuchKey.
 */
export async function deleteS3Object(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Batch-delete up to 1000 S3 objects (S3 limit per request).
 * Chunks automatically if keys.length > 1000.
 */
export async function deleteS3Objects(keys: string[]): Promise<void> {
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
