export interface ChunkMeta {
  chunkIndex: number;
  chunkKey: string;
  hash: string;
  signedDownloadUrl: string;
  expiresAt: string;
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

export type ChunkStatus =
  | "pending"
  | "uploading"
  | "done"
  | "retrying"
  | "error";

export interface ChunkLiveState {
  status: ChunkStatus;
  attempt: number; // current attempt number (1-based)
  maxAttempts: number; // MAX_RETRIES from server
}

export type UploadState = "idle" | "uploading" | "done" | "error";
export type Tab = "upload" | "combiner";

export type CombinerMode = "files" | "urls";

export interface UrlChunkEntry {
  id: string;
  url: string;
  label: string;
  status: "idle" | "fetching" | "done" | "error";
  sizeBytes?: number;
  errorMsg?: string;
}
