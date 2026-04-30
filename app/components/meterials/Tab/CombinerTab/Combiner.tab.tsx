import { useRef, useState } from "react";
import styles from "../../../templates/mainPageView/MainPage.view.module.css";
import { CombinerMode, UrlEntry } from "@/app/utils/types";
import { fmt, inferExt, urlFilename } from "@/app/utils/helpers";

export default function CombinerTab() {
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
