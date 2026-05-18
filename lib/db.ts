/**
 * lib/db.ts — PostgreSQL via pg pool.
 * All schema migrations are versioned and idempotent.
 *
 * Migration log:
 *   0 — initial schema (users, files, chunks, daily_quota)
 *   1 — crypto payments
 *   2 — email OTP verification (pending_signups, add is_verified to users)
 *   3 — plan prices table (admin-editable), discount codes
 *   4 — payment OTP + cancel support
 */

import { Pool, type PoolClient } from "pg";

const globalPool = global as typeof global & { __pgPool?: Pool };
if (!globalPool.__pgPool) {
  globalPool.__pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });
  globalPool.__pgPool.on("connect", (client) => {
    client.query("SET statement_timeout = '300s'").catch(() => {});
  });
  globalPool.__pgPool.on("error", (err) => {
    console.error("[pg] pool error:", err);
  });
}
export const pool = globalPool.__pgPool;

export async function query<T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

function isConnectionAlive(client: PoolClient): boolean {
  try {
    const stream = (
      client as unknown as { connection: { stream: { destroyed: boolean } } }
    ).connection?.stream;
    return !stream?.destroyed;
  } catch {
    return false;
  }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    if (began && isConnectionAlive(client)) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* already dead */
      }
    }
    throw err;
  } finally {
    client.release(!began || !isConnectionAlive(client));
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 200,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof Error &&
        (err.message.includes("terminated") ||
          err.message.includes("not queryable") ||
          err.message.includes("ECONNRESET") ||
          err.message.includes("timeout"));
      if (!retryable || i === maxAttempts - 1) throw err;
      await new Promise<void>((r) =>
        setTimeout(r, baseDelayMs * Math.pow(2, i)),
      );
    }
  }
  throw lastErr;
}

