"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import styles from "./MainPage.view.module.css";

// ── TYPES ─────────────────────────────────────────────────────────────────────
interface SessionUser {
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
interface ChunkResult {
  chunkIndex: number;
  hash: string;
  signedDownloadUrl: string;
  expiresAt: string;
  sizeBytes: number;
}
interface StoredFile {
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
interface UploadResult {
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
type ChunkStatus = "pending" | "uploading" | "done" | "retrying" | "error";
interface ChunkLive {
  status: ChunkStatus;
  attempt: number;
}
type UploadState = "idle" | "uploading" | "done" | "error";
type Tab = "upload" | "files" | "combiner";
type CombinerMode = "files" | "urls";
interface UrlEntry {
  id: string;
  url: string;
  label: string;
  status: "idle" | "fetching" | "done" | "error";
  sizeBytes?: number;
  errorMsg?: string;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const fmt = (b: number) =>
  b >= 1e12
    ? `${(b / 1e12).toFixed(2)} TB`
    : b >= 1e9
      ? `${(b / 1e9).toFixed(2)} GB`
      : b >= 1e6
        ? `${(b / 1e6).toFixed(2)} MB`
        : b >= 1e3
          ? `${(b / 1e3).toFixed(1)} KB`
          : `${b} B`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const dlText = (txt: string, name: string) => {
  const b = new Blob([txt], { type: "text/plain" });
  const u = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  URL.revokeObjectURL(u);
};

function inferExt(name: string): string {
  const s = name
    .replace(/[._-](part|chunk|p|c)\d+$/i, "")
    .replace(/\.\d+$/, "");
  const d = s.lastIndexOf(".");
  return d > 0 ? s.slice(d) : "";
}
function urlFilename(url: string): string {
  try {
    const u = new URL(url);
    const qf = u.searchParams.get("filename");
    if (qf) {
      const m = qf.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
      if (m) return decodeURIComponent(m[1].replace(/['"]/g, "").trim());
      return decodeURIComponent(qf);
    }
    return decodeURIComponent(
      u.pathname.split("/").filter(Boolean).pop() ?? "",
    );
  } catch {
    return "";
  }
}

// ── QUOTA BAR ─────────────────────────────────────────────────────────────────
function QuotaBar({ user }: { user: SessionUser }) {
  const pct = Math.min(
    100,
    Math.round((user.dailyUsed / user.dailyLimit) * 100),
  );
  const hi = pct >= 80;
  return (
    <div className={styles.quotaWrap}>
      <div className={styles.quotaMeta}>
        <div className={styles.quotaLeft}>
          <span className={styles.quotaLabel}>Daily quota</span>
          <span
            className={styles.planBadge}
            style={{ borderColor: user.planColor, color: user.planColor }}
          >
            {user.planLabel}
          </span>
        </div>
        <span className={`${styles.quotaVal} ${hi ? styles.quotaHigh : ""}`}>
          {fmt(user.dailyUsed)} / {fmt(user.dailyLimit)}
        </span>
      </div>
      <div className={styles.quotaBar}>
        <div
          className={`${styles.quotaFill} ${hi ? styles.quotaFillHigh : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className={styles.quotaFooter}>
        <span className={styles.quotaRemaining}>
          {fmt(user.dailyRemaining)} remaining
        </span>
        {pct >= 100 && (
          <span className={styles.quotaExhausted}>Resets at midnight UTC</span>
        )}
      </div>
    </div>
  );
}

// ── MY FILES TAB ──────────────────────────────────────────────────────────────
function FilesTab({ onRefresh }: { onRefresh: () => void }) {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [delId, setDelId] = useState<string | null>(null);
  const [expanded, setExp] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/files");
      if (res.status === 401) {
        router.push("/auth");
        return;
      }
      setFiles((await res.json()).files ?? []);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const del = async (id: string) => {
    setDelId(id);
    await fetch(`/api/files?id=${id}`, { method: "DELETE" });
    setFiles((p) => p.filter((f) => f.id !== id));
    setDelId(null);
    onRefresh();
  };

  if (loading)
    return (
      <div className={styles.centerMsg}>
        <span className={styles.spinDot} />
        <span>Loading…</span>
      </div>
    );
  if (!files.length)
    return (
      <div className={styles.centerMsg}>
        <span style={{ fontSize: 36, opacity: 0.3 }}>◈</span>
        <p>No files yet. Upload something!</p>
      </div>
    );

  return (
    <div className={styles.fileList}>
      {files.map((f) => {
        const open = expanded === f.id;
        return (
          <div key={f.id} className={styles.fileCard}>
            <div
              className={styles.fileCardRow}
              onClick={() => setExp(open ? null : f.id)}
            >
              <span className={styles.fileCardIcon}>◈</span>
              <div className={styles.fileCardBody}>
                <p className={styles.fileCardName}>{f.originalFilename}</p>
                <p className={styles.fileCardMeta}>
                  {fmt(f.fileSizeBytes)} · {f.totalChunks} chunk
                  {f.totalChunks !== 1 ? "s" : ""} · {fmtDate(f.uploadedAt)}
                </p>
              </div>
              <div className={styles.fileCardActions}>
                <a
                  href={f.reconstructorUrl}
                  className={styles.iconBtn}
                  download={f.originalFilename}
                  title="Download"
                  onClick={(e) => e.stopPropagation()}
                >
                  ↓
                </a>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    del(f.id);
                  }}
                  disabled={delId === f.id}
                  title="Delete"
                >
                  {delId === f.id ? "…" : "✕"}
                </button>
                <span className={styles.expandArrow}>{open ? "▲" : "▼"}</span>
              </div>
            </div>
            {open && (
              <div className={styles.fileCardDetail}>
                <div className={styles.hashRow}>
                  <span className={styles.hashLabel}>SHA-256</span>
                  <code className={styles.hashValue}>{f.fileHash}</code>
                </div>
                <p
                  className={styles.sectionLabel}
                  style={{ padding: "0 20px 8px" }}
                >
                  CHUNK LINKS
                </p>
                {f.chunks.map((c) => (
                  <div key={c.chunkIndex} className={styles.chunkRow}>
                    <div className={styles.chunkMeta}>
                      <span className={styles.chunkIdx}>
                        #{c.chunkIndex + 1}
                      </span>
                      <span className={styles.chunkHash}>
                        {c.hash.slice(0, 16)}…
                      </span>
                      <span className={styles.chunkSize}>
                        {fmt(c.sizeBytes)}
                      </span>
                      <span className={styles.chunkExpiry}>
                        exp {new Date(c.expiresAt).toLocaleString()}
                      </span>
                    </div>
                    <a
                      href={c.signedDownloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.chunkLink}
                    >
                      ↓
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── UPLOAD TAB ────────────────────────────────────────────────────────────────
/**
 * Browser-direct-to-S3 upload flow — file body NEVER passes through Next.js:
 *
 *  1. Compute SHA-256 + slice plan client-side (Web Crypto, no server round-trip)
 *  2. POST /api/upload/presign  — auth + quota check, returns presigned PUT URLs
 *  3. PUT each chunk directly to S3 via XHR (real per-byte progress)
 *  4. POST /api/upload/complete — verify chunks in S3, persist DB, return links
 */
function UploadTab({
  user,
  onDone,
}: {
  user: SessionUser;
  onDone: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const abortRef = useRef<AbortController | null>(null);

  const [drag, setDrag] = useState(false);
  const [sel, setSel] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [pct, setPct] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [live, setLive] = useState<ChunkLive[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [err, setErr] = useState("");
  // Speed + ETA — driven by real XHR progress events
  const [speedLabel, setSpeed] = useState("");
  const [etaLabel, setEta] = useState("");
  const [bytesUp, setBytesUp] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);

  const CHUNK_SIZE = 10 * 1024 * 1024; // must match server constant
  const MAX_RETRIES = 3;

  const fmtSpeed = (bps: number) =>
    bps >= 1e9
      ? `${(bps / 1e9).toFixed(1)} GB/s`
      : bps >= 1e6
        ? `${(bps / 1e6).toFixed(1)} MB/s`
        : bps >= 1e3
          ? `${(bps / 1e3).toFixed(0)} KB/s`
          : `${Math.round(bps)} B/s`;
  const fmtEta = (s: number) =>
    !isFinite(s) || s < 0
      ? "–"
      : s >= 3600
        ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
        : s >= 60
          ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
          : `${Math.floor(s)}s`;

  /** Compute SHA-256 of a File using Web Crypto (no server round-trip). */
  async function sha256Hex(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Upload one chunk directly to S3 via XHR so we get real onprogress events.
   * Returns a promise that resolves when the PUT completes.
   * Calls onProgress(bytesLoaded) as bytes flow.
   */
  function xhrPut(
    url: string,
    blob: Blob,
    mimeType: string,
    onProgress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      signal.addEventListener("abort", () => {
        xhr.abort();
        reject(new DOMException("Aborted", "AbortError"));
      });
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`S3 PUT failed: HTTP ${xhr.status}`));
      xhr.onerror = () =>
        reject(new Error("Network error during chunk upload"));
      xhr.ontimeout = () => reject(new Error("Chunk upload timed out"));
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", mimeType);
      xhr.send(blob);
    });
  }

  const pick = (f: File) => {
    setSel(f);
    setState("idle");
    setResult(null);
    setErr("");
    setPct(0);
    setLive([]);
    setSpeed("");
    setEta("");
    setBytesUp(0);
  };
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) pick(f);
  }, []);

  const upload = async () => {
    if (!sel) return;
    if (sel.size > user.dailyRemaining) {
      setErr(
        `File (${fmt(sel.size)}) exceeds your remaining daily quota (${fmt(user.dailyRemaining)}).`,
      );
      setState("error");
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    setState("uploading");
    setPct(0);
    setDone(0);
    setBytesUp(0);
    setSpeed("");
    setEta("–");

    const numChunks = Math.max(1, Math.ceil(sel.size / CHUNK_SIZE));
    setTotal(numChunks);
    setTotalBytes(sel.size);
    setLive(
      Array.from({ length: numChunks }, () => ({
        status: "pending" as ChunkStatus,
        attempt: 0,
      })),
    );

    try {
      // ── Step 0: compute SHA-256 client-side ────────────────────────────────
      const fileHash = await sha256Hex(sel);

      // ── Step 1: get presigned PUT URLs from server ─────────────────────────
      const presignRes = await fetch("/api/upload/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: sel.name,
          fileSizeBytes: sel.size,
          mimeType: sel.type || "application/octet-stream",
          fileHash,
          totalChunks: numChunks,
        }),
        signal: abort.signal,
      });

      if (presignRes.status === 401) {
        router.push("/auth");
        return;
      }
      if (presignRes.status === 429) {
        const d = await presignRes.json();
        setErr(d.error ?? "Quota exceeded.");
        setState("error");
        return;
      }
      if (!presignRes.ok) {
        const d = await presignRes.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed to initiate upload.");
      }

      const { uploadId, chunks: chunkPlan } = (await presignRes.json()) as {
        uploadId: string;
        chunks: {
          chunkIndex: number;
          putUrl: string;
          chunkKey: string;
          chunkHash: string;
          sizeBytes: number;
        }[];
      };

      // ── Step 2: PUT each chunk directly to S3 ─────────────────────────────
      // Track per-chunk loaded bytes for combined progress
      const chunkLoaded = new Array(numChunks).fill(0) as number[];
      const startMs = Date.now();

      const uploadChunk = async (c: (typeof chunkPlan)[number]) => {
        const { chunkIndex, putUrl, sizeBytes } = c;
        const start = chunkIndex * CHUNK_SIZE;
        const blob = sel.slice(start, start + sizeBytes);
        const mime = sel.type || "application/octet-stream";

        setLive((p) => {
          const n = [...p];
          if (n[chunkIndex])
            n[chunkIndex] = { status: "uploading", attempt: 1 };
          return n;
        });

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            if (attempt > 0) {
              setLive((p) => {
                const n = [...p];
                if (n[chunkIndex])
                  n[chunkIndex] = { status: "retrying", attempt: attempt + 1 };
                return n;
              });
              await new Promise<void>((r) =>
                setTimeout(r, 500 * Math.pow(2, attempt - 1)),
              );
            }

            await xhrPut(
              putUrl,
              blob,
              mime,
              (loaded) => {
                chunkLoaded[chunkIndex] = loaded;
                const totalUploaded = chunkLoaded.reduce((a, b) => a + b, 0);
                const elapsedSec = (Date.now() - startMs) / 1000;
                const speedBps =
                  elapsedSec > 0 ? totalUploaded / elapsedSec : 0;
                const remaining = sel.size - totalUploaded;
                const etaSec = speedBps > 0 ? remaining / speedBps : Infinity;

                setBytesUp(totalUploaded);
                setPct(Math.round((totalUploaded / sel.size) * 100));
                setSpeed(fmtSpeed(speedBps));
                setEta(fmtEta(etaSec));
              },
              abort.signal,
            );

            // Chunk done — set its loaded to full size for accurate total
            chunkLoaded[chunkIndex] = sizeBytes;
            setLive((p) => {
              const n = [...p];
              if (n[chunkIndex])
                n[chunkIndex] = { status: "done", attempt: attempt + 1 };
              return n;
            });
            setDone((p) => p + 1);
            return; // success
          } catch (e) {
            if ((e as Error).name === "AbortError") throw e;
            if (attempt === MAX_RETRIES - 1) {
              setLive((p) => {
                const n = [...p];
                if (n[chunkIndex])
                  n[chunkIndex] = { status: "error", attempt: attempt + 1 };
                return n;
              });
              throw new Error(
                `Chunk ${chunkIndex + 1} failed after ${MAX_RETRIES} attempts: ${(e as Error).message}`,
              );
            }
          }
        }
      };

      // Upload chunks sequentially (parallel is faster but sequential gives
      // smoother progress and is friendlier to S3 rate limits on large files)
      for (const c of chunkPlan) {
        await uploadChunk(c);
      }

      // ── Step 3: notify server — verify + persist ───────────────────────────
      const completeRes = await fetch("/api/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId }),
        signal: abort.signal,
      });

      if (!completeRes.ok) {
        const d = await completeRes.json().catch(() => ({}));
        throw new Error(d.error ?? "Failed to complete upload.");
      }

      const uploadResult: UploadResult = await completeRes.json();
      setPct(100);
      setResult(uploadResult);
      setState("done");
      onDone();
    } catch (e: unknown) {
      if ((e as Error).name === "AbortError") {
        setErr("Upload cancelled.");
        setState("error");
        return;
      }
      setErr(e instanceof Error ? e.message : "Unknown error");
      setState("error");
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };
  const reset = () => {
    setSel(null);
    setResult(null);
    setState("idle");
    setPct(0);
    setLive([]);
    setErr("");
    setBytesUp(0);
    if (ref.current) ref.current.value = "";
  };

  return (
    <>
      <QuotaBar user={user} />

      {state !== "done" && (
        <div
          className={`${styles.dropzone} ${drag ? styles.dragOver : ""} ${sel ? styles.hasFile : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => ref.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && ref.current?.click()}
        >
          <input
            ref={ref}
            type="file"
            className={styles.hiddenInput}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pick(f);
            }}
            tabIndex={-1}
          />
          {!sel ? (
            <div className={styles.dropContent}>
              <div className={styles.dropIcon}>↑</div>
              <p className={styles.dropPrimary}>Drop file here</p>
              <p className={styles.dropSecondary}>
                or click to browse · files &gt;10 MB are auto-chunked
              </p>
            </div>
          ) : (
            <div className={styles.fileInfo}>
              <div className={styles.fileIcon}>◈</div>
              <div className={styles.fileMeta}>
                <span className={styles.fileName}>{sel.name}</span>
                <span className={styles.fileSize}>{fmt(sel.size)}</span>
              </div>
              {sel.size > 10 * 1024 * 1024 && (
                <span className={styles.chunkBadge}>
                  → {Math.ceil(sel.size / (10 * 1024 * 1024))} chunks
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {state === "idle" && sel && (
        <button className={styles.uploadBtn} onClick={upload}>
          <span>UPLOAD</span>
          <span className={styles.btnArrow}>→</span>
        </button>
      )}
      {state === "uploading" && (
        <button className={styles.cancelBtn} onClick={cancel}>
          ✕ Cancel upload
        </button>
      )}

      {state === "uploading" && (
        <div className={styles.progressSection}>
          {/* Speed + ETA banner */}
          <div className={styles.speedBar}>
            <div className={styles.speedItem}>
              <span className={styles.speedLabel}>SPEED</span>
              <span className={styles.speedVal}>{speedLabel || "–"}</span>
            </div>
            <div className={styles.speedDivider} />
            <div className={styles.speedItem}>
              <span className={styles.speedLabel}>UPLOADED</span>
              <span className={styles.speedVal}>
                {fmt(bytesUp)} / {fmt(totalBytes)}
              </span>
            </div>
            <div className={styles.speedDivider} />
            <div className={styles.speedItem}>
              <span className={styles.speedLabel}>ETA</span>
              <span className={styles.speedVal}>{etaLabel || "–"}</span>
            </div>
          </div>

          <div className={styles.progressHeader}>
            <span className={styles.progressTitle}>
              Uploading {done}/{total} chunk{total !== 1 ? "s" : ""}
            </span>
            <span className={styles.progressPct}>{pct}%</span>
          </div>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>

          {total > 1 && (
            <div className={styles.chunkGrid}>
              {live.map((c, i) => (
                <div
                  key={i}
                  className={`${styles.chunkPill} ${styles[`pill_${c.status}`]}`}
                  title={
                    c.status === "retrying"
                      ? `Chunk ${i + 1}: retrying (${c.attempt}/3)`
                      : `Chunk ${i + 1}: ${c.status}`
                  }
                >
                  <span className={styles.chunkPillIdx}>{i + 1}</span>
                  {c.status === "uploading" && (
                    <span className={styles.pillSpinner} />
                  )}
                  {c.status === "retrying" && (
                    <span className={styles.pillRetry}>↻{c.attempt}</span>
                  )}
                  {c.status === "done" && (
                    <span className={styles.pillDone}>✓</span>
                  )}
                  {c.status === "error" && (
                    <span className={styles.pillErr}>✕</span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className={styles.progressLegend}>
            {(["done", "uploading", "retrying", "pending"] as const).map(
              (s) => (
                <span key={s} className={styles.legendItem}>
                  <span
                    className={`${styles.legendDot} ${styles[`dot_${s}`]}`}
                  />
                  {s}
                </span>
              ),
            )}
          </div>
        </div>
      )}

      {state === "error" && (
        <div className={styles.errorBox}>
          <span className={styles.errorIcon}>✕</span>
          <span>{err}</span>
          <button className={styles.retryBtn} onClick={reset}>
            Retry
          </button>
        </div>
      )}

      {state === "done" && result && (
        <div className={styles.results}>
          <div className={styles.resultHeader}>
            <span className={styles.resultIcon}>✓</span>
            <div>
              <h2 className={styles.resultTitle}>{result.originalFilename}</h2>
              <p className={styles.resultSub}>
                {fmt(result.fileSizeBytes)} · {result.totalChunks} chunk
                {result.totalChunks !== 1 ? "s" : ""} uploaded
              </p>
            </div>
          </div>
          <div className={styles.hashRow}>
            <span className={styles.hashLabel}>SHA-256</span>
            <code className={styles.hashValue}>{result.fileHash}</code>
          </div>
          <div className={styles.chunkList}>
            <p className={styles.sectionLabel}>CHUNK LINKS</p>
            {result.chunks.map((c) => (
              <div key={c.chunkIndex} className={styles.chunkRow}>
                <div className={styles.chunkMeta}>
                  <span className={styles.chunkIdx}>#{c.chunkIndex + 1}</span>
                  <span className={styles.chunkHash}>
                    {c.hash.slice(0, 16)}…
                  </span>
                  <span className={styles.chunkSize}>{fmt(c.sizeBytes)}</span>
                  <span className={styles.chunkExpiry}>
                    exp {new Date(c.expiresAt).toLocaleString()}
                  </span>
                </div>
                <a
                  href={c.signedDownloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.chunkLink}
                >
                  ↓
                </a>
              </div>
            ))}
          </div>
          <div className={styles.singleLink}>
            <p className={styles.sectionLabel}>RECONSTRUCTED DOWNLOAD</p>
            <div className={styles.linkRow}>
              <code className={styles.linkCode}>
                {result.reconstructorUrl.length > 72
                  ? result.reconstructorUrl.slice(0, 72) + "…"
                  : result.reconstructorUrl}
              </code>
              <a
                href={result.reconstructorUrl}
                className={styles.dlBtn}
                download={result.originalFilename}
              >
                ↓ Download
              </a>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              className={styles.manifestBtn}
              onClick={() => dlText(result.manifest, "manifest.txt")}
            >
              ↓ manifest.txt
            </button>
            <button className={styles.newUploadBtn} onClick={reset}>
              + New Upload
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── COMBINER TAB ──────────────────────────────────────────────────────────────
function CombinerTab() {
  const [mode, setMode] = useState<CombinerMode>("files");
  const [chunkFiles, setCF] = useState<File[]>([]);
  const fRef = useRef<HTMLInputElement>(null);
  const [fd, setFd] = useState(false);
  const [urlText, setUrlText] = useState("");
  const [entries, setEntries] = useState<UrlEntry[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchPct, setFetchPct] = useState(0);
  const [outName, setOutName] = useState("reconstructed-file");
  const [combining, setCombining] = useState(false);
  const [combined, setCombined] = useState(false);
  const [combErr, setCombErr] = useState("");

  const extToMime: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".json": "application/json",
    ".txt": "text/plain",
    ".csv": "text/csv",
  };

  const addFiles = (fl: FileList | File[]) => {
    const arr = Array.from(fl);
    setCF((prev) => {
      const ex = new Set(prev.map((f) => f.name));
      const m = [...prev, ...arr.filter((f) => !ex.has(f.name))];
      m.sort(
        (a, b) =>
          parseInt(a.name.match(/\d+/)?.[0] ?? "0") -
          parseInt(b.name.match(/\d+/)?.[0] ?? "0"),
      );
      if (m.length > 0) {
        const e = inferExt(m[0].name);
        setOutName((c) => {
          if (e && c.endsWith(e)) return c;
          return (
            (c.replace(/\.[^.]+$/, "") || "reconstructed-file") + (e || "")
          );
        });
      }
      return m;
    });
    setCombined(false);
  };
  const moveFile = (from: number, to: number) => {
    setCF((p) => {
      const a = [...p];
      const [it] = a.splice(from, 1);
      a.splice(to, 0, it);
      return a;
    });
    setCombined(false);
  };

  const parseUrls = () => {
    const lines = urlText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    setEntries(
      lines.map((url, i) => ({
        id: `u${i}`,
        url,
        label: `Chunk ${i + 1}`,
        status: "idle",
      })),
    );
    setCombined(false);
    if (lines.length > 0) {
      const d = urlFilename(lines[0]);
      if (d) {
        const e = inferExt(d);
        setOutName((c) => {
          if (e && c.endsWith(e)) return c;
          return (
            (c.replace(/\.[^.]+$/, "") || "reconstructed-file") + (e || "")
          );
        });
      }
    }
  };
  const moveUrl = (from: number, to: number) => {
    setEntries((p) => {
      const a = [...p];
      const [it] = a.splice(from, 1);
      a.splice(to, 0, it);
      return a.map((e, i) => ({ ...e, label: `Chunk ${i + 1}` }));
    });
    setCombined(false);
  };

  function classify(status: number): "missing" | "expired" | "error" {
    if (status === 404) return "missing";
    if (status === 403 || status === 400) return "expired";
    return "error";
  }

  async function fetchOne(
    url: string,
    index: number,
    onRetry: (a: number) => void,
  ) {
    let ls = 0,
      lm = "";
    for (let a = 0; a < 3; a++) {
      try {
        if (a > 0) {
          onRetry(a);
          await new Promise<void>((r) =>
            setTimeout(r, 500 * Math.pow(2, a - 1)),
          );
        }
        const r = await fetch(url);
        ls = r.status;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { ok: true as const, blob: await r.blob(), index };
      } catch (e) {
        lm = e instanceof Error ? e.message : String(e);
      }
    }
    return { ok: false as const, index, reason: classify(ls), detail: lm };
  }

  const fetchAll = async (): Promise<Blob[]> => {
    setEntries((p) => p.map((e) => ({ ...e, status: "fetching" as const })));
    let done = 0;
    const results = await Promise.all(
      entries.map((entry, i) =>
        fetchOne(entry.url, i, (a) =>
          setEntries((p) =>
            p.map((e, j) =>
              j === i
                ? {
                    ...e,
                    status: "fetching" as const,
                    errorMsg: `Retrying (${a}/3)…`,
                  }
                : e,
            ),
          ),
        ).then((r) => {
          setEntries((p) =>
            p.map((e, j) =>
              j === i
                ? r.ok
                  ? {
                      ...e,
                      status: "done" as const,
                      sizeBytes: r.blob.size,
                      errorMsg: undefined,
                    }
                  : {
                      ...e,
                      status: "error" as const,
                      errorMsg:
                        r.reason === "expired"
                          ? "Link expired"
                          : r.reason === "missing"
                            ? "Not found"
                            : r.detail,
                    }
                : e,
            ),
          );
          done++;
          setFetchPct(Math.round((done / entries.length) * 100));
          return r;
        }),
      ),
    );
    const fails = results.filter(
      (r): r is Extract<typeof r, { ok: false }> => !r.ok,
    );
    if (fails.length) {
      const mi = fails.filter((f) => f.reason === "missing"),
        ex = fails.filter((f) => f.reason === "expired"),
        er = fails.filter((f) => f.reason === "error");
      const p: string[] = [];
      if (mi.length)
        p.push(
          `Chunk${mi.length > 1 ? "s" : ""} ${mi.map((f) => `#${f.index + 1}`).join(", ")} ${mi.length > 1 ? "are" : "is"} missing.`,
        );
      if (ex.length)
        p.push(
          `Chunk${ex.length > 1 ? "s" : ""} ${ex.map((f) => `#${f.index + 1}`).join(", ")} link${ex.length > 1 ? "s have" : " has"} expired.`,
        );
      if (er.length)
        p.push(
          `Chunk${er.length > 1 ? "s" : ""} ${er.map((f) => `#${f.index + 1}`).join(", ")} failed: ${er[0].detail}`,
        );
      throw new Error(p.join("\n"));
    }
    return (results as Extract<(typeof results)[number], { ok: true }>[])
      .sort((a, b) => a.index - b.index)
      .map((r) => r.blob);
  };

  const combine = async () => {
    if (combining) return;
    setCombining(true);
    setCombined(false);
    setCombErr("");
    try {
      let blobs: Blob[];
      if (mode === "files")
        blobs = await Promise.all(
          chunkFiles.map(async (f) => new Blob([await f.arrayBuffer()])),
        );
      else {
        setFetching(true);
        setFetchPct(0);
        setEntries((p) =>
          p.map((e) => ({ ...e, status: "idle", errorMsg: undefined })),
        );
        blobs = await fetchAll();
        setFetching(false);
      }
      const ext = outName.slice(outName.lastIndexOf(".")).toLowerCase();
      const url = URL.createObjectURL(
        new Blob(blobs, { type: extToMime[ext] ?? "application/octet-stream" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = outName;
      a.click();
      URL.revokeObjectURL(url);
      setCombined(true);
    } catch (e) {
      setCombErr(e instanceof Error ? e.message : "Combine failed");
      if (mode === "urls") setFetching(false);
    } finally {
      setCombining(false);
    }
  };

  const canCombine =
    !combining &&
    (mode === "files" ? chunkFiles.length > 0 : entries.length > 0);

  return (
    <div className={styles.combiner}>
      <div className={styles.combinerInfo}>
        <span className={styles.combinerInfoIcon}>⬡</span>
        <p>
          Reconstruct files from downloaded chunks — in your browser.{" "}
          <strong>File mode</strong>: drop local chunk files.{" "}
          <strong>URL mode</strong>: paste signed URLs, the tool fetches +
          merges.
        </p>
      </div>
      <div className={styles.modeToggle}>
        <button
          className={`${styles.modeBtn} ${mode === "files" ? styles.modeBtnActive : ""}`}
          onClick={() => {
            setMode("files");
            setCombined(false);
            setCombErr("");
          }}
        >
          ◈ Local Files
        </button>
        <button
          className={`${styles.modeBtn} ${mode === "urls" ? styles.modeBtnActive : ""}`}
          onClick={() => {
            setMode("urls");
            setCombined(false);
            setCombErr("");
          }}
        >
          ⬡ Remote URLs
        </button>
      </div>

      {mode === "files" && (
        <>
          <div
            className={`${styles.combinerDrop} ${fd ? styles.dragOver : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setFd(true);
            }}
            onDragLeave={() => setFd(false)}
            onDrop={(e) => {
              e.preventDefault();
              setFd(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => fRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fRef.current?.click()}
          >
            <input
              ref={fRef}
              type="file"
              multiple
              className={styles.hiddenInput}
              onChange={(e) => e.target.files && addFiles(e.target.files)}
              tabIndex={-1}
            />
            <span style={{ fontSize: 28, color: "var(--accent)" }}>+</span>
            <span className={styles.dropPrimary} style={{ fontSize: 13 }}>
              Drop chunk files or click to browse
            </span>
            <span className={styles.dropSecondary}>
              Auto-sorted by filename number
            </span>
          </div>
          {chunkFiles.length > 0 && (
            <div className={styles.combinerList}>
              <div className={styles.combinerListHeader}>
                <span className={styles.sectionLabel}>CHUNK ORDER</span>
                <span className={styles.sectionLabel}>
                  {fmt(chunkFiles.reduce((s, f) => s + f.size, 0))} total
                </span>
              </div>
              {chunkFiles.map((f, i) => (
                <div key={f.name + i} className={styles.combinerChunkRow}>
                  <span className={styles.chunkIdx} style={{ minWidth: 28 }}>
                    #{i + 1}
                  </span>
                  <span className={styles.combinerChunkName}>{f.name}</span>
                  <span className={styles.chunkSize}>{fmt(f.size)}</span>
                  <div className={styles.combinerRowBtns}>
                    <button
                      className={styles.combinerArrow}
                      onClick={() => i > 0 && moveFile(i, i - 1)}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      className={styles.combinerArrow}
                      onClick={() =>
                        i < chunkFiles.length - 1 && moveFile(i, i + 1)
                      }
                      disabled={i === chunkFiles.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className={styles.deleteBtn}
                      onClick={() => {
                        setCF((p) => p.filter((_, j) => j !== i));
                        setCombined(false);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {mode === "urls" && (
        <>
          <div className={styles.urlInputSection}>
            <p className={styles.sectionLabel}>
              PASTE CHUNK URLS — one per line, in order
            </p>
            <textarea
              className={styles.urlTextarea}
              value={urlText}
              onChange={(e) => setUrlText(e.target.value)}
              placeholder={
                "https://s3.amazonaws.com/bucket/uploads/abc123…\nhttps://…"
              }
              rows={5}
              spellCheck={false}
            />
            <button
              className={styles.parseBtn}
              onClick={parseUrls}
              disabled={!urlText.trim()}
            >
              Parse URLs →
            </button>
          </div>
          {entries.length > 0 && (
            <div className={styles.combinerList}>
              <div className={styles.combinerListHeader}>
                <span className={styles.sectionLabel}>
                  {entries.length} CHUNK{entries.length !== 1 ? "S" : ""}
                </span>
                {fetching && (
                  <span
                    className={styles.sectionLabel}
                    style={{ color: "var(--accent2)" }}
                  >
                    fetching… {fetchPct}%
                  </span>
                )}
              </div>
              {fetching && (
                <div className={styles.urlFetchBar}>
                  <div
                    className={styles.urlFetchFill}
                    style={{ width: `${fetchPct}%` }}
                  />
                </div>
              )}
              {entries.map((e, i) => (
                <div
                  key={e.id}
                  className={`${styles.combinerChunkRow} ${styles[`urlRow_${e.status}`] || ""}`}
                >
                  <span className={styles.chunkIdx} style={{ minWidth: 28 }}>
                    #{i + 1}
                  </span>
                  <span className={styles.urlStatusIcon}>
                    {e.status === "idle" ? (
                      "·"
                    ) : e.status === "fetching" ? (
                      <span className={styles.spinDot} />
                    ) : e.status === "done" ? (
                      <span style={{ color: "var(--success)" }}>✓</span>
                    ) : (
                      <span style={{ color: "var(--error)" }}>✕</span>
                    )}
                  </span>
                  <span className={styles.combinerChunkName} title={e.url}>
                    {e.url.length > 55 ? e.url.slice(0, 55) + "…" : e.url}
                  </span>
                  {e.status === "done" && e.sizeBytes && (
                    <span className={styles.chunkSize}>{fmt(e.sizeBytes)}</span>
                  )}
                  {e.errorMsg && (
                    <span className={styles.urlEntryErr}>{e.errorMsg}</span>
                  )}
                  {!fetching && (
                    <div className={styles.combinerRowBtns}>
                      <button
                        className={styles.combinerArrow}
                        onClick={() => i > 0 && moveUrl(i, i - 1)}
                        disabled={i === 0}
                      >
                        ↑
                      </button>
                      <button
                        className={styles.combinerArrow}
                        onClick={() =>
                          i < entries.length - 1 && moveUrl(i, i + 1)
                        }
                        disabled={i === entries.length - 1}
                      >
                        ↓
                      </button>
                      <button
                        className={styles.deleteBtn}
                        onClick={() => {
                          setEntries((p) =>
                            p
                              .filter((_, j) => j !== i)
                              .map((e, k) => ({
                                ...e,
                                label: `Chunk ${k + 1}`,
                              })),
                          );
                          setCombined(false);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {canCombine && (
        <div className={styles.combinerFooter}>
          <div className={styles.outputNameRow}>
            <span className={styles.sectionLabel} style={{ flexShrink: 0 }}>
              OUTPUT FILENAME
            </span>
            <input
              className={styles.outputNameInput}
              value={outName}
              onChange={(e) => setOutName(e.target.value)}
              placeholder="filename"
              spellCheck={false}
            />
          </div>
          <button
            className={styles.uploadBtn}
            onClick={combine}
            disabled={combining}
            style={{ marginTop: 0 }}
          >
            <span>
              {combining
                ? mode === "urls"
                  ? `FETCHING… ${fetchPct}%`
                  : "COMBINING…"
                : mode === "urls"
                  ? `FETCH & COMBINE ${entries.length} CHUNK${entries.length !== 1 ? "S" : ""}`
                  : `COMBINE ${chunkFiles.length} CHUNK${chunkFiles.length !== 1 ? "S" : ""}`}
            </span>
            <span className={styles.btnArrow}>→</span>
          </button>
          {combErr && (
            <div className={styles.chunkErrorBox}>
              <div className={styles.chunkErrorHeader}>
                <span className={styles.errorIcon}>✕</span>
                <span className={styles.chunkErrorTitle}>
                  Cannot combine — some chunks have problems
                </span>
                <button className={styles.retryBtn} onClick={combine}>
                  Retry
                </button>
              </div>
              <ul className={styles.chunkErrorList}>
                {combErr
                  .split("\n")
                  .filter(Boolean)
                  .map((line, i) => {
                    const exp = line.toLowerCase().includes("expir"),
                      mis = line.toLowerCase().includes("missing");
                    return (
                      <li
                        key={i}
                        className={`${styles.chunkErrorItem} ${exp ? styles.chunkErrorExpired : mis ? styles.chunkErrorMissing : styles.chunkErrorGeneric}`}
                      >
                        <span className={styles.chunkErrorBullet}>
                          {exp ? "⏱" : mis ? "⊘" : "!"}
                        </span>
                        {line}
                      </li>
                    );
                  })}
              </ul>
            </div>
          )}
          {combined && !combErr && (
            <div className={styles.combinerSuccess}>
              <span style={{ color: "var(--success)" }}>✓</span>
              <span>
                Downloaded as <strong>{outName}</strong>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("upload");
  const [badge, setBadge] = useState(0);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (!d.user) router.push("/auth");
        else setUser(d.user);
      })
      .catch(() => router.push("/auth"));
  }, [router]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/auth");
  };
  const refreshUser = () =>
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user) setUser(d.user);
      });
  const onUploadDone = () => {
    setBadge((n) => n + 1);
    refreshUser();
  };

  if (user === undefined)
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0b0d",
        }}
      >
        <span style={{ color: "#5a6a7a", fontFamily: "monospace" }}>
          Loading…
        </span>
      </main>
    );

  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />
      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.headerRow}>
            <div className={styles.logo}>
              <span className={styles.logoIcon}>⬡</span>
              <span className={styles.logoText}>VAULTCHUNK</span>
            </div>
            {user && (
              <div className={styles.userBar}>
                {user.isAdmin && (
                  <a href="/admin" className={styles.adminLink}>
                    ⬡ Admin
                  </a>
                )}
                <span className={styles.userName}>{user.name}</span>
                <button className={styles.logoutBtn} onClick={logout}>
                  Sign out
                </button>
              </div>
            )}
          </div>
          <p className={styles.tagline}>
            Chunked file upload · per-chunk retry · real-time speed ·{" "}
            {user?.planLabel} plan
          </p>
        </header>

        <div className={styles.tabs}>
          {(["upload", "files", "combiner"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`${styles.tab} ${tab === t ? styles.tabActive : ""}`}
              onClick={() => {
                setTab(t);
                if (t === "files") setBadge(0);
              }}
            >
              {t === "upload" && "↑ Upload"}
              {t === "files" && (
                <>
                  ◈ My Files
                  {badge > 0 && <span className={styles.badge}>{badge}</span>}
                </>
              )}
              {t === "combiner" && "⬡ Combiner"}
            </button>
          ))}
        </div>

        <div className={styles.tabContent}>
          {tab === "upload" && user && (
            <UploadTab user={user} onDone={onUploadDone} />
          )}
          {tab === "files" && <FilesTab key={badge} onRefresh={refreshUser} />}
          {tab === "combiner" && <CombinerTab />}
        </div>
      </div>
    </main>
  );
}
