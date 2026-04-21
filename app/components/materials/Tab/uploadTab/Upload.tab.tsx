"use client";

import {
  ChunkLiveState,
  ChunkStatus,
  UploadResult,
  UploadState,
} from "@/utils/types";
import { useCallback, useRef, useState } from "react";
import styles from "../../../templates/mainPageView/MianPage.view.module.css";
import { downloadText, formatBytes } from "@/utils/helpers";

export function UploadTab() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [percent, setPercent] = useState(0);
  const [chunksTotal, setChunksTotal] = useState(0);
  const [chunksDone, setChunksDone] = useState(0);
  const [chunkLive, setChunkLive] = useState<ChunkLiveState[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const handleFile = (f: File) => {
    setSelectedFile(f);
    setState("idle");
    setResult(null);
    setErrorMsg("");
    setPercent(0);
    setChunkLive([]);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }, []);

  // ── Real SSE upload ──────────────────────────────────────────────────────────
  const upload = async () => {
    if (!selectedFile) return;
    setState("uploading");
    setPercent(0);
    setChunksDone(0);

    const expectedChunks = Math.max(
      1,
      Math.ceil(selectedFile.size / (10 * 1024 * 1024)),
    );
    setChunksTotal(expectedChunks);

    // Initialise all chunks as "pending"
    setChunkLive(
      Array.from({ length: expectedChunks }, () => ({
        status: "pending" as ChunkStatus,
        attempt: 0,
        maxAttempts: 3,
      })),
    );

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Upload failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Mark the first chunk as uploading immediately
      setChunkLive((prev) => {
        const next = [...prev];
        if (next[0]) next[0] = { ...next[0], status: "uploading", attempt: 1 };
        return next;
      });

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          const { type } = event;

          if (type === "progress") {
            const {
              chunkIndex,
              done: d,
              total,
              percent: p,
            } = event as {
              chunkIndex: number;
              done: number;
              total: number;
              percent: number;
            };
            setChunksTotal(total);
            setChunksDone(d);
            setPercent(p);

            setChunkLive((prev) => {
              const next = [...prev];
              // Mark this chunk done
              if (next[chunkIndex]) {
                next[chunkIndex] = { ...next[chunkIndex], status: "done" };
              }
              // Mark next chunk uploading
              if (next[chunkIndex + 1]) {
                next[chunkIndex + 1] = {
                  ...next[chunkIndex + 1],
                  status: "uploading",
                  attempt: 1,
                };
              }
              return next;
            });
          } else if (type === "retry") {
            const { chunkIndex, attempt } = event as {
              chunkIndex: number;
              attempt: number;
            };
            setChunkLive((prev) => {
              const next = [...prev];
              if (next[chunkIndex]) {
                next[chunkIndex] = {
                  ...next[chunkIndex],
                  status: "retrying",
                  attempt: attempt + 1,
                };
              }
              return next;
            });
          } else if (type === "chunkError") {
            // Transient error — server will retry; we just update the attempt counter
            const { chunkIndex, attempt } = event as {
              chunkIndex: number;
              attempt: number;
            };
            setChunkLive((prev) => {
              const next = [...prev];
              if (next[chunkIndex]) {
                next[chunkIndex] = {
                  ...next[chunkIndex],
                  status: "retrying",
                  attempt,
                };
              }
              return next;
            });
          } else if (type === "done") {
            const r = (event as { result: UploadResult }).result;
            setPercent(100);
            setResult(r);
            setState("done");
          } else if (type === "fatal") {
            throw new Error((event as { message: string }).message);
          }
        }
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setState("error");
    }
  };

  const reset = () => {
    setSelectedFile(null);
    setResult(null);
    setState("idle");
    setPercent(0);
    setChunkLive([]);
    setErrorMsg("");
    if (inputRef.current) inputRef.current.value = "";
  };

  // ─── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Drop zone — hidden once done */}
      {state !== "done" && (
        <div
          className={`${styles.dropzone} ${dragOver ? styles.dragOver : ""} ${selectedFile ? styles.hasFile : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            className={styles.hiddenInput}
            onChange={onInputChange}
            tabIndex={-1}
          />
          {!selectedFile ? (
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
                <span className={styles.fileName}>{selectedFile.name}</span>
                <span className={styles.fileSize}>
                  {formatBytes(selectedFile.size)}
                </span>
              </div>
              {selectedFile.size > 10 * 1024 * 1024 && (
                <span className={styles.chunkBadge}>
                  → {Math.ceil(selectedFile.size / (10 * 1024 * 1024))} chunks
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Upload button */}
      {state === "idle" && selectedFile && (
        <button className={styles.uploadBtn} onClick={upload}>
          <span>UPLOAD</span>
          <span className={styles.btnArrow}>→</span>
        </button>
      )}

      {/* ── Live progress ─────────────────────────────────────────────────────── */}
      {state === "uploading" && (
        <div className={styles.progressSection}>
          {/* Overall bar */}
          <div className={styles.progressHeader}>
            <span className={styles.progressTitle}>
              Uploading {chunksDone}/{chunksTotal} chunk
              {chunksTotal !== 1 ? "s" : ""}
            </span>
            <span className={styles.progressPct}>{percent}%</span>
          </div>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${percent}%` }}
            />
          </div>

          {/* Per-chunk status grid */}
          {chunksTotal > 1 && (
            <div className={styles.chunkGrid}>
              {chunkLive.map((c, i) => (
                <div
                  key={i}
                  className={`${styles.chunkPill} ${styles[`pill_${c.status}`]}`}
                  title={
                    c.status === "retrying"
                      ? `Chunk ${i + 1}: retrying (attempt ${c.attempt}/${c.maxAttempts})`
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

          {/* Legend */}
          <div className={styles.progressLegend}>
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.dot_done}`} />
              done
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.dot_uploading}`} />
              uploading
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.dot_retrying}`} />
              retrying
            </span>
            <span className={styles.legendItem}>
              <span className={`${styles.legendDot} ${styles.dot_pending}`} />
              pending
            </span>
          </div>
        </div>
      )}

      {/* Error */}
      {state === "error" && (
        <div className={styles.errorBox}>
          <span className={styles.errorIcon}>✕</span>
          <span>{errorMsg}</span>
          <button className={styles.retryBtn} onClick={reset}>
            Retry
          </button>
        </div>
      )}

      {/* Results */}
      {state === "done" && result && (
        <div className={styles.results}>
          <div className={styles.resultHeader}>
            <span className={styles.resultIcon}>✓</span>
            <div>
              <h2 className={styles.resultTitle}>{result.originalFilename}</h2>
              <p className={styles.resultSub}>
                {formatBytes(result.fileSizeBytes)} · {result.totalChunks} chunk
                {result.totalChunks !== 1 ? "s" : ""} uploaded successfully
              </p>
            </div>
          </div>

          <div className={styles.hashRow}>
            <span className={styles.hashLabel}>SHA-256</span>
            <code className={styles.hashValue}>{result.fileHash}</code>
          </div>

          {/* Chunk links */}
          <div className={styles.chunkList}>
            <p className={styles.sectionLabel}>CHUNK LINKS</p>
            {result.chunks.map((c) => (
              <div key={c.chunkIndex} className={styles.chunkRow}>
                <div className={styles.chunkMeta}>
                  <span className={styles.chunkIdx}>#{c.chunkIndex + 1}</span>
                  <span className={styles.chunkHash}>
                    {c.hash.slice(0, 16)}…
                  </span>
                  <span className={styles.chunkSize}>
                    {formatBytes(c.sizeBytes)}
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

          {/* Single reconstructed link */}
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
              onClick={() => downloadText(result.manifest, "manifest.txt")}
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
