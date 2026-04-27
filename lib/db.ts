/**
 * lib/db.ts — SQLite via better-sqlite3. Schema auto-migrates on import.
 *
 * v4 additions:
 *   users.is_blocked         — admin block/unblock
 *   users.is_admin           — admin flag (first signup becomes admin)
 *   users.plan               — "free" | "pro" | "business" | "custom"
 *   users.custom_limit_bytes — per-user override set by admin
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "vaultchunk.db");
const globalDb = global as typeof global & { __db?: Database.Database };
if (!globalDb.__db) {
  globalDb.__db = new Database(DB_PATH);
  globalDb.__db.pragma("journal_mode = WAL");
  globalDb.__db.pragma("foreign_keys = ON");
}
export const db = globalDb.__db;

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    email             TEXT UNIQUE NOT NULL,
    name              TEXT NOT NULL,
    password_hash     TEXT NOT NULL,
    is_blocked        INTEGER NOT NULL DEFAULT 0,
    is_admin          INTEGER NOT NULL DEFAULT 0,
    plan              TEXT NOT NULL DEFAULT 'free',
    custom_limit_bytes INTEGER,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS files (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_filename TEXT NOT NULL,
    file_size_bytes   INTEGER NOT NULL,
    file_hash         TEXT NOT NULL,
    mime_type         TEXT NOT NULL,
    total_chunks      INTEGER NOT NULL,
    uploaded_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT PRIMARY KEY,
    file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_key   TEXT NOT NULL,
    chunk_hash  TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_quota (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    bytes_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
  CREATE INDEX IF NOT EXISTS idx_quota ON daily_quota(user_id, date);
`);

// Idempotent column migrations for existing DBs
const cols = (
  db.prepare("PRAGMA table_info(users)").all() as { name: string }[]
).map((c) => c.name);
if (!cols.includes("is_blocked"))
  db.exec("ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0");
if (!cols.includes("is_admin"))
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
if (!cols.includes("plan"))
  db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
if (!cols.includes("custom_limit_bytes"))
  db.exec("ALTER TABLE users ADD COLUMN custom_limit_bytes INTEGER");

// ── PLANS ─────────────────────────────────────────────────────────────────────

export type Plan = "free" | "pro" | "business" | "custom";

export const PLANS: Record<
  Plan,
  {
    label: string;
    limitBytes: number;
    price: string;
    color: string;
    features: string[];
  }
> = {
  free: {
    label: "Free",
    price: "$0/mo",
    color: "#5a6a7a",
    limitBytes: 1 * 1024 * 1024 * 1024, // 1 GB/day
    features: ["1 GB daily quota", "10 MB chunks", "24 h link expiry"],
  },
  pro: {
    label: "Pro",
    price: "$9/mo",
    color: "#47ffd4",
    limitBytes: 10 * 1024 * 1024 * 1024, // 10 GB/day
    features: ["10 GB daily quota", "Priority support", "48 h link expiry"],
  },
  business: {
    label: "Business",
    price: "$29/mo",
    color: "#e8ff47",
    limitBytes: 50 * 1024 * 1024 * 1024, // 50 GB/day
    features: ["50 GB daily quota", "Dedicated support", "7-day link expiry"],
  },
  custom: {
    label: "Custom",
    price: "Admin",
    color: "#ff8c47",
    limitBytes: 0,
    features: ["Admin-defined quota", "All Business features"],
  },
};

export function getPlanLimit(
  plan: Plan,
  customLimitBytes?: number | null,
): number {
  if (plan === "custom" && customLimitBytes) return customLimitBytes;
  return PLANS[plan].limitBytes;
}

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_blocked: number;
  is_admin: number;
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

// ── USER QUERIES ──────────────────────────────────────────────────────────────

export const getUserByEmail = (email: string) =>
  db.prepare("SELECT * FROM users WHERE email=?").get(email) as
    | DbUser
    | undefined;

export const getUserById = (id: string) =>
  db.prepare("SELECT * FROM users WHERE id=?").get(id) as DbUser | undefined;

/** First signup becomes admin automatically. */
export function createUser(
  id: string,
  email: string,
  name: string,
  hash: string,
): DbUser {
  const count = (
    db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }
  ).c;
  db.prepare(
    "INSERT INTO users (id,email,name,password_hash,is_admin) VALUES (?,?,?,?,?)",
  ).run(id, email, name, hash, count === 0 ? 1 : 0);
  return getUserById(id)!;
}

// ── ADMIN QUERIES ─────────────────────────────────────────────────────────────

export interface AdminUserRow extends DbUser {
  file_count: number;
  total_bytes_stored: number;
  bytes_used_today: number;
}

export function getAllUsersForAdmin(): AdminUserRow[] {
  return db
    .prepare(
      `
    SELECT u.*,
      COUNT(DISTINCT f.id)               AS file_count,
      COALESCE(SUM(f.file_size_bytes),0) AS total_bytes_stored,
      COALESCE(q.bytes_used,0)           AS bytes_used_today
    FROM users u
    LEFT JOIN files f ON f.user_id=u.id
    LEFT JOIN daily_quota q ON q.user_id=u.id AND q.date=date('now')
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `,
    )
    .all() as AdminUserRow[];
}

