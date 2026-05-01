/**
 * lib/db.ts — PostgreSQL via the `pg` connection pool.
 *
 * Public API surface is identical to the SQLite version EXCEPT every
 * function is now async (returns a Promise). Callers must await them.
 *
 * Connection string is read from DATABASE_URL (standard Postgres format):
 *   postgresql://user:password@host:5432/dbname
 *   postgresql://user:password@host:5432/dbname?sslmode=require   ← for cloud DBs
 *
 * Schema is auto-migrated via runMigrations() which is called once at
 * module load time using a top-level await in an IIFE. Next.js handles
 * this correctly because db.ts is only imported in server-side code.
 */

import { Pool, type PoolClient } from "pg";

// ── Connection pool ────────────────────────────────────────────────────────────
// Singleton across hot-reloads in dev
const globalPool = global as typeof global & { __pgPool?: Pool };

if (!globalPool.__pgPool) {
  globalPool.__pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Sane defaults for a web app:
    max: 20, // max connections in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    keepAlive: true,
    // Force SSL in production; skip for local dev
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false } // set to true + provide CA cert for stricter security
        : false,
  });

  globalPool.__pgPool.on("error", (err) => {
    console.error("[pg] Unexpected pool error:", err);
  });
}

export const pool = globalPool.__pgPool;

/** Run a query using a pooled connection. */
export async function query<T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

/** Run multiple statements inside a single serializable transaction. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Schema migrations ──────────────────────────────────────────────────────────
/**
 * Idempotent migrations — safe to run on every startup.
 * Add new migrations to the end of the array; never edit existing ones.
 *
 * Each migration is identified by its index. The migrations table records
 * which have already been applied so each runs exactly once.
 */
const MIGRATIONS: string[] = [
  // 0 — initial schema
  `
  CREATE TABLE IF NOT EXISTS users (
    id                  TEXT        PRIMARY KEY,
    email               TEXT        UNIQUE NOT NULL,
    name                TEXT        NOT NULL,
    password_hash       TEXT        NOT NULL,
    is_blocked          BOOLEAN     NOT NULL DEFAULT FALSE,
    is_admin            BOOLEAN     NOT NULL DEFAULT FALSE,
    plan                TEXT        NOT NULL DEFAULT 'free'
                        CHECK (plan IN ('free','pro','business','custom')),
    custom_limit_bytes  BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS files (
    id                TEXT        PRIMARY KEY,
    user_id           TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_filename TEXT        NOT NULL,
    file_size_bytes   BIGINT      NOT NULL,
    file_hash         TEXT        NOT NULL,
    mime_type         TEXT        NOT NULL,
    total_chunks      INTEGER     NOT NULL,
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT    PRIMARY KEY,
    file_id     TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_key   TEXT    NOT NULL,
    chunk_hash  TEXT    NOT NULL,
    size_bytes  BIGINT  NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_quota (
    user_id    TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       DATE   NOT NULL DEFAULT CURRENT_DATE,
    bytes_used BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_files_user      ON files(user_id);
  CREATE INDEX IF NOT EXISTS idx_files_uploaded  ON files(uploaded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_chunks_file     ON chunks(file_id);
  CREATE INDEX IF NOT EXISTS idx_quota_user_date ON daily_quota(user_id, date);
  `,

  // 1 — crypto payments
  `
  CREATE TABLE IF NOT EXISTS payments (
    id                  TEXT        PRIMARY KEY,   -- our UUID, used as order_id
    user_id             TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan                TEXT        NOT NULL,       -- plan being purchased
    status              TEXT        NOT NULL DEFAULT 'waiting',
    -- NOWPayments fields (populated after creation)
    now_payment_id      TEXT,                       -- NOWPayments internal ID
    pay_address         TEXT,                       -- crypto address to send to
    pay_amount          NUMERIC,                    -- amount in pay_currency
    pay_currency        TEXT,                       -- e.g. "btc"
    price_usd           NUMERIC     NOT NULL,
    -- Expiry — NOWPayments rates expire, after which user must retry
    expires_at          TIMESTAMPTZ,
    -- Lifecycle
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at        TIMESTAMPTZ,
    -- Raw webhook payload for audit trail
    last_webhook_body   JSONB
  );

  CREATE INDEX IF NOT EXISTS idx_payments_user   ON payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_payments_now_id ON payments(now_payment_id);
  `,
];

