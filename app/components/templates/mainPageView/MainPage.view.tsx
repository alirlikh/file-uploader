"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import styles from "./MainPage.view.module.css";

// ─── TYPES ─────────────────────────────────────────────────────────────────────
interface SessionUser {
  id: string;
  email: string;
  name: string;
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
interface ChunkLiveState {
  status: ChunkStatus;
  attempt: number;
  maxAttempts: number;
}
type UploadState = "idle" | "uploading" | "done" | "error";
type Tab = "upload" | "files" | "combiner";
type CombinerMode = "files" | "urls";
interface UrlChunkEntry {
  id: string;
  url: string;
  label: string;
  status: "idle" | "fetching" | "done" | "error";
  sizeBytes?: number;
  errorMsg?: string;
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function inferExt(name: string): string {
  const stripped = name
    .replace(/[._-](part|chunk|p|c)\d+$/i, "")
    .replace(/\.\d+$/, "");
  const dot = stripped.lastIndexOf(".");
  return dot > 0 ? stripped.slice(dot) : "";
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const qf =
      u.searchParams.get("filename") ??
      u.searchParams.get("response-content-disposition");
    if (qf) {
      const m = qf.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
      if (m) return decodeURIComponent(m[1].replace(/['"]/g, "").trim());
      return decodeURIComponent(qf);
    }
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

// ─── QUOTA BAR ────────────────────────────────────────────────────────────────
function QuotaBar({ user }: { user: SessionUser }) {
  const pct = Math.min(
    100,
    Math.round((user.dailyUsed / user.dailyLimit) * 100),
  );
  const isHigh = pct >= 80;
  return (
    <div className={styles.quotaWrap}>
      <div className={styles.quotaMeta}>
        <span className={styles.quotaLabel}>Daily quota</span>
        <span
          className={`${styles.quotaVal} ${isHigh ? styles.quotaHigh : ""}`}
        >
          {formatBytes(user.dailyUsed)} / {formatBytes(user.dailyLimit)}
        </span>
      </div>
      <div className={styles.quotaBar}>
        <div
          className={`${styles.quotaFill} ${isHigh ? styles.quotaFillHigh : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {pct >= 100 && (
        <p className={styles.quotaExhausted}>
          Limit reached — resets at midnight UTC.
        </p>
      )}
    </div>
  );
}

// ─── MY FILES TAB ─────────────────────────────────────────────────────────────
function FilesTab({ onRefresh }: { onRefresh: () => void }) {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDelId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/files");
      if (res.status === 401) {
        window.location.href = "/auth";
        return;
      }
      const data = await res.json();
      setFiles(data.files ?? []);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const deleteFile = async (id: string) => {
    setDelId(id);
    await fetch(`/api/files?id=${id}`, { method: "DELETE" });
    setFiles((f) => f.filter((x) => x.id !== id));
    setDelId(null);
    onRefresh();
  };

  if (loading)
    return (
      <div className={styles.centerMsg}>
        <span className={styles.spinnerDot} />
        <span>Loading files…</span>
      </div>
    );

  if (files.length === 0)
    return (
      <div className={styles.centerMsg}>
        <span style={{ fontSize: 36, opacity: 0.3 }}>◈</span>
        <p>No files yet. Upload something!</p>
      </div>
    );

  return (
    <div className={styles.fileList}>
      {files.map((f) => {
        const isOpen = expanded === f.id;
        return (
          <div key={f.id} className={styles.fileCard}>
            {/* Summary row */}
            <div
              className={styles.fileCardRow}
              onClick={() => setExpanded(isOpen ? null : f.id)}
            >
              <span className={styles.fileCardIcon}>◈</span>
              <div className={styles.fileCardBody}>
                <p className={styles.fileCardName}>{f.originalFilename}</p>
                <p className={styles.fileCardMeta}>
                  {formatBytes(f.fileSizeBytes)} · {f.totalChunks} chunk
                  {f.totalChunks !== 1 ? "s" : ""} · {formatDate(f.uploadedAt)}
                </p>
              </div>
              <div className={styles.fileCardActions}>
                <a
                  href={f.reconstructorUrl}
                  className={styles.iconBtn}
                  download={f.originalFilename}
                  title="Download reconstructed"
                  onClick={(e) => e.stopPropagation()}
                >
                  ↓
                </a>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteFile(f.id);
                  }}
                  disabled={deletingId === f.id}
                  title="Delete"
                >
                  {deletingId === f.id ? "…" : "✕"}
                </button>
                <span className={styles.expandArrow}>{isOpen ? "▲" : "▼"}</span>
              </div>
            </div>

            {/* Expanded: chunk links */}
            {isOpen && (
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
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── UPLOAD TAB ───────────────────────────────────────────────────────────────
function UploadTab({
  user,
  onUploadDone,
}: {
  user: SessionUser;
  onUploadDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSel] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [percent, setPercent] = useState(0);
  const [chunksTotal, setTotal] = useState(0);
  const [chunksDone, setDone] = useState(0);
  const [chunkLive, setChunkLive] = useState<ChunkLiveState[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [errorMsg, setError] = useState("");

  const handleFile = (f: File) => {
    setSel(f);
    setState("idle");
    setResult(null);
    setError("");
    setPercent(0);
    setChunkLive([]);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }, []);

  const upload = async () => {
    if (!selectedFile) return;
    if (selectedFile.size > user.dailyRemaining) {
      setError(
        `File (${formatBytes(selectedFile.size)}) exceeds your remaining daily quota (${formatBytes(user.dailyRemaining)}).`,
      );
      setState("error");
      return;
    }

    setState("uploading");
    setPercent(0);
    setDone(0);
    const expected = Math.max(
      1,
      Math.ceil(selectedFile.size / (10 * 1024 * 1024)),
    );
    setTotal(expected);
    setChunkLive(
      Array.from({ length: expected }, () => ({
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
      if (res.status === 401) {
        window.location.href = "/auth";
        return;
      }
      if (res.status === 429) {
        const d = await res.json();
        setError(d.error ?? "Quota exceeded.");
        setState("error");
        return;
      }
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Upload failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      setChunkLive((p) => {
        const n = [...p];
        if (n[0]) n[0] = { ...n[0], status: "uploading", attempt: 1 };
        return n;
      });

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (ev.type === "progress") {
            const {
              chunkIndex: ci,
              done: d,
              total: t,
              percent: p,
            } = ev as {
              chunkIndex: number;
              done: number;
              total: number;
              percent: number;
            };
            setTotal(t);
            setDone(d);
            setPercent(p);
            setChunkLive((prev) => {
              const n = [...prev];
              if (n[ci]) n[ci] = { ...n[ci], status: "done" };
              if (n[ci + 1])
                n[ci + 1] = { ...n[ci + 1], status: "uploading", attempt: 1 };
              return n;
            });
          } else if (ev.type === "retry") {
            const { chunkIndex: ci, attempt: a } = ev as {
              chunkIndex: number;
              attempt: number;
            };
            setChunkLive((p) => {
              const n = [...p];
              if (n[ci])
                n[ci] = { ...n[ci], status: "retrying", attempt: a + 1 };
              return n;
            });
          } else if (ev.type === "chunkError") {
            const { chunkIndex: ci, attempt: a } = ev as {
              chunkIndex: number;
              attempt: number;
            };
            setChunkLive((p) => {
              const n = [...p];
              if (n[ci]) n[ci] = { ...n[ci], status: "retrying", attempt: a };
              return n;
            });
          } else if (ev.type === "done") {
            const r = (ev as { result: UploadResult }).result;
            setPercent(100);
            setResult(r);
            setState("done");
            onUploadDone();
          } else if (ev.type === "fatal") {
            throw new Error((ev as { message: string }).message);
          }
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setState("error");
    }
  };

  const reset = () => {
    setSel(null);
    setResult(null);
    setState("idle");
    setPercent(0);
    setChunkLive([]);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <>
      {/* Quota bar */}
      <QuotaBar user={user} />

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
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
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

      {state === "idle" && selectedFile && (
        <button className={styles.uploadBtn} onClick={upload}>
          <span>UPLOAD</span>
          <span className={styles.btnArrow}>→</span>
        </button>
      )}

      {state === "uploading" && (
        <div className={styles.progressSection}>
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
          {chunksTotal > 1 && (
            <div className={styles.chunkGrid}>
              {chunkLive.map((c, i) => (
                <div
                  key={i}
                  className={`${styles.chunkPill} ${styles[`pill_${c.status}`]}`}
                  title={
                    c.status === "retrying"
                      ? `Chunk ${i + 1}: retrying (${c.attempt}/${c.maxAttempts})`
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
          <span>{errorMsg}</span>
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
                {formatBytes(result.fileSizeBytes)} · {result.totalChunks} chunk
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

// ─── COMBINER TAB (unchanged logic, condensed) ────────────────────────────────
function CombinerTab() {
  const [mode, setMode] = useState<CombinerMode>("files");
  const [chunkFiles, setChunkFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const [urlText, setUrlText] = useState("");
  const [urlEntries, setUrlEntries] = useState<UrlChunkEntry[]>([]);
  const [urlsFetching, setFetching] = useState(false);
  const [fetchPct, setFetchPct] = useState(0);
  const [outputName, setOutputName] = useState("reconstructed-file");
  const [combining, setCombining] = useState(false);
  const [combined, setCombined] = useState(false);
  const [combineError, setCombineError] = useState("");

  const inferExtLocal = inferExt;

  const addFiles = (fl: FileList | File[]) => {
    const arr = Array.from(fl);
    setChunkFiles((prev) => {
      const ex = new Set(prev.map((f) => f.name));
      const merged = [...prev, ...arr.filter((f) => !ex.has(f.name))];
      merged.sort(
        (a, b) =>
          parseInt(a.name.match(/\d+/)?.[0] ?? "0") -
          parseInt(b.name.match(/\d+/)?.[0] ?? "0"),
      );
      if (merged.length > 0) {
        const ext = inferExtLocal(merged[0].name);
        setOutputName((cur) => {
          if (ext && cur.endsWith(ext)) return cur;
          return (
            (cur.replace(/\.[^.]+$/, "") || "reconstructed-file") + (ext || "")
          );
        });
      }
      return merged;
    });
    setCombined(false);
  };

  const moveFile = (from: number, to: number) => {
    setChunkFiles((p) => {
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
    setUrlEntries(
      lines.map((url, i) => ({
        id: `u${i}`,
        url,
        label: `Chunk ${i + 1}`,
        status: "idle",
      })),
    );
    setCombined(false);
    if (lines.length > 0) {
      const det = filenameFromUrl(lines[0]);
      if (det) {
        const ext = inferExt(det);
        setOutputName((cur) => {
          if (ext && cur.endsWith(ext)) return cur;
          return (
            (cur.replace(/\.[^.]+$/, "") || "reconstructed-file") + (ext || "")
          );
        });
      }
    }
  };

  const moveUrl = (from: number, to: number) => {
    setUrlEntries((p) => {
      const a = [...p];
      const [it] = a.splice(from, 1);
      a.splice(to, 0, it);
      return a.map((e, i) => ({ ...e, label: `Chunk ${i + 1}` }));
    });
    setCombined(false);
  };

  function classifyStatus(status: number): "missing" | "expired" | "error" {
    if (status === 404) return "missing";
    if (status === 403 || status === 400) return "expired";
    return "error";
  }

  async function fetchOne(
    url: string,
    index: number,
    onRetry: (a: number) => void,
  ) {
    let lastStatus = 0;
    let lastMsg = "";
    for (let a = 0; a < 3; a++) {
      try {
        if (a > 0) {
          onRetry(a);
          await new Promise<void>((r) =>
            setTimeout(r, 500 * Math.pow(2, a - 1)),
          );
        }
        const res = await fetch(url);
        lastStatus = res.status;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { ok: true as const, blob: await res.blob(), index };
      } catch (err) {
        lastMsg = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      ok: false as const,
      index,
      reason: classifyStatus(lastStatus),
      detail: lastMsg,
    };
  }

  const fetchUrlChunks = async (): Promise<Blob[]> => {
    setUrlEntries((p) => p.map((e) => ({ ...e, status: "fetching" as const })));
    let completed = 0;
    const results = await Promise.all(
      urlEntries.map((entry, i) =>
        fetchOne(entry.url, i, (a) =>
          setUrlEntries((p) =>
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
          setUrlEntries((p) =>
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
          completed++;
          setFetchPct(Math.round((completed / urlEntries.length) * 100));
          return r;
        }),
      ),
    );
    const failures = results.filter(
      (r): r is Extract<typeof r, { ok: false }> => !r.ok,
    );
    if (failures.length > 0) {
      const missing = failures.filter((f) => f.reason === "missing");
      const expired = failures.filter((f) => f.reason === "expired");
      const errors = failures.filter((f) => f.reason === "error");
      const parts: string[] = [];
      if (missing.length)
        parts.push(
          `Chunk${missing.length > 1 ? "s" : ""} ${missing.map((f) => `#${f.index + 1}`).join(", ")} ${missing.length > 1 ? "are" : "is"} missing.`,
        );
      if (expired.length)
        parts.push(
          `Chunk${expired.length > 1 ? "s" : ""} ${expired.map((f) => `#${f.index + 1}`).join(", ")} link${expired.length > 1 ? "s have" : " has"} expired.`,
        );
      if (errors.length)
        parts.push(
          `Chunk${errors.length > 1 ? "s" : ""} ${errors.map((f) => `#${f.index + 1}`).join(", ")} failed: ${errors[0].detail}`,
        );
      throw new Error(parts.join("\n"));
    }
    return (results as Extract<(typeof results)[number], { ok: true }>[])
      .sort((a, b) => a.index - b.index)
      .map((r) => r.blob);
  };

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
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".json": "application/json",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".html": "text/html",
  };

  const combine = async () => {
    if (combining) return;
    setCombining(true);
    setCombined(false);
    setCombineError("");
    try {
      let blobs: Blob[];
      if (mode === "files") {
        blobs = await Promise.all(
          chunkFiles.map(async (f) => new Blob([await f.arrayBuffer()])),
        );
      } else {
        setFetching(true);
        setFetchPct(0);
        setUrlEntries((p) =>
          p.map((e) => ({ ...e, status: "idle", errorMsg: undefined })),
        );
        blobs = await fetchUrlChunks();
        setFetching(false);
      }
      const ext = outputName.slice(outputName.lastIndexOf(".")).toLowerCase();
      const merged = new Blob(blobs, {
        type: extToMime[ext] ?? "application/octet-stream",
      });
      const url = URL.createObjectURL(merged);
      const a = document.createElement("a");
      a.href = url;
      a.download = outputName;
      a.click();
      URL.revokeObjectURL(url);
      setCombined(true);
    } catch (err) {
      setCombineError(err instanceof Error ? err.message : "Combine failed");
      if (mode === "urls") setFetching(false);
    } finally {
      setCombining(false);
    }
  };

  const canCombine =
    !combining &&
    (mode === "files" ? chunkFiles.length > 0 : urlEntries.length > 0);

  return (
    <div className={styles.combiner}>
      <div className={styles.combinerInfo}>
        <span className={styles.combinerInfoIcon}>⬡</span>
        <p>
          Reconstruct files from downloaded chunks in your browser — no
          re-upload. <strong>File mode</strong>: drop local chunk files.{" "}
          <strong>URL mode</strong>: paste signed URLs and the tool fetches +
          merges.
        </p>
      </div>

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

      {mode === "files" && (
        <>
          <div
            className={`${styles.combinerDrop} ${fileDrag ? styles.dragOver : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setFileDrag(true);
            }}
            onDragLeave={() => setFileDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setFileDrag(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
          >
            <input
              ref={fileRef}
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
          {urlEntries.length > 0 && (
            <div className={styles.combinerList}>
              <div className={styles.combinerListHeader}>
                <span className={styles.sectionLabel}>
                  {urlEntries.length} CHUNK{urlEntries.length !== 1 ? "S" : ""}
                </span>
                {urlsFetching && (
                  <span
                    className={styles.sectionLabel}
                    style={{ color: "var(--accent2)" }}
                  >
                    fetching… {fetchPct}%
                  </span>
                )}
              </div>
              {urlsFetching && (
                <div className={styles.urlFetchBar}>
                  <div
                    className={styles.urlFetchFill}
                    style={{ width: `${fetchPct}%` }}
                  />
                </div>
              )}
              {urlEntries.map((entry, i) => (
                <div
                  key={entry.id}
                  className={`${styles.combinerChunkRow} ${styles[`urlRow_${entry.status}`] || ""}`}
                >
                  <span className={styles.chunkIdx} style={{ minWidth: 28 }}>
                    #{i + 1}
                  </span>
                  <span className={styles.urlStatusIcon}>
                    {entry.status === "idle" ? (
                      "·"
                    ) : entry.status === "fetching" ? (
                      <span className={styles.spinnerDot} />
                    ) : entry.status === "done" ? (
                      <span style={{ color: "var(--success)" }}>✓</span>
                    ) : (
                      <span style={{ color: "var(--error)" }}>✕</span>
                    )}
                  </span>
                  <span className={styles.combinerChunkName} title={entry.url}>
                    {entry.url.length > 55
                      ? entry.url.slice(0, 55) + "…"
                      : entry.url}
                  </span>
                  {entry.status === "done" && entry.sizeBytes && (
                    <span className={styles.chunkSize}>
                      {formatBytes(entry.sizeBytes)}
                    </span>
                  )}
                  {entry.errorMsg && (
                    <span className={styles.urlEntryErr}>{entry.errorMsg}</span>
                  )}
                  {!urlsFetching && (
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
                          i < urlEntries.length - 1 && moveUrl(i, i + 1)
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
                  ? `FETCHING… ${fetchPct}%`
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
              <ul className={styles.chunkErrorList}>
                {combineError
                  .split("\n")
                  .filter(Boolean)
                  .map((line, i) => {
                    const isExpired = line.toLowerCase().includes("expir");
                    const isMissing = line.toLowerCase().includes("missing");
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

// ─── ROOT PAGE ────────────────────────────────────────────────────────────────
export default function MainPageView() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined); // undefined = loading
  const [tab, setTab] = useState<Tab>("upload");
  const [filesBadge, setBadge] = useState(0);

  // Load session
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

  const refreshUser = () => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user) setUser(d.user);
      });
  };

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
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerRow}>
            <div className={styles.logo}>
              <span className={styles.logoIcon}>⬡</span>
              <span className={styles.logoText}>VAULTCHUNK</span>
            </div>
            {user && (
              <div className={styles.userBar}>
                <span className={styles.userName}>{user.name}</span>
                <button className={styles.logoutBtn} onClick={logout}>
                  Sign out
                </button>
              </div>
            )}
          </div>
          <p className={styles.tagline}>
            Files over 10 MB are split into isolated chunks — each with a unique
            hash.
            <br />
            Real upload progress · per-chunk retry · 1 GB daily quota per user.
          </p>
        </header>

        {/* Tabs */}
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
                  {filesBadge > 0 && (
                    <span className={styles.badge}>{filesBadge}</span>
                  )}
                </>
              )}
              {t === "combiner" && "⬡ Combiner"}
            </button>
          ))}
        </div>

        <div className={styles.tabContent}>
          {tab === "upload" && user && (
            <UploadTab user={user} onUploadDone={onUploadDone} />
          )}
          {tab === "files" && (
            <FilesTab key={filesBadge} onRefresh={refreshUser} />
          )}
          {tab === "combiner" && <CombinerTab />}
        </div>
      </div>
    </main>
  );
}
