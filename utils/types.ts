export interface ChunkMeta {
  chunkIndex: number;
  chunkKey: string; // S3 object key
  hash: string; // unique hash — no two chunks share or reveal relation
  signedDownloadUrl: string;
  expiresAt: string; // ISO timestamp
  sizeBytes: number;
}

export interface ChunkResult {
  chunkIndex: number;
  hash: string;
  signedDownloadUrl: string;
  expiresAt: string;
  sizeBytes: number;
}

export interface UploadResult {
  success: boolean;
  originalFilename: string;
  totalChunks: number;
  fileSizeBytes: number;
  fileHash: string;
  chunks: ChunkResult[];
  reconstructorUrl: string;
  manifest: string;
}

export type UploadState = "idle" | "uploading" | "done" | "error";
