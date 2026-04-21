"use client";

import { CombinerMode, UrlChunkEntry } from "@/utils/types";
import { useRef, useState } from "react";
import styles from "../../../templates/mainPageView/MianPage.view.module.css";
import { formatBytes } from "@/utils/helpers";

function CombinerTab() {
  const [mode, setMode] = useState<CombinerMode>("files");

  // ── File mode state ────────────────────────────────────────────────────────
  const [chunkFiles, setChunkFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileDragOver, setFileDragOver] = useState(false);

  // ── URL mode state ─────────────────────────────────────────────────────────
  const [urlText, setUrlText] = useState(""); // textarea input
  const [urlEntries, setUrlEntries] = useState<UrlChunkEntry[]>([]);
  const [urlsFetching, setUrlsFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState(0); // 0-100

  // ── Shared state ───────────────────────────────────────────────────────────
  const [outputName, setOutputName] = useState("reconstructed-file");
  const [combining, setCombining] = useState(false);
  const [combined, setCombined] = useState(false);
  const [combineError, setCombineError] = useState("");

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Given any filename (possibly a chunk like "video.mp4" or "video.mp4.part2"),
   * return the real original extension, e.g. ".mp4".
   * Strategy: strip trailing ".partN" / ".chunkN" / "_chunkN" suffixes, then
   * take the last dot-separated segment as the extension.
   */
  function inferExt(name: string): string {
    // Remove common chunk suffixes: .part1, .chunk2, _part3, -chunk4, etc.
    const stripped = name
      .replace(/[._-](part|chunk|p|c)\d+$/i, "")
      .replace(/\.\d+$/, ""); // trailing bare numbers like "file.mp4.1"
    const dot = stripped.lastIndexOf(".");
    return dot > 0 ? stripped.slice(dot) : ""; // includes the dot, e.g. ".mp4"
  }

  /**
   * Try to extract a human-readable base name from a signed S3 URL.
   * Looks at the `filename` query-param first, then the URL path segment.
   */
  function filenameFromUrl(url: string): string {
    try {
      const u = new URL(url);
      const qf =
        u.searchParams.get("filename") ??
        u.searchParams.get("response-content-disposition");
      if (qf) {
        // response-content-disposition value: attachment; filename="foo.mp4"
        const m = qf.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
        if (m) return decodeURIComponent(m[1].replace(/['"]/g, "").trim());
        return decodeURIComponent(qf);
      }
      // Fall back to last path segment
      const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
      return decodeURIComponent(seg);
    } catch {
      return "";
    }
  }

  // ── File mode helpers ──────────────────────────────────────────────────────
  const addFiles = (newFiles: FileList | File[]) => {
    const arr = Array.from(newFiles);
    setChunkFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      const merged = [...prev, ...arr.filter((f) => !existing.has(f.name))];
      // Auto-sort by embedded number in filename
      merged.sort((a, b) => {
        const na = parseInt(a.name.match(/\d+/)?.[0] ?? "0");
        const nb = parseInt(b.name.match(/\d+/)?.[0] ?? "0");
        return na - nb;
      });

      // Auto-set output name from the first file's inferred extension,
      // but only if the user hasn't manually typed a name with an extension.
      if (merged.length > 0) {
        const ext = inferExt(merged[0].name); // e.g. ".mp4"
        setOutputName((current) => {
          // If current name already has the right extension, leave it alone
          if (ext && current.endsWith(ext)) return current;
          // Strip any existing extension from the current name, then add the real one
          const base = current.replace(/\.[^.]+$/, "") || "reconstructed-file";
          return ext ? base + ext : base;
        });
      }

      return merged;
    });
    setCombined(false);
  };

  const onFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setFileDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  const moveChunk = (from: number, to: number) => {
    setChunkFiles((prev) => {
      const arr = [...prev];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      return arr;
    });
    setCombined(false);
  };

  // ── URL mode helpers ───────────────────────────────────────────────────────
  /**
   * Parse the textarea — one URL per line (blank lines / comments ignored).
   * Initialises entries as idle and auto-detects the output filename extension
   * from the first URL's path or filename query-param.
   */
  const parseUrls = () => {
    const lines = urlText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    const entries: UrlChunkEntry[] = lines.map((url, i) => ({
      id: `url-${i}`,
      url,
      label: `Chunk ${i + 1}`,
      status: "idle",
    }));

    setUrlEntries(entries);
    setCombined(false);

    // Auto-detect output filename extension from the first URL
    if (lines.length > 0) {
      const detected = filenameFromUrl(lines[0]);
      if (detected) {
        const ext = inferExt(detected);
        setOutputName((current) => {
          if (ext && current.endsWith(ext)) return current;
          const base = current.replace(/\.[^.]+$/, "") || "reconstructed-file";
          return ext ? base + ext : base;
        });
      }
    }
  };

  const moveUrlEntry = (from: number, to: number) => {
    setUrlEntries((prev) => {
      const arr = [...prev];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      // Re-label
      return arr.map((e, i) => ({ ...e, label: `Chunk ${i + 1}` }));
    });
    setCombined(false);
  };

  /**
   * Classify an HTTP status into a user-facing reason string.
   * Mirrors the server-side logic so the client combiner gives the same
   * clear messages when using signed URLs directly.
   *
   * Expiry is determined by the REAL HTTP response from S3 (403 / 400),
   * NOT by any client-side timestamp that could be forged or misconfigured.
   */
  function classifyHttpStatus(status: number): "missing" | "expired" | "error" {
    if (status === 404) return "missing"; // NoSuchKey
    if (status === 403 || status === 400) return "expired"; // AccessDenied / RequestExpired
    return "error";
  }

  /**
   * Fetch one chunk URL with retry.
   * Returns { blob } on success or { reason, detail } on final failure.
   */
  async function fetchOneChunk(
    url: string,
    index: number,
    onRetry: (attempt: number) => void,
  ) {
    const MAX_ATTEMPTS = 3;
    let lastStatus = 0;
    let lastMsg = "";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 0) {
          onRetry(attempt);
          await new Promise<void>((r) =>
            setTimeout(r, 500 * Math.pow(2, attempt - 1)),
          );
        }
        const res = await fetch(url);
        lastStatus = res.status;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        return { ok: true as const, blob, index };
      } catch (err) {
        lastMsg = err instanceof Error ? err.message : String(err);
      }
    }

    const reason = classifyHttpStatus(lastStatus);
    return { ok: false as const, index, reason, detail: lastMsg };
  }

  /**
   * Fetch ALL chunks in parallel, collect every failure, then throw a
   * combined error that lists all missing/expired chunks at once instead
   * of stopping at the first problem.
   */
  const fetchUrlChunks = async (): Promise<Blob[]> => {
    // Mark all as fetching immediately
    setUrlEntries((prev) =>
      prev.map((e) => ({ ...e, status: "fetching" as const })),
    );

    let completed = 0;

    const results = await Promise.all(
      urlEntries.map((entry, i) =>
        fetchOneChunk(entry.url, i, (attempt) => {
          setUrlEntries((prev) =>
            prev.map((e, j) =>
              j === i
                ? {
                    ...e,
                    status: "fetching" as const,
                    errorMsg: `Retrying (${attempt}/${3})…`,
                  }
                : e,
            ),
          );
        }).then((result) => {
          // Update individual entry as it resolves
          setUrlEntries((prev) =>
            prev.map((e, j) =>
              j === i
                ? result.ok
                  ? {
                      ...e,
                      status: "done" as const,
                      sizeBytes: result.blob.size,
                      errorMsg: undefined,
                    }
                  : {
                      ...e,
                      status: "error" as const,
                      errorMsg:
                        result.reason === "expired"
                          ? "Link expired"
                          : result.reason === "missing"
                            ? "Not found"
                            : result.detail,
                    }
                : e,
            ),
          );
          completed++;
          setFetchProgress(Math.round((completed / urlEntries.length) * 100));
          return result;
        }),
      ),
    );

    // Collect ALL failures before throwing
    const failures = results.filter(
      (r): r is Extract<typeof r, { ok: false }> => !r.ok,
    );

    if (failures.length > 0) {
      const missing = failures.filter((f) => f.reason === "missing");
      const expired = failures.filter((f) => f.reason === "expired");
      const errors = failures.filter((f) => f.reason === "error");
      const parts: string[] = [];

      if (missing.length > 0) {
        const nums = missing.map((f) => `#${f.index + 1}`).join(", ");
        parts.push(
          missing.length === 1
            ? `Chunk ${nums} is missing — the URL points to a file that no longer exists.`
            : `Chunks ${nums} are missing — their URLs point to files that no longer exist.`,
        );
      }
      if (expired.length > 0) {
        const nums = expired.map((f) => `#${f.index + 1}`).join(", ");
        parts.push(
          expired.length === 1
            ? `Chunk ${nums} link has expired — re-upload or generate a new signed URL.`
            : `Chunks ${nums} links have expired — re-upload or generate new signed URLs.`,
        );
      }
      if (errors.length > 0) {
        const nums = errors.map((f) => `#${f.index + 1}`).join(", ");
        parts.push(
          `Chunk${errors.length > 1 ? "s" : ""} ${nums} failed: ${errors[0].detail}`,
        );
      }

      throw new Error(parts.join("\n"));
    }

    // All good — return blobs in original order
    return (results as Extract<(typeof results)[number], { ok: true }>[])
      .sort((a, b) => a.index - b.index)
      .map((r) => r.blob);
  };

  // ── Combine (both modes) ──────────────────────────────────────────────────
  const combine = async () => {
    if (combining) return;
    setCombining(true);
    setCombined(false);
    setCombineError("");

    try {
      let blobs: Blob[];

      if (mode === "files") {
        if (chunkFiles.length === 0) return;
        blobs = await Promise.all(
          chunkFiles.map(async (f) => {
            const buf = await f.arrayBuffer();
            return new Blob([buf]);
          }),
        );
      } else {
        if (urlEntries.length === 0) return;
        setUrlsFetching(true);
        setFetchProgress(0);
        // Reset all entries to idle before re-fetching
        setUrlEntries((prev) =>
          prev.map((e) => ({ ...e, status: "idle", errorMsg: undefined })),
        );
        blobs = await fetchUrlChunks();
        setUrlsFetching(false);
      }

      // Derive MIME type from the output filename extension so the browser
      // treats the downloaded file correctly (not as application/octet-stream).
      const extToMime: Record<string, string> = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".mkv": "video/x-matroska",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".aac": "audio/aac",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".zip": "application/zip",
        ".gz": "application/gzip",
        ".tar": "application/x-tar",
        ".rar": "application/vnd.rar",
        ".json": "application/json",
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".html": "text/html",
        ".xml": "application/xml",
      };
      const outExt = outputName
        .slice(outputName.lastIndexOf("."))
        .toLowerCase();
      const mimeType = extToMime[outExt] ?? "application/octet-stream";

      // Merge blobs with the correct MIME type
      const merged = new Blob(blobs, { type: mimeType });
      const url = URL.createObjectURL(merged);
      const a = document.createElement("a");
      a.href = url;
      a.download = outputName;
      a.click();
      URL.revokeObjectURL(url);
      setCombined(true);
    } catch (err) {
      setCombineError(err instanceof Error ? err.message : "Combine failed");
      if (mode === "urls") setUrlsFetching(false);
    } finally {
      setCombining(false);
    }
  };

  const canCombine =
    !combining &&
    (mode === "files" ? chunkFiles.length > 0 : urlEntries.length > 0);

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.combiner}>
      {/* Info banner */}
      <div className={styles.combinerInfo}>
        <span className={styles.combinerInfoIcon}>⬡</span>
        <p>
          Reconstruct files from downloaded chunks — purely in your browser, no
          re-upload.
          <br />
          <strong>File mode</strong>: drop chunk files you already downloaded.
          <br />
          <strong>URL mode</strong>: paste signed chunk URLs and the tool
          fetches + merges them.
        </p>
      </div>

      {/* Mode toggle */}
      <div className={styles.modeToggle}>
        <button
          className={`${styles.modeBtn} ${mode === "files" ? styles.modeBtnActive : ""}`}
          onClick={() => {
            setMode("files");
            setCombined(false);
            setCombineError("");
          }}
        >
          ◈ Local Files
        </button>
        <button
          className={`${styles.modeBtn} ${mode === "urls" ? styles.modeBtnActive : ""}`}
          onClick={() => {
            setMode("urls");
            setCombined(false);
            setCombineError("");
          }}
        >
          ⬡ Remote URLs
        </button>
      </div>

      {/* ── FILE MODE ──────────────────────────────────────────────────────── */}
      {mode === "files" && (
        <>
          <div
            className={`${styles.combinerDrop} ${fileDragOver ? styles.dragOver : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setFileDragOver(true);
            }}
            onDragLeave={() => setFileDragOver(false)}
            onDrop={onFileDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) =>
              e.key === "Enter" && fileInputRef.current?.click()
            }
          >
            <input
              ref={fileInputRef}
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
              Select multiple — auto-sorted by filename number
            </span>
          </div>

          {chunkFiles.length > 0 && (
            <div className={styles.combinerList}>
              <div className={styles.combinerListHeader}>
                <span className={styles.sectionLabel}>
                  CHUNK ORDER — drag to reorder
                </span>
                <span className={styles.sectionLabel}>
                  {formatBytes(chunkFiles.reduce((s, f) => s + f.size, 0))}{" "}
                  total
                </span>
              </div>
              {chunkFiles.map((f, i) => (
                <div key={f.name + i} className={styles.combinerChunkRow}>
                  <span className={styles.chunkIdx} style={{ minWidth: 28 }}>
                    #{i + 1}
                  </span>
                  <span className={styles.combinerChunkName}>{f.name}</span>
                  <span className={styles.chunkSize}>
                    {formatBytes(f.size)}
                  </span>
                  <div className={styles.combinerRowBtns}>
                    <button
                      className={styles.combinerArrow}
                      onClick={() => i > 0 && moveChunk(i, i - 1)}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      className={styles.combinerArrow}
                      onClick={() =>
                        i < chunkFiles.length - 1 && moveChunk(i, i + 1)
                      }
                      disabled={i === chunkFiles.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className={styles.deleteBtn}
                      onClick={() => {
                        setChunkFiles((p) => p.filter((_, j) => j !== i));
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

      {/* ── URL MODE ─────────────────────────────────────────────────────────── */}
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
              placeholder={`https://s3.amazonaws.com/bucket/uploads/abc123…\nhttps://s3.amazonaws.com/bucket/uploads/def456…\nhttps://s3.amazonaws.com/bucket/uploads/ghi789…`}
              rows={6}
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

          {urlEntries.length > 0 && (
            <div className={styles.combinerList}>
              <div className={styles.combinerListHeader}>
                <span className={styles.sectionLabel}>
                  {urlEntries.length} CHUNK{urlEntries.length !== 1 ? "S" : ""}{" "}
                  — reorder if needed
                </span>
                {urlsFetching && (
                  <span
                    className={styles.sectionLabel}
                    style={{ color: "var(--accent2)" }}
                  >
                    fetching… {fetchProgress}%
                  </span>
                )}
              </div>

              {/* Fetch progress bar — shown while downloading */}
              {urlsFetching && (
                <div className={styles.urlFetchBar}>
                  <div
                    className={styles.urlFetchFill}
                    style={{ width: `${fetchProgress}%` }}
                  />
                </div>
              )}

              {urlEntries.map((entry, i) => (
                <div
                  key={entry.id}
                  className={`${styles.combinerChunkRow} ${styles[`urlRow_${entry.status}`]}`}
                >
                  <span className={styles.chunkIdx} style={{ minWidth: 28 }}>
                    #{i + 1}
                  </span>

                  {/* Status icon */}
                  <span className={styles.urlStatusIcon}>
                    {entry.status === "idle" && "·"}
                    {entry.status === "fetching" && (
                      <span className={styles.spinnerDot} />
                    )}
                    {entry.status === "done" && (
                      <span style={{ color: "var(--success)" }}>✓</span>
                    )}
                    {entry.status === "error" && (
                      <span style={{ color: "var(--error)" }}>✕</span>
                    )}
                  </span>

                  {/* URL (truncated) */}
                  <span className={styles.combinerChunkName} title={entry.url}>
                    {entry.url.length > 55
                      ? entry.url.slice(0, 55) + "…"
                      : entry.url}
                  </span>

                  {/* Size or error */}
                  {entry.status === "done" && entry.sizeBytes && (
                    <span className={styles.chunkSize}>
                      {formatBytes(entry.sizeBytes)}
                    </span>
                  )}
                  {(entry.status === "error" || entry.errorMsg) && (
                    <span className={styles.urlEntryErr}>{entry.errorMsg}</span>
                  )}

                  {/* Reorder buttons (only when not fetching) */}
                  {!urlsFetching && (
                    <div className={styles.combinerRowBtns}>
                      <button
                        className={styles.combinerArrow}
                        onClick={() => i > 0 && moveUrlEntry(i, i - 1)}
                        disabled={i === 0}
                      >
                        ↑
                      </button>
                      <button
                        className={styles.combinerArrow}
                        onClick={() =>
                          i < urlEntries.length - 1 && moveUrlEntry(i, i + 1)
                        }
                        disabled={i === urlEntries.length - 1}
                      >
                        ↓
                      </button>
                      <button
                        className={styles.deleteBtn}
                        onClick={() => {
                          setUrlEntries((p) =>
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

      {/* ── Footer: output name + combine button ───────────────────────────── */}
      {canCombine && (
        <div className={styles.combinerFooter}>
          <div className={styles.outputNameRow}>
            <span className={styles.sectionLabel} style={{ flexShrink: 0 }}>
              OUTPUT FILENAME
            </span>
            <input
              className={styles.outputNameInput}
              value={outputName}
              onChange={(e) => setOutputName(e.target.value)}
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
                  ? `FETCHING… ${fetchProgress}%`
                  : "COMBINING…"
                : mode === "urls"
                  ? `FETCH & COMBINE ${urlEntries.length} CHUNK${urlEntries.length !== 1 ? "S" : ""}`
                  : `COMBINE ${chunkFiles.length} CHUNK${chunkFiles.length !== 1 ? "S" : ""}`}
            </span>
            <span className={styles.btnArrow}>→</span>
          </button>

          {combineError && (
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
              {/* Render each line of the error as its own row for readability */}
              <ul className={styles.chunkErrorList}>
                {combineError
                  .split("\n")
                  .filter(Boolean)
                  .map((line, i) => {
                    const isExpired = line.toLowerCase().includes("expir");
                    const isMissing =
                      line.toLowerCase().includes("missing") ||
                      line.toLowerCase().includes("no longer exist");
                    return (
                      <li
                        key={i}
                        className={`${styles.chunkErrorItem} ${isExpired ? styles.chunkErrorExpired : isMissing ? styles.chunkErrorMissing : styles.chunkErrorGeneric}`}
                      >
                        <span className={styles.chunkErrorBullet}>
                          {isExpired ? "⏱" : isMissing ? "⊘" : "!"}
                        </span>
                        {line}
                      </li>
                    );
                  })}
              </ul>
            </div>
          )}

          {combined && !combineError && (
            <div className={styles.combinerSuccess}>
              <span style={{ color: "var(--success)" }}>✓</span>
              <span>
                Downloaded as <strong>{outputName}</strong>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default CombinerTab;