// ── MIGRATIONS ────────────────────────────────────────────────────────────────
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
    is_verified         BOOLEAN     NOT NULL DEFAULT FALSE,
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
    id                  TEXT        PRIMARY KEY,
    user_id             TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan                TEXT        NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'waiting',
    now_payment_id      TEXT,
    pay_address         TEXT,
    pay_amount          NUMERIC,
    pay_currency        TEXT,
    price_usd           NUMERIC     NOT NULL,
    discount_code       TEXT,
    discount_pct        INTEGER     DEFAULT 0,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at        TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    last_webhook_body   JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_payments_user   ON payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_payments_now_id ON payments(now_payment_id);
  `,

  // 2 — email OTP verification
  `
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE TABLE IF NOT EXISTS pending_signups (
    id             TEXT        PRIMARY KEY,
    email          TEXT        NOT NULL UNIQUE,
    name           TEXT        NOT NULL,
    password_hash  TEXT        NOT NULL,
    otp_hash       TEXT        NOT NULL,
    attempts       INTEGER     NOT NULL DEFAULT 0,
    expires_at     TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_pending_email   ON pending_signups(email);
  CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_signups(expires_at);
  `,

  // 3 — plan prices (admin-editable) + discount codes
  `
  CREATE TABLE IF NOT EXISTS plan_prices (
    plan       TEXT    PRIMARY KEY,
    price_usd  NUMERIC NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT    REFERENCES users(id) ON DELETE SET NULL
  );
  -- Seed default prices
  INSERT INTO plan_prices (plan, price_usd) VALUES
    ('pro',      9),
    ('business', 29)
  ON CONFLICT (plan) DO NOTHING;

  CREATE TABLE IF NOT EXISTS discount_codes (
    id            TEXT        PRIMARY KEY,
    code          TEXT        NOT NULL UNIQUE,
    description   TEXT,
    discount_pct  INTEGER     NOT NULL CHECK (discount_pct BETWEEN 1 AND 100),
    max_uses      INTEGER,                     -- NULL = unlimited
    uses_count    INTEGER     NOT NULL DEFAULT 0,
    valid_from    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until   TIMESTAMPTZ,                 -- NULL = never expires
    applies_to    TEXT[],                      -- NULL = all plans
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by    TEXT        REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_code ON discount_codes(UPPER(code));
  CREATE INDEX IF NOT EXISTS idx_discount_active ON discount_codes(is_active, valid_until);
  `,

  // 4 — payment OTP verification step
  `
  CREATE TABLE IF NOT EXISTS payment_otps (
    id          TEXT        PRIMARY KEY,
    payment_id  TEXT        NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    otp_hash    TEXT        NOT NULL,
    attempts    INTEGER     NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_otp_payment ON payment_otps(payment_id);
  `,
];

async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      version    INTEGER NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (let v = 0; v < MIGRATIONS.length; v++) {
    const { rows } = await pool.query(
      "SELECT 1 FROM _migrations WHERE version=$1",
      [v],
    );
    if (rows.length > 0) continue;
    await withTransaction(async (client) => {
      await client.query(MIGRATIONS[v]);
      await client.query("INSERT INTO _migrations (version) VALUES ($1)", [v]);
    });
    console.log(`[db] Migration ${v} applied`);
  }
}

await runMigrations().catch((err) => {
  console.error("[db] Migration failed:", err);
  process.exit(1);
});

// ── PLAN TYPES ────────────────────────────────────────────────────────────────
export type Plan = "free" | "pro" | "business" | "custom";

export const PLAN_DEFAULTS: Record<
  Plan,
  {
    label: string;
    color: string;
    features: string[];
    limitBytes: number;
  }
> = {
  free: {
    label: "Free",
    color: "#5a6a7a",
    limitBytes: 1 * 1024 * 1024 * 1024,
    features: ["1 GB daily quota", "10 MB chunks", "24 h link expiry"],
  },
  pro: {
    label: "Pro",
    color: "#47ffd4",
    limitBytes: 10 * 1024 * 1024 * 1024,
    features: ["10 GB daily quota", "Priority support", "48 h link expiry"],
  },
  business: {
    label: "Business",
    color: "#e8ff47",
    limitBytes: 50 * 1024 * 1024 * 1024,
    features: ["50 GB daily quota", "Dedicated support", "7-day link expiry"],
  },
  custom: {
    label: "Custom",
    color: "#ff8c47",
    limitBytes: 0,
    features: ["Admin-defined quota", "All Business features"],
  },
};

// Runtime plan prices — loaded from DB, fallback to defaults
let _planPricesCache: Record<string, number> | null = null;
let _planPricesCacheAt = 0;

export async function getPlanPrices(): Promise<Record<string, number>> {
  if (_planPricesCache && Date.now() - _planPricesCacheAt < 60_000)
    return _planPricesCache;
  const rows = await query<{ plan: string; price_usd: string }>(
    "SELECT plan, price_usd FROM plan_prices",
  );
  _planPricesCache = Object.fromEntries(
    rows.map((r) => [r.plan, parseFloat(r.price_usd)]),
  );
  _planPricesCacheAt = Date.now();
  return _planPricesCache;
}

export async function updatePlanPrice(
  plan: string,
  priceUsd: number,
  updatedBy: string,
): Promise<void> {
  await query(
    `INSERT INTO plan_prices (plan, price_usd, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (plan) DO UPDATE
     SET price_usd=$2, updated_by=$3, updated_at=NOW()`,
    [plan, priceUsd, updatedBy],
  );
  _planPricesCache = null; // bust cache
}

export function getPlanLimit(
  plan: Plan,
  customLimitBytes?: number | null,
): number {
  if (plan === "custom" && customLimitBytes) return customLimitBytes;
  return PLAN_DEFAULTS[plan]?.limitBytes ?? 0;
}

// ── TYPES ─────────────────────────────────────────────────────────────────────
export interface DbUser {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_blocked: boolean;
  is_admin: boolean;
  is_verified: boolean;
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
  query<DbUser>("SELECT * FROM users WHERE email=$1", [email]).then(
    (r) => r[0],
  );

export const getUserById = (id: string) =>
  query<DbUser>("SELECT * FROM users WHERE id=$1", [id]).then((r) => r[0]);

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
    // First user is admin and auto-verified
    await client.query(
      `INSERT INTO users (id, email, name, password_hash, is_admin, is_verified)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, email, name, hash, isAdmin],
    );
    const { rows } = await client.query<DbUser>(
      "SELECT * FROM users WHERE id=$1",
      [id],
    );
    return rows[0];
  });
}

export const verifyUserEmail = (userId: string) =>
  query("UPDATE users SET is_verified=TRUE WHERE id=$1", [userId]);

// ── ADMIN USER QUERIES ────────────────────────────────────────────────────────
export interface AdminUserRow extends DbUser {
  file_count: number;
  total_bytes_stored: number;
  bytes_used_today: number;
}

