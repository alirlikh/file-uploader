"use client";

import { useState } from "react";

export default function Home() {
  const [manifestKey, setManifestKey] = useState("");
  const [status, setStatus] = useState("");

  async function rebuildFile() {
    setStatus("Loading manifest...");

    // 1. get manifest
    const res = await fetch(`/api/get-manifest?key=${manifestKey}`);
    const data = await res.json();

    const chunkKeys: string[] = data.manifest;

    setStatus("Downloading chunks...");

    const buffers: Uint8Array[] = [];

    // 2. download each chunk
    for (const key of chunkKeys) {
      const fileRes = await fetch(`/api/download-chunk?key=${key}`);
      const blob = await fileRes.arrayBuffer();
      buffers.push(new Uint8Array(blob));
    }

    // 3. merge chunks
    const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
    const merged = new Uint8Array(totalLength);

    let offset = 0;
    for (const b of buffers) {
      merged.set(b, offset);
      offset += b.length;
    }

    // 4. download final file
    const url = URL.createObjectURL(new Blob([merged]));
    const a = document.createElement("a");
    a.href = url;
    a.download = "reconstructed-file";
    a.click();

    setStatus("Done!");
  }

  return (
    <div style={{ padding: 40 }}>
      <h2>Rebuild File from Manifest</h2>

      <input
        placeholder="manifest key"
        value={manifestKey}
        onChange={(e) => setManifestKey(e.target.value)}
      />

      <button onClick={rebuildFile}>Rebuild</button>

      <p>{status}</p>
    </div>
  );
}