export const setUserBlocked = (id: string, v: boolean) =>
  db.prepare("UPDATE users SET is_blocked=? WHERE id=?").run(v ? 1 : 0, id);

export function setUserPlan(
  id: string,
  plan: Plan,
  customBytes?: number | null,
) {
  db.prepare("UPDATE users SET plan=?,custom_limit_bytes=? WHERE id=?").run(
    plan,
    customBytes ?? null,
    id,
  );
}

export const setUserAdmin = (id: string, v: boolean) =>
  db.prepare("UPDATE users SET is_admin=? WHERE id=?").run(v ? 1 : 0, id);

export function getGlobalStats() {
  return {
    users: (
      db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }
    ).c,
    files: (
      db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }
    ).c,
    totalBytes: (
      db
        .prepare("SELECT COALESCE(SUM(file_size_bytes),0) as b FROM files")
        .get() as { b: number }
    ).b,
    blocked: (
      db
        .prepare("SELECT COUNT(*) as c FROM users WHERE is_blocked=1")
        .get() as { c: number }
    ).c,
    todayUploads: (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM files WHERE DATE(uploaded_at)=DATE('now')",
        )
        .get() as { c: number }
    ).c,
  };
}

// ── FILE QUERIES ──────────────────────────────────────────────────────────────

export function getFilesByUser(
  userId: string,
): (DbFile & { chunks: DbChunk[] })[] {
  const files = db
    .prepare("SELECT * FROM files WHERE user_id=? ORDER BY uploaded_at DESC")
    .all(userId) as DbFile[];
  return files.map((f) => ({
    ...f,
    chunks: db
      .prepare("SELECT * FROM chunks WHERE file_id=? ORDER BY chunk_index")
      .all(f.id) as DbChunk[],
  }));
}

export function getFileById(
  fileId: string,
): (DbFile & { chunks: DbChunk[] }) | null {
  const f = db.prepare("SELECT * FROM files WHERE id=?").get(fileId) as
    | DbFile
    | undefined;
  if (!f) return null;
  return {
    ...f,
    chunks: db
      .prepare("SELECT * FROM chunks WHERE file_id=? ORDER BY chunk_index")
      .all(f.id) as DbChunk[],
  };
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

export function createFile(input: CreateFileInput): DbFile {
  const iFile = db.prepare(
    "INSERT INTO files (id,user_id,original_filename,file_size_bytes,file_hash,mime_type,total_chunks) VALUES (?,?,?,?,?,?,?)",
  );
  const iChunk = db.prepare(
    "INSERT INTO chunks (id,file_id,chunk_index,chunk_key,chunk_hash,size_bytes) VALUES (?,?,?,?,?,?)",
  );
  db.transaction(() => {
    iFile.run(
      input.id,
      input.userId,
      input.originalFilename,
      input.fileSizeBytes,
      input.fileHash,
      input.mimeType,
      input.chunks.length,
    );
    for (const c of input.chunks)
      iChunk.run(
        c.id,
        input.id,
        c.chunkIndex,
        c.chunkKey,
        c.chunkHash,
        c.sizeBytes,
      );
  })();
  return db.prepare("SELECT * FROM files WHERE id=?").get(input.id) as DbFile;
}

export const deleteFile = (id: string, userId: string) =>
  db.prepare("DELETE FROM files WHERE id=? AND user_id=?").run(id, userId)
    .changes > 0;

export const adminDeleteFile = (id: string) =>
  db.prepare("DELETE FROM files WHERE id=?").run(id).changes > 0;

// ── QUOTA ─────────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

export function getDailyUsed(userId: string): number {
  const r = db
    .prepare("SELECT bytes_used FROM daily_quota WHERE user_id=? AND date=?")
    .get(userId, today()) as { bytes_used: number } | undefined;
  return r?.bytes_used ?? 0;
}

export function getDailyLimitForUser(userId: string): number {
  const u = getUserById(userId);
  return getPlanLimit(u?.plan ?? "free", u?.custom_limit_bytes);
}

export function getDailyLimit() {
  return PLANS.free.limitBytes;
}

export function reserveQuota(
  userId: string,
  bytes: number,
):
  | { allowed: true; limit: number }
  | { allowed: false; used: number; limit: number } {
  const d = today();
  const u = getUserById(userId);
  const limit = getPlanLimit(u?.plan ?? "free", u?.custom_limit_bytes);
  return db.transaction(() => {
    const row = db
      .prepare("SELECT bytes_used FROM daily_quota WHERE user_id=? AND date=?")
      .get(userId, d) as { bytes_used: number } | undefined;
    const used = row?.bytes_used ?? 0;
    if (used + bytes > limit) return { allowed: false as const, used, limit };
    db.prepare(
      "INSERT INTO daily_quota (user_id,date,bytes_used) VALUES (?,?,?) ON CONFLICT (user_id,date) DO UPDATE SET bytes_used=bytes_used+excluded.bytes_used",
    ).run(userId, d, bytes);
    return { allowed: true as const, limit };
  })();
}

export function releaseQuota(userId: string, bytes: number) {
  db.prepare(
    "UPDATE daily_quota SET bytes_used=MAX(0,bytes_used-?) WHERE user_id=? AND date=?",
  ).run(bytes, userId, today());
}