export async function getAllUsersForAdmin(): Promise<AdminUserRow[]> {
  return query<AdminUserRow>(`
    SELECT u.*,
      COUNT(DISTINCT f.id)::BIGINT               AS file_count,
      COALESCE(SUM(f.file_size_bytes),0)::BIGINT  AS total_bytes_stored,
      COALESCE(q.bytes_used,0)::BIGINT            AS bytes_used_today
    FROM users u
    LEFT JOIN files f ON f.user_id=u.id
    LEFT JOIN daily_quota q ON q.user_id=u.id AND q.date=CURRENT_DATE
    GROUP BY u.id, q.bytes_used
    ORDER BY u.created_at DESC
  `);
}

export const setUserBlocked = (id: string, v: boolean) =>
  query("UPDATE users SET is_blocked=$1 WHERE id=$2", [v, id]);
export const setUserAdmin = (id: string, v: boolean) =>
  query("UPDATE users SET is_admin=$1 WHERE id=$2", [v, id]);
export async function setUserPlan(
  id: string,
  plan: Plan,
  customBytes?: number | null,
): Promise<void> {
  await query("UPDATE users SET plan=$1, custom_limit_bytes=$2 WHERE id=$3", [
    plan,
    customBytes ?? null,
    id,
  ]);
}

export async function getGlobalStats() {
  const [row] = await query<{
    users: string;
    files: string;
    total_bytes: string;
    blocked: string;
    today_uploads: string;
    total_payments: string;
    pending_payments: string;
    total_revenue: string;
  }>(`SELECT
    (SELECT COUNT(*) FROM users)::BIGINT                                        AS users,
    (SELECT COUNT(*) FROM files)::BIGINT                                        AS files,
    (SELECT COALESCE(SUM(file_size_bytes),0) FROM files)::BIGINT                AS total_bytes,
    (SELECT COUNT(*) FROM users WHERE is_blocked=TRUE)::BIGINT                  AS blocked,
    (SELECT COUNT(*) FROM files WHERE uploaded_at::DATE=CURRENT_DATE)::BIGINT   AS today_uploads,
    (SELECT COUNT(*) FROM payments)::BIGINT                                     AS total_payments,
    (SELECT COUNT(*) FROM payments WHERE status='waiting')::BIGINT              AS pending_payments,
    (SELECT COALESCE(SUM(price_usd*(1-COALESCE(discount_pct,0)/100.0)),0)
     FROM payments WHERE status IN ('confirmed','finished'))::NUMERIC           AS total_revenue
  `);
  return {
    users: parseInt(row.users, 10),
    files: parseInt(row.files, 10),
    totalBytes: parseInt(row.total_bytes, 10),
    blocked: parseInt(row.blocked, 10),
    todayUploads: parseInt(row.today_uploads, 10),
    totalPayments: parseInt(row.total_payments, 10),
    pendingPayments: parseInt(row.pending_payments, 10),
    totalRevenue: parseFloat(row.total_revenue),
  };
}

// ── FILE QUERIES ──────────────────────────────────────────────────────────────
export async function getFilesByUser(
  userId: string,
): Promise<(DbFile & { chunks: DbChunk[] })[]> {
  const files = await query<DbFile>(
    "SELECT * FROM files WHERE user_id=$1 ORDER BY uploaded_at DESC",
    [userId],
  );
  if (!files.length) return [];
  const fileIds = files.map((f) => f.id);
  const chunks = await query<DbChunk & { file_id: string }>(
    "SELECT * FROM chunks WHERE file_id=ANY($1) ORDER BY chunk_index",
    [fileIds],
  );
  const byFile = new Map<string, DbChunk[]>();
  for (const c of chunks) {
    const arr = byFile.get(c.file_id) ?? [];
    arr.push(c);
    byFile.set(c.file_id, arr);
  }
  return files.map((f) => ({ ...f, chunks: byFile.get(f.id) ?? [] }));
}

