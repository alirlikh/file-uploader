"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import styles from "./DownloadPage.view.module.css";

interface FileInfo {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  fileHash: string;
  mimeType: string;
  totalChunks: number;
  comment: string | null;
  downloadToken: string;
  downloadCount: number;
  uploadedAt: string;
  uploaderName: string;
  chunkKeys: string[];
}

type DownloadState = "idle" | "fetching" | "ready" | "error";

function fmt(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(2)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} KB`;
  return `${b} B`;
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function extIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    mp4: "🎬",
    webm: "🎬",
    mov: "🎬",
    mkv: "🎬",
    avi: "🎬",
    mp3: "🎵",
    wav: "🎵",
    flac: "🎵",
    aac: "🎵",
    jpg: "🖼️",
    jpeg: "🖼️",
    png: "🖼️",
    gif: "🖼️",
    webp: "🖼️",
    svg: "🖼️",
    pdf: "📄",
    doc: "📝",
    docx: "📝",
    xls: "📊",
    xlsx: "📊",
    pptx: "📊",
    zip: "📦",
    gz: "📦",
    tar: "📦",
    rar: "📦",
    txt: "📃",
    csv: "📃",
    json: "📃",
  };
  return map[ext] ?? "📁";
}

export default function DownloadPageView() {
  const { token } = useParams<{ token: string }>();
  const [file, setFile] = useState<FileInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Download state
  const [dlState, setDlState] = useState<DownloadState>("idle");
  const [percent, setPercent] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [speedLabel, setSpeed] = useState("");
  const [etaLabel, setEta] = useState("");
  const [dlError, setDlError] = useState("");
  const [chunksDone, setChunksDone] = useState(0);
  const [chunksTotal, setChunksTotal] = useState(0);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/files/${token}?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.file) setFile(d.file);
        else setNotFound(true);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [token]);

  const startDownload = useCallback(async () => {
    if (!file || dlState === "fetching") return;
    setDlState("fetching");
    setPercent(0);
    setLoaded(0);
    setSpeed("");
    setEta("");
    setDlError("");
    setChunksDone(0);
    setChunksTotal(file.totalChunks);

    try {
      const res = await fetch(
        `/api/download/stream?token=${token}&mode=progress`,
      );
      if (!res.ok || !res.body) throw new Error("Stream failed.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

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
            setPercent(ev.percent as number);
            setLoaded(ev.loaded as number);
            setSpeed(ev.speedLabel as string);
            setEta(ev.etaLabel as string);
            setChunksDone(ev.done as number);
          } else if (ev.type === "ready") {
            setPercent(100);
            setDlState("ready");
            // Trigger browser download automatically
            const a = document.createElement("a");
            a.href = ev.downloadUrl as string;
            a.download = ev.filename as string;
            a.click();
          } else if (ev.type === "error" || ev.type === "fatal") {
            throw new Error((ev.message as string) ?? "Download failed.");
          }
        }
      }
    } catch (err) {
      setDlError(err instanceof Error ? err.message : "Download failed.");
      setDlState("error");
    }
  }, [file, token, dlState]);

  // ── Render: loading ──────────────────────────────────────────────────────────
  if (loading)
    return (
      <main className={styles.main}>
        <div className={styles.grid} aria-hidden />
        <div className={styles.center}>
          <span className={styles.spinDot} />
          <span className={styles.centerText}>Loading…</span>
        </div>
      </main>
    );

  if (notFound)
    return (
      <main className={styles.main}>
        <div className={styles.grid} aria-hidden />
        <div className={styles.notFound}>
          <span className={styles.notFoundIcon}>⊘</span>
          <h1 className={styles.notFoundTitle}>File not found</h1>
          <p className={styles.notFoundSub}>
            This link is invalid or the file has been deleted.
          </p>
          <a href="/" className={styles.homeLink}>
            ← Go to VaultChunk
          </a>
        </div>
      </main>
    );

  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />

      <div className={styles.container}>
        {/* Brand */}
        <a href="/" className={styles.brand}>
          <span className={styles.brandIcon}>⬡</span>
          <span className={styles.brandText}>VAULTCHUNK</span>
        </a>

        {/* File card */}
        <div className={styles.fileCard}>
          <div className={styles.fileCardTop}>
            <span className={styles.fileIcon}>
              {extIcon(file!.originalFilename)}
            </span>
            <div className={styles.fileMeta}>
              <h1 className={styles.fileName}>{file!.originalFilename}</h1>
              <div className={styles.fileTags}>
                <span className={styles.tag}>{fmt(file!.fileSizeBytes)}</span>
                <span className={styles.tag}>
                  {file!.totalChunks} chunk{file!.totalChunks !== 1 ? "s" : ""}
                </span>
                <span className={styles.tag}>
                  {file!.downloadCount} download
                  {file!.downloadCount !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
          </div>

          {/* Comment */}
          {file!.comment && (
            <div className={styles.commentBox}>
              <span className={styles.commentIcon}>💬</span>
              <div>
                <p className={styles.commentLabel}>Uploader note</p>
                <p className={styles.commentText}>{file!.comment}</p>
              </div>
            </div>
          )}

          {/* Meta row */}
          <div className={styles.metaRow}>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>UPLOADED BY</span>
              <span className={styles.metaVal}>{file!.uploaderName}</span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>DATE</span>
              <span className={styles.metaVal}>
                {fmtDate(file!.uploadedAt)}
              </span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>SHA-256</span>
              <span className={styles.metaHash}>
                {file!.fileHash.slice(0, 20)}…
              </span>
            </div>
          </div>
        </div>

        {/* Download section */}
        <div className={styles.dlSection}>
          {/* Idle */}
          {dlState === "idle" && (
            <button className={styles.dlBtn} onClick={startDownload}>
              ↓ Download file
            </button>
          )}

          {/* Fetching */}
          {dlState === "fetching" && (
            <div className={styles.progress}>
              {/* Speed + ETA banner */}
              <div className={styles.speedBar}>
                <div className={styles.speedItem}>
                  <span className={styles.speedLabel}>SPEED</span>
                  <span className={styles.speedVal}>{speedLabel || "–"}</span>
                </div>
                <div className={styles.speedDivider} />
                <div className={styles.speedItem}>
                  <span className={styles.speedLabel}>DOWNLOADED</span>
                  <span className={styles.speedVal}>
                    {fmt(loaded)} / {fmt(file!.fileSizeBytes)}
                  </span>
                </div>
                <div className={styles.speedDivider} />
                <div className={styles.speedItem}>
                  <span className={styles.speedLabel}>ETA</span>
                  <span className={styles.speedVal}>{etaLabel || "–"}</span>
                </div>
              </div>

              {/* Overall bar */}
              <div className={styles.progressHeader}>
                <span className={styles.progressTitle}>
                  Fetching chunk {chunksDone} / {chunksTotal}…
                </span>
                <span className={styles.progressPct}>{percent}%</span>
              </div>
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${percent}%` }}
                />
              </div>

              <p className={styles.progressNote}>
                Assembling your file server-side. A download will start
                automatically.
              </p>
            </div>
          )}

          {/* Ready */}
          {dlState === "ready" && (
            <div className={styles.readyBox}>
              <span className={styles.readyIcon}>✓</span>
              <p className={styles.readyTitle}>Your download has started!</p>
              <p className={styles.readySub}>
                If it didn&apos;t begin automatically, use the button below.
              </p>
              <button className={styles.dlBtnSecondary} onClick={startDownload}>
                ↓ Download again
              </button>
            </div>
          )}

          {/* Error */}
          {dlState === "error" && (
            <div className={styles.errorBox}>
              <div className={styles.errorHeader}>
                <span className={styles.errorIcon}>✕</span>
                <span className={styles.errorTitle}>Download failed</span>
              </div>
              <p className={styles.errorMsg}>{dlError}</p>
              <button
                className={styles.dlBtnSecondary}
                onClick={() => {
                  setDlState("idle");
                  setDlError("");
                }}
              >
                Try again
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <p className={styles.footer}>
          Shared via{" "}
          <a href="/" className={styles.footerLink}>
            VaultChunk
          </a>{" "}
          — Secure Chunked File Storage
        </p>
      </div>
    </main>
  );
}
