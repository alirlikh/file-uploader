import { dlText, fmt } from "@/app/utils/helpers";
import {
  ChunkLive,
  ChunkStatus,
  SessionUser,
  UploadResult,
  UploadState,
} from "@/app/utils/types";

import { useCallback, useRef, useState } from "react";
import styles from "../../../templates/mainPageView/MainPage.view.module.css";
import QuotaBar from "../../Bar/QuotaBar/Quota.bar";
import { useRouter } from "next/navigation";

export default function UploadTab({
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