export async function getFileById(
  fileId: string,
): Promise<(DbFile & { chunks: DbChunk[] }) | null> {
  const [file] = await query<DbFile>("SELECT * FROM files WHERE id=$1", [
    fileId,
  ]);
  if (!file) return null;
  const chunks = await query<DbChunk>(
    "SELECT * FROM chunks WHERE file_id=$1 ORDER BY chunk_index",
    [fileId],
  );
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

export async function createFile(input: CreateFileInput): Promise<DbFile> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO files (id,user_id,original_filename,file_size_bytes,file_hash,mime_type,total_chunks)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
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
    if (input.chunks.length > 0) {
      const vals = input.chunks
        .map((_, i) => {
          const b = i * 6;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
        })
        .join(",");
      const params: unknown[] = [];
      for (const c of input.chunks)
        params.push(
          c.id,
          input.id,
          c.chunkIndex,
          c.chunkKey,
          c.chunkHash,
          c.sizeBytes,
        );
      await client.query(
        `INSERT INTO chunks (id,file_id,chunk_index,chunk_key,chunk_hash,size_bytes) VALUES ${vals}`,
        params,
      );
    }
    const { rows } = await client.query<DbFile>(
      "SELECT * FROM files WHERE id=$1",
      [input.id],
    );
    return rows[0];
  });
}

export const deleteFile = async (id: string, userId: string) =>
  (
    await pool.query("DELETE FROM files WHERE id=$1 AND user_id=$2", [
      id,
      userId,
    ])
  ).rowCount! > 0;

// ── QUOTA ─────────────────────────────────────────────────────────────────────
export const getDailyUsed = async (userId: string) => {
  const [r] = await query<{ bytes_used: string }>(
    "SELECT bytes_used FROM daily_quota WHERE user_id=$1 AND date=CURRENT_DATE",
    [userId],
  );
  return r ? parseInt(r.bytes_used, 10) : 0;
};

export async function getDailyLimitForUser(userId: string): Promise<number> {
  const u = await getUserById(userId);
  return getPlanLimit(u?.plan ?? "free", u?.custom_limit_bytes);
}

export function getDailyLimit() {
  return PLAN_DEFAULTS.free.limitBytes;
}

export async function reserveQuota(
  userId: string,
  bytes: number,
): Promise<
  | { allowed: true; limit: number }
  | { allowed: false; used: number; limit: number }
> {
  return withTransaction(async (client) => {
    const {
      rows: [user],
    } = await client.query<DbUser>(
      "SELECT * FROM users WHERE id=$1 FOR UPDATE",
      [userId],
    );
    const limit = getPlanLimit(user?.plan ?? "free", user?.custom_limit_bytes);
    const {
      rows: [q],
    } = await client.query<{ bytes_used: string }>(
      "SELECT bytes_used FROM daily_quota WHERE user_id=$1 AND date=CURRENT_DATE",
      [userId],
    );
    const used = q ? parseInt(q.bytes_used, 10) : 0;
    if (used + bytes > limit) return { allowed: false as const, used, limit };
    await client.query(
      `
      INSERT INTO daily_quota (user_id,date,bytes_used) VALUES ($1,CURRENT_DATE,$2)
      ON CONFLICT (user_id,date) DO UPDATE SET bytes_used=daily_quota.bytes_used+EXCLUDED.bytes_used
    `,
      [userId, bytes],
    );
    return { allowed: true as const, limit };
  });
}

export const releaseQuota = async (userId: string, bytes: number) =>
  query(
    "UPDATE daily_quota SET bytes_used=GREATEST(0,bytes_used-$1) WHERE user_id=$2 AND date=CURRENT_DATE",
    [bytes, userId],
  );

// ── PENDING SIGNUP / EMAIL OTP ─────────────────────────────────────────────────
export interface DbPendingSignup {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  otp_hash: string;
  attempts: number;
  expires_at: string;
  created_at: string;
}

export const getPendingSignupByEmail = (email: string) =>
  query<DbPendingSignup>("SELECT * FROM pending_signups WHERE email=$1", [
    email,
  ]).then((r) => r[0]);

export const getPendingSignupById = (id: string) =>
  query<DbPendingSignup>("SELECT * FROM pending_signups WHERE id=$1", [
    id,
  ]).then((r) => r[0]);

export const upsertPendingSignup = (input: {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  otpHash: string;
  expiresAt: Date;
}) =>
  query(
    `
  INSERT INTO pending_signups (id,email,name,password_hash,otp_hash,expires_at)
  VALUES ($1,$2,$3,$4,$5,$6)
  ON CONFLICT (email) DO UPDATE
  SET id=$1,name=$3,password_hash=$4,otp_hash=$5,attempts=0,expires_at=$6,created_at=NOW()
`,
    [
      input.id,
      input.email,
      input.name,
      input.passwordHash,
      input.otpHash,
      input.expiresAt,
    ],
  );

