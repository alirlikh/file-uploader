"use client";

import { useState } from "react";
import styles from "../mainPageView/MianPage.view.module.css";
import { Tab } from "@/utils/types";
import CombinerTab from "../../materials/Tab/combinerTab/Combiner.tab";
import { UploadTab } from "../../materials/Tab/uploadTab/Upload.tab";

export default function UploadPageView() {
  const [tab, setTab] = useState<Tab>("upload");

  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />
      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>⬡</span>
            <span className={styles.logoText}>VAULTCHUNK</span>
          </div>
          <p className={styles.tagline}>
            Files over 10 MB are split into isolated chunks — each with a unique
            hash.
            <br />
            Real upload progress · per-chunk retry · offline or URL-based
            reconstruction.
          </p>
        </header>

        <div className={styles.tabs}>
          {(["upload", "combiner"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`${styles.tab} ${tab === t ? styles.tabActive : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "upload" && "↑ Upload"}
              {t === "combiner" && "⬡ Chunk Combiner"}
            </button>
          ))}
        </div>

        <div className={styles.tabContent}>
          {tab === "upload" && <UploadTab />}
          {tab === "combiner" && <CombinerTab />}
        </div>
      </div>
    </main>
  );
}
