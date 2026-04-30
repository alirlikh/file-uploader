"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import styles from "./MainPage.view.module.css";
import { SessionUser, Tab } from "@/app/utils/types";
import UploadTab from "../../meterials/Tab/UploadTab/Upload.tab";
import FilesTab from "../../meterials/Tab/FilesTab/Files.tab";
import CombinerTab from "../../meterials/Tab/CombinerTab/Combiner.tab";

/**
 * Browser-direct-to-S3 upload flow — file body NEVER passes through Next.js:
 *
 *  1. Compute SHA-256 + slice plan client-side (Web Crypto, no server round-trip)
 *  2. POST /api/upload/presign  — auth + quota check, returns presigned PUT URLs
 *  3. PUT each chunk directly to S3 via XHR (real per-byte progress)
 *  4. POST /api/upload/complete — verify chunks in S3, persist DB, return links
 */

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