export const incrementPendingAttempts = async (id: string) => {
  const [r] = await query<{ attempts: number }>(
    "UPDATE pending_signups SET attempts=attempts+1 WHERE id=$1 RETURNING attempts",
    [id],
  );
  return r?.attempts ?? 0;
};

export const deletePendingSignup = (id: string) =>
  query("DELETE FROM pending_signups WHERE id=$1", [id]);

export const pruneExpiredPending = () =>
  query("DELETE FROM pending_signups WHERE expires_at<NOW()", []);

// ── DISCOUNT CODES ─────────────────────────────────────────────────────────────
export interface DbDiscountCode {
  id: string;
  code: string;
  description: string | null;
  discount_pct: number;
  max_uses: number | null;
  uses_count: number;
  valid_from: string;
  valid_until: string | null;
  applies_to: string[] | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
}

export const getAllDiscountCodes = () =>
  query<DbDiscountCode>(
    "SELECT * FROM discount_codes ORDER BY created_at DESC",
  );

export const getDiscountCode = async (
  code: string,
): Promise<DbDiscountCode | undefined> => {
  const [row] = await query<DbDiscountCode>(
    "SELECT * FROM discount_codes WHERE UPPER(code)=UPPER($1)",
    [code],
  );
  return row;
};

export const createDiscountCode = (input: {
  id: string;
  code: string;
  description: string | null;
  discountPct: number;
  maxUses: number | null;
  validFrom: Date;
  validUntil: Date | null;
  appliesTo: string[] | null;
  createdBy: string;
}) =>
  query(
    `
  INSERT INTO discount_codes
    (id,code,description,discount_pct,max_uses,valid_from,valid_until,applies_to,created_by)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
`,
    [
      input.id,
      input.code.toUpperCase(),
      input.description,
      input.discountPct,
      input.maxUses,
      input.validFrom,
      input.validUntil,
      input.appliesTo,
      input.createdBy,
    ],
  );

export const updateDiscountCode = (
  id: string,
  patch: Partial<{
    isActive: boolean;
    maxUses: number | null;
    validUntil: Date | null;
    description: string;
  }>,
) => {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.isActive !== undefined) {
    sets.push(`is_active=$${i++}`);
    vals.push(patch.isActive);
  }
  if (patch.maxUses !== undefined) {
    sets.push(`max_uses=$${i++}`);
    vals.push(patch.maxUses);
  }
  if (patch.validUntil !== undefined) {
    sets.push(`valid_until=$${i++}`);
    vals.push(patch.validUntil);
  }
  if (patch.description !== undefined) {
    sets.push(`description=$${i++}`);
    vals.push(patch.description);
  }
  if (!sets.length) return Promise.resolve();
  vals.push(id);
  return query(
    `UPDATE discount_codes SET ${sets.join(",")} WHERE id=$${i}`,
    vals,
  );
};

export const deleteDiscountCode = (id: string) =>
  query("DELETE FROM discount_codes WHERE id=$1", [id]);

/** Validate a discount code for a given plan. Returns the code row or an error string. */
export async function validateDiscountCode(
  code: string,
  plan: string,
): Promise<
  { valid: true; row: DbDiscountCode } | { valid: false; error: string }
> {
  const row = await getDiscountCode(code);
  if (!row) return { valid: false, error: "Discount code not found." };
  if (!row.is_active)
    return { valid: false, error: "This discount code is inactive." };
  if (row.valid_until && new Date(row.valid_until) < new Date())
    return { valid: false, error: "This discount code has expired." };
  if (new Date(row.valid_from) > new Date())
    return { valid: false, error: "This discount code is not yet valid." };
  if (row.max_uses !== null && row.uses_count >= row.max_uses)
    return {
      valid: false,
      error: "This discount code has reached its usage limit.",
    };
  if (
    row.applies_to &&
    row.applies_to.length > 0 &&
    !row.applies_to.includes(plan)
  )
    return {
      valid: false,
      error: `This code only applies to: ${row.applies_to.join(", ")}.`,
    };
  return { valid: true, row };
}

