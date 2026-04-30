export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  plan: string;
  planLabel: string;
  planColor: string;
  dailyUsed: number;
  dailyLimit: number;
  dailyRemaining: number;
}

export interface ChunkResult {
  chunkIndex: number;
  hash: string;
  signedDownloadUrl: string;
  expiresAt: string;
  sizeBytes: number;
}

export interface StoredFile {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  fileHash: string;
  mimeType: string;
  totalChunks: number;
  uploadedAt: string;
  reconstructorUrl: string;
  chunks: (ChunkResult & { chunkKey: string })[];
}

export interface UploadResult {
  success: boolean;
  fileId: string;
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

export interface ChunkLive {
  status: ChunkStatus;
  attempt: number;
}

export type UploadState = "idle" | "uploading" | "done" | "error";
export type Tab = "upload" | "files" | "combiner";
export type CombinerMode = "files" | "urls";

export interface UrlEntry {
  id: string;
  url: string;
  label: string;
  status: "idle" | "fetching" | "done" | "error";
  sizeBytes?: number;
  errorMsg?: string;
}

///admin

export type Plan = "free" | "pro" | "business" | "custom";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  isBlocked: boolean;
  plan: Plan;
  planLabel: string;
  planColor: string;
  customLimitBytes: number | null;
  fileCount: number;
  totalBytesStored: number;
  bytesUsedToday: number;
  createdAt: string;
}

export interface GlobalStats {
  users: number;
  files: number;
  totalBytes: number;
  blocked: number;
  todayUploads: number;
}

//auth

export type Mode = "login" | "signup";

//db

export interface DbUser {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_blocked: boolean;
  is_admin: boolean;
  plan: Plan;
  custom_limit_bytes: number | null;
  created_at: string;
}

export interface DbFile {
  id: string;
  user_id: string;
  original_filename: string;
  file_size_bytes: number;
  file_hash: string;
  mime_type: string;
  total_chunks: number;
  uploaded_at: string;
}

export interface DbChunk {
  id: string;
  file_id: string;
  chunk_index: number;
  chunk_key: string;
  chunk_hash: string;
  size_bytes: number;
}

export interface CreateFileInput {
  id: string;
  userId: string;
  originalFilename: string;
  fileSizeBytes: number;
  fileHash: string;
  mimeType: string;
  chunks: {
    id: string;
    chunkIndex: number;
    chunkKey: string;
    chunkHash: string;
    sizeBytes: number;
  }[];
}

export interface AdminUserRow extends DbUser {
  file_count: number;
  total_bytes_stored: number;
  bytes_used_today: number;
}