async function runMigrations(): Promise<void> {
  // Ensure the migrations tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      version    INTEGER NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (let version = 0; version < MIGRATIONS.length; version++) {
    const { rows } = await pool.query(
      "SELECT 1 FROM _migrations WHERE version = $1",
      [version],
    );
    if (rows.length > 0) continue; // already applied

    await withTransaction(async (client) => {
      await client.query(MIGRATIONS[version]);
      await client.query("INSERT INTO _migrations (version) VALUES ($1)", [
        version,
      ]);
    });
    console.log(`[db] Migration ${version} applied`);
  }
}

// Run migrations at module load — Next.js awaits top-level promises in
// server modules before handling requests.
await runMigrations().catch((err) => {
  console.error("[db] Migration failed:", err);
  process.exit(1);
});

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
    limitBytes: 1 * 1024 * 1024 * 1024,
    features: ["1 GB daily quota", "10 MB chunks", "24 h link expiry"],
  },
  pro: {
    label: "Pro",
    price: "$9/mo",
    color: "#47ffd4",
    limitBytes: 10 * 1024 * 1024 * 1024,
    features: ["10 GB daily quota", "Priority support", "48 h link expiry"],
  },
  business: {
    label: "Business",
    price: "$29/mo",
    color: "#e8ff47",
    limitBytes: 50 * 1024 * 1024 * 1024,
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

// ── USER QUERIES ──────────────────────────────────────────────────────────────

export async function getUserByEmail(
  email: string,
): Promise<DbUser | undefined> {
  const rows = await query<DbUser>("SELECT * FROM users WHERE email = $1", [
    email,
  ]);
  return rows[0];
}

export async function getUserById(id: string): Promise<DbUser | undefined> {
  const rows = await query<DbUser>("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0];
}

/** First signup becomes admin automatically (checked inside a transaction). */
export async function createUser(
  id: string,
  email: string,
  name: string,
  hash: string,
): Promise<DbUser> {
  return withTransaction(async (client) => {
    const {
      rows: [{ count }],
    } = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM users",
    );
    const isAdmin = parseInt(count, 10) === 0;

    await client.query(
      `INSERT INTO users (id, email, name, password_hash, is_admin)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, email, name, hash, isAdmin],
    );

    const { rows } = await client.query<DbUser>(
      "SELECT * FROM users WHERE id = $1",
      [id],
    );
    return rows[0];
  });
}

// ── ADMIN QUERIES ─────────────────────────────────────────────────────────────

export interface AdminUserRow extends DbUser {
  file_count: number;
  total_bytes_stored: number;
  bytes_used_today: number;
}

export async function getAllUsersForAdmin(): Promise<AdminUserRow[]> {
  return query<AdminUserRow>(`
    SELECT
      u.*,
      COUNT(DISTINCT f.id)::BIGINT               AS file_count,
      COALESCE(SUM(f.file_size_bytes), 0)::BIGINT AS total_bytes_stored,
      COALESCE(q.bytes_used, 0)::BIGINT           AS bytes_used_today
    FROM users u
    LEFT JOIN files f ON f.user_id = u.id
    LEFT JOIN daily_quota q ON q.user_id = u.id AND q.date = CURRENT_DATE
    GROUP BY u.id, q.bytes_used
    ORDER BY u.created_at DESC
  `);
}

export async function setUserBlocked(
  id: string,
  blocked: boolean,
): Promise<void> {
  await query("UPDATE users SET is_blocked = $1 WHERE id = $2", [blocked, id]);
}

export async function setUserPlan(
  id: string,
  plan: Plan,
  customBytes?: number | null,
): Promise<void> {
  await query(
    "UPDATE users SET plan = $1, custom_limit_bytes = $2 WHERE id = $3",
    [plan, customBytes ?? null, id],
  );
}

export async function setUserAdmin(
  id: string,
  isAdmin: boolean,
): Promise<void> {
  await query("UPDATE users SET is_admin = $1 WHERE id = $2", [isAdmin, id]);
}

export async function getGlobalStats(): Promise<{
  users: number;
  files: number;
  totalBytes: number;
  blocked: number;
  todayUploads: number;
}> {
  const [row] = await query<{
    users: string;
    files: string;
    total_bytes: string;
    blocked: string;
    today_uploads: string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM users)::BIGINT                                         AS users,
      (SELECT COUNT(*) FROM files)::BIGINT                                         AS files,
      (SELECT COALESCE(SUM(file_size_bytes), 0) FROM files)::BIGINT                AS total_bytes,
      (SELECT COUNT(*) FROM users WHERE is_blocked = TRUE)::BIGINT                 AS blocked,
      (SELECT COUNT(*) FROM files WHERE uploaded_at::DATE = CURRENT_DATE)::BIGINT  AS today_uploads
  `);
  return {
    users: parseInt(row.users, 10),
    files: parseInt(row.files, 10),
    totalBytes: parseInt(row.total_bytes, 10),
    blocked: parseInt(row.blocked, 10),
    todayUploads: parseInt(row.today_uploads, 10),
  };
}

// ── FILE QUERIES ──────────────────────────────────────────────────────────────

export async function getFilesByUser(
  userId: string,
): Promise<(DbFile & { chunks: DbChunk[] })[]> {
  const files = await query<DbFile>(
    "SELECT * FROM files WHERE user_id = $1 ORDER BY uploaded_at DESC",
    [userId],
  );
  // Batch-fetch all chunks in one query instead of N+1
  if (files.length === 0) return [];
  const fileIds = files.map((f) => f.id);
  const chunks = await query<DbChunk>(
    `SELECT * FROM chunks WHERE file_id = ANY($1) ORDER BY chunk_index`,
    [fileIds],
  );
  const chunksByFile = new Map<string, DbChunk[]>();
  for (const c of chunks) {
    const arr = chunksByFile.get(c.file_id) ?? [];
    arr.push(c);
    chunksByFile.set(c.file_id, arr);
  }
  return files.map((f) => ({ ...f, chunks: chunksByFile.get(f.id) ?? [] }));
}

export async function getFileById(
  fileId: string,
): Promise<(DbFile & { chunks: DbChunk[] }) | null> {
  const files = await query<DbFile>("SELECT * FROM files WHERE id = $1", [
    fileId,
  ]);
  if (!files[0]) return null;
  const chunks = await query<DbChunk>(
    "SELECT * FROM chunks WHERE file_id = $1 ORDER BY chunk_index",
    [fileId],
  );
  return { ...files[0], chunks };
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

export async function createFile(input: CreateFileInput): Promise<DbFile> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO files (id, user_id, original_filename, file_size_bytes, file_hash, mime_type, total_chunks)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.id,
        input.userId,
        input.originalFilename,
        input.fileSizeBytes,
        input.fileHash,
        input.mimeType,
        input.chunks.length,
      ],
    );

    for (const c of input.chunks) {
      await client.query(
        `INSERT INTO chunks (id, file_id, chunk_index, chunk_key, chunk_hash, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.id, input.id, c.chunkIndex, c.chunkKey, c.chunkHash, c.sizeBytes],
      );
    }

    const { rows } = await client.query<DbFile>(
      "SELECT * FROM files WHERE id = $1",
      [input.id],
    );
    return rows[0];
  });
}

export async function deleteFile(id: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM files WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function adminDeleteFile(id: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM files WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

// ── QUOTA ─────────────────────────────────────────────────────────────────────

export async function getDailyUsed(userId: string): Promise<number> {
  const rows = await query<{ bytes_used: string }>(
    "SELECT bytes_used FROM daily_quota WHERE user_id = $1 AND date = CURRENT_DATE",
    [userId],
  );
  return rows[0] ? parseInt(rows[0].bytes_used, 10) : 0;
}

export async function getDailyLimitForUser(userId: string): Promise<number> {
  const u = await getUserById(userId);
  return getPlanLimit(u?.plan ?? "free", u?.custom_limit_bytes);
}

export function getDailyLimit(): number {
  return PLANS.free.limitBytes;
}

/**
 * Atomically check and reserve quota inside a serializable transaction.
 * Uses INSERT ... ON CONFLICT DO UPDATE so concurrent requests can't
 * both pass the quota check simultaneously.
 */
export async function reserveQuota(
  userId: string,
  bytes: number,
): Promise<
  | { allowed: true; limit: number }
  | { allowed: false; used: number; limit: number }
> {
  return withTransaction(async (client) => {
    // Lock the user row to serialise concurrent uploads from same user
    const {
      rows: [user],
    } = await client.query<DbUser>(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    const limit = getPlanLimit(user?.plan ?? "free", user?.custom_limit_bytes);

    const {
      rows: [quota],
    } = await client.query<{ bytes_used: string }>(
      "SELECT bytes_used FROM daily_quota WHERE user_id = $1 AND date = CURRENT_DATE",
      [userId],
    );
    const used = quota ? parseInt(quota.bytes_used, 10) : 0;

    if (used + bytes > limit) return { allowed: false as const, used, limit };

    await client.query(
      `
      INSERT INTO daily_quota (user_id, date, bytes_used)
      VALUES ($1, CURRENT_DATE, $2)
      ON CONFLICT (user_id, date)
      DO UPDATE SET bytes_used = daily_quota.bytes_used + EXCLUDED.bytes_used
    `,
      [userId, bytes],
    );

    return { allowed: true as const, limit };
  });
}

export async function releaseQuota(
  userId: string,
  bytes: number,
): Promise<void> {
  await query(
    `UPDATE daily_quota
     SET bytes_used = GREATEST(0, bytes_used - $1)
     WHERE user_id = $2 AND date = CURRENT_DATE`,
    [bytes, userId],
  );
}

// ── PAYMENT QUERIES ───────────────────────────────────────────────────────────

export interface DbPayment {
  id: string;
  user_id: string;
  plan: string;
  status: string;
  now_payment_id: string | null;
  pay_address: string | null;
  pay_amount: number | null;
  pay_currency: string | null;
  price_usd: number;
  expires_at: string | null;
  created_at: string;
  confirmed_at: string | null;
  last_webhook_body: object | null;
}

export async function createPaymentRecord(input: {
  id: string;
  userId: string;
  plan: string;
  priceUsd: number;
}): Promise<DbPayment> {
  const rows = await query<DbPayment>(
    `INSERT INTO payments (id, user_id, plan, price_usd)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.id, input.userId, input.plan, input.priceUsd],
  );
  return rows[0];
}

export async function updatePaymentFromGateway(input: {
  id: string;
  nowPaymentId: string;
  payAddress: string;
  payAmount: number;
  payCurrency: string;
  expiresAt?: string;
}): Promise<void> {
  await query(
    `UPDATE payments
     SET now_payment_id = $1,
         pay_address    = $2,
         pay_amount     = $3,
         pay_currency   = $4,
         expires_at     = $5,
         status         = 'waiting'
     WHERE id = $6`,
    [
      input.nowPaymentId,
      input.payAddress,
      input.payAmount,
      input.payCurrency,
      input.expiresAt ?? null,
      input.id,
    ],
  );
}

export async function updatePaymentStatus(
  nowPaymentId: string,
  status: string,
  webhookBody: object,
): Promise<DbPayment | undefined> {
  const rows = await query<DbPayment>(
    `UPDATE payments
     SET status             = $1,
         last_webhook_body  = $2,
         confirmed_at       = CASE WHEN $1 IN ('confirmed','finished') THEN NOW() ELSE confirmed_at END
     WHERE now_payment_id = $3
     RETURNING *`,
    [status, JSON.stringify(webhookBody), nowPaymentId],
  );
  return rows[0];
}

export async function getPaymentById(
  id: string,
): Promise<DbPayment | undefined> {
  const rows = await query<DbPayment>("SELECT * FROM payments WHERE id = $1", [
    id,
  ]);
  return rows[0];
}

export async function getPaymentsByUser(userId: string): Promise<DbPayment[]> {
  return query<DbPayment>(
    "SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC",
    [userId],
  );
}