/** Atomically increment use count on a discount code. */
export const redeemDiscountCode = (id: string) =>
  query("UPDATE discount_codes SET uses_count=uses_count+1 WHERE id=$1", [id]);

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
  discount_code: string | null;
  discount_pct: number;
  expires_at: string | null;
  created_at: string;
  confirmed_at: string | null;
  cancelled_at: string | null;
  last_webhook_body: object | null;
}

export const createPaymentRecord = async (input: {
  id: string;
  userId: string;
  plan: string;
  priceUsd: number;
  discountCode?: string | null;
  discountPct?: number;
}) => {
  const [row] = await query<DbPayment>(
    `INSERT INTO payments (id,user_id,plan,price_usd,discount_code,discount_pct)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.id,
      input.userId,
      input.plan,
      input.priceUsd,
      input.discountCode ?? null,
      input.discountPct ?? 0,
    ],
  );
  return row;
};

export const updatePaymentFromGateway = (input: {
  id: string;
  nowPaymentId: string;
  payAddress: string;
  payAmount: number;
  payCurrency: string;
  expiresAt?: string;
}) =>
  query(
    `UPDATE payments SET now_payment_id=$1,pay_address=$2,pay_amount=$3,
   pay_currency=$4,expires_at=$5,status='waiting' WHERE id=$6`,
    [
      input.nowPaymentId,
      input.payAddress,
      input.payAmount,
      input.payCurrency,
      input.expiresAt ?? null,
      input.id,
    ],
  );

export const updatePaymentStatus = async (
  nowPaymentId: string,
  status: string,
  body: object,
) => {
  const [row] = await query<DbPayment>(
    `UPDATE payments SET status=$1,last_webhook_body=$2,
     confirmed_at=CASE WHEN $1 IN ('confirmed','finished') THEN NOW() ELSE confirmed_at END
     WHERE now_payment_id=$3 RETURNING *`,
    [status, JSON.stringify(body), nowPaymentId],
  );
  return row;
};

export const cancelPayment = async (id: string, userId: string) => {
  const [row] = await query<DbPayment>(
    `UPDATE payments SET status='cancelled',cancelled_at=NOW()
     WHERE id=$1 AND user_id=$2 AND status IN ('waiting','confirming') RETURNING *`,
    [id, userId],
  );
  return row;
};

export const getPaymentById = (id: string) =>
  query<DbPayment>("SELECT * FROM payments WHERE id=$1", [id]).then(
    (r) => r[0],
  );

export const getPaymentsByUser = (userId: string) =>
  query<DbPayment>(
    "SELECT * FROM payments WHERE user_id=$1 ORDER BY created_at DESC",
    [userId],
  );

export const getAllPayments = (limit = 200) =>
  query<DbPayment & { user_email: string; user_name: string }>(
    `SELECT p.*, u.email AS user_email, u.name AS user_name
     FROM payments p JOIN users u ON u.id=p.user_id
     ORDER BY p.created_at DESC LIMIT $1`,
    [limit],
  );

// ── PAYMENT OTP ───────────────────────────────────────────────────────────────
export interface DbPaymentOtp {
  id: string;
  payment_id: string;
  otp_hash: string;
  attempts: number;
  expires_at: string;
  created_at: string;
}

export const upsertPaymentOtp = (input: {
  id: string;
  paymentId: string;
  otpHash: string;
  expiresAt: Date;
}) =>
  query(
    `
  INSERT INTO payment_otps (id,payment_id,otp_hash,expires_at)
  VALUES ($1,$2,$3,$4)
  ON CONFLICT (payment_id) DO UPDATE
  SET id=$1,otp_hash=$3,attempts=0,expires_at=$4,created_at=NOW()
`,
    [input.id, input.paymentId, input.otpHash, input.expiresAt],
  );

export const getPaymentOtp = (paymentId: string) =>
  query<DbPaymentOtp>("SELECT * FROM payment_otps WHERE payment_id=$1", [
    paymentId,
  ]).then((r) => r[0]);

export const incrementPaymentOtpAttempts = async (id: string) => {
  const [r] = await query<{ attempts: number }>(
    "UPDATE payment_otps SET attempts=attempts+1 WHERE id=$1 RETURNING attempts",
    [id],
  );
  return r?.attempts ?? 0;
};

export const deletePaymentOtp = (paymentId: string) =>
  query("DELETE FROM payment_otps WHERE payment_id=$1", [paymentId]);
