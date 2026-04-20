import { S3Client } from "@aws-sdk/client-s3";

export const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB in bytes
export const SIGNED_URL_EXPIRY = 60 * 60 * 24; // 24 hours in seconds (each link expiration)

export const s3 = new S3Client({
  region: "default",
  endpoint: process.env.LIARA_ENDPOINT,
  credentials: {
    accessKeyId: process.env.LIARA_ACCESS_KEY!,
    secretAccessKey: process.env.LIARA_SECRET_KEY!,
  },
});

export const BUCKET = process.env.LIARA_BUCKET_NAME!;
