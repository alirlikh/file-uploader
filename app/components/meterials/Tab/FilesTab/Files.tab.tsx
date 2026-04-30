import { StoredFile } from "@/app/utils/types";
import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";

import styles from "../../../templates/mainPageView/MainPage.view.module.css";
import { fmt, fmtDate } from "@/app/utils/helpers";

export default function FilesTab({ onRefresh }: { onRefresh: () => void }) {
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
