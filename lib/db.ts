/**
 * lib/db.ts
 *
 * Thin SQLite wrapper using better-sqlite3.
 * The DB file lives at ./vaultchunk.db (next to package.json).
 * All schema migrations happen automatically on first import.
 *
 * Why SQLite?  Zero external infra — perfect for self-hosted deployments.
 * Swap to Postgres/MySQL by replacing the driver and adjusting SQL dialects
 * (the column names and logic stay the same).
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "vaultchunk.db");

// ── Singleton connection (reused across hot-reloads in dev) ───────────────────
const globalDb = global as typeof global & { __db?: Database.Database };
if (!globalDb.__db) {
  globalDb.__db = new Database(DB_PATH);
  globalDb.__db.pragma("journal_mode = WAL"); // better concurrent read perf
  globalDb.__db.pragma("foreign_keys = ON");
}
export const db = globalDb.__db;

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,          -- UUID v4
    email       TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    password_hash TEXT NOT NULL,           -- bcrypt hash
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id               TEXT PRIMARY KEY,     -- UUID v4
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_filename TEXT NOT NULL,
    file_size_bytes  INTEGER NOT NULL,
    file_hash        TEXT NOT NULL,        -- SHA-256 of original
    mime_type        TEXT NOT NULL,
    total_chunks     INTEGER NOT NULL,
    uploaded_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT PRIMARY KEY,          -- UUID v4
    file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_key   TEXT NOT NULL,             -- S3 object key
    chunk_hash  TEXT NOT NULL,             -- random isolation hash
    size_bytes  INTEGER NOT NULL
  );

  -- Daily quota tracking — one row per (user, calendar date UTC)
  CREATE TABLE IF NOT EXISTS daily_quota (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,             -- YYYY-MM-DD UTC
    bytes_used  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
  CREATE INDEX IF NOT EXISTS idx_quota_user_date ON daily_quota(user_id, date);
`);

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  email: string;
  name: string;
  password_hash: string;
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

export function getUserByEmail(email: string): DbUser | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | DbUser
    | undefined;
}

export function getUserById(id: string): DbUser | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | DbUser
    | undefined;
}

export function createUser(
  id: string,
  email: string,
  name: string,
  passwordHash: string,
): DbUser {
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
  ).run(id, email, name, passwordHash);
  return getUserById(id)!;
}

// ── FILE QUERIES ──────────────────────────────────────────────────────────────

export function getFilesByUser(
  userId: string,
): (DbFile & { chunks: DbChunk[] })[] {
  const files = db
    .prepare("SELECT * FROM files WHERE user_id = ? ORDER BY uploaded_at DESC")
    .all(userId) as DbFile[];

  return files.map((f) => ({
    ...f,
    chunks: db
      .prepare("SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index")
      .all(f.id) as DbChunk[],
  }));
}

export function getFileById(
  fileId: string,
): (DbFile & { chunks: DbChunk[] }) | null {
  const file = db.prepare("SELECT * FROM files WHERE id = ?").get(fileId) as
    | DbFile
    | undefined;
  if (!file) return null;
  const chunks = db
    .prepare("SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index")
    .all(fileId) as DbChunk[];
  return { ...file, chunks };
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
  const insertFile = db.prepare(`
    INSERT INTO files (id, user_id, original_filename, file_size_bytes, file_hash, mime_type, total_chunks)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (id, file_id, chunk_index, chunk_key, chunk_hash, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    insertFile.run(
      input.id,
      input.userId,
      input.originalFilename,
      input.fileSizeBytes,
      input.fileHash,
      input.mimeType,
      input.chunks.length,
    );
    for (const c of input.chunks) {
      insertChunk.run(
        c.id,
        input.id,
        c.chunkIndex,
        c.chunkKey,
        c.chunkHash,
        c.sizeBytes,
      );
    }
  });
  tx();

  return db.prepare("SELECT * FROM files WHERE id = ?").get(input.id) as DbFile;
}

export function deleteFile(fileId: string, userId: string): boolean {
  // Foreign-key cascade will delete chunks automatically
  const result = db
    .prepare("DELETE FROM files WHERE id = ? AND user_id = ?")
    .run(fileId, userId);
  return result.changes > 0;
}

// ── QUOTA QUERIES ─────────────────────────────────────────────────────────────

const DAILY_LIMIT_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB per user per day

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function getDailyUsed(userId: string): number {
  const row = db
    .prepare(
      "SELECT bytes_used FROM daily_quota WHERE user_id = ? AND date = ?",
    )
    .get(userId, todayUtc()) as { bytes_used: number } | undefined;
  return row?.bytes_used ?? 0;
}

export function getDailyLimit(): number {
  return DAILY_LIMIT_BYTES;
}

/**
 * Atomically check + reserve quota for an upload.
 * Returns { allowed: true } or { allowed: false, used, limit }.
 */
export function reserveQuota(
  userId: string,
  bytes: number,
): { allowed: true } | { allowed: false; used: number; limit: number } {
  const date = todayUtc();
  const limit = DAILY_LIMIT_BYTES;

  const reserve = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT bytes_used FROM daily_quota WHERE user_id = ? AND date = ?",
      )
      .get(userId, date) as { bytes_used: number } | undefined;

    const used = row?.bytes_used ?? 0;
    if (used + bytes > limit) return { allowed: false as const, used, limit };

    db.prepare(
      `
      INSERT INTO daily_quota (user_id, date, bytes_used)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id, date) DO UPDATE SET bytes_used = bytes_used + excluded.bytes_used
    `,
    ).run(userId, date, bytes);

    return { allowed: true as const };
  });

  return reserve();
}

/**
 * Release quota reservation (called when upload fails after reservation).
 */
export function releaseQuota(userId: string, bytes: number): void {
  const date = todayUtc();
  db.prepare(
    `
    UPDATE daily_quota SET bytes_used = MAX(0, bytes_used - ?)
    WHERE user_id = ? AND date = ?
  `,
  ).run(bytes, userId, date);
}
