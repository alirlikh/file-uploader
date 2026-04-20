"use client";

import { useSearchParams } from "next/navigation";

const FileDownloaderView = () => {
  const searchParams = useSearchParams();
  const sp = new URLSearchParams(searchParams);

  const downloadFile = async () => {
    const res = await fetch(`${"/api/download-chunk?" + sp}`, {
      method: "get",
    });
    // const data = await res.json();

    console.log(res);
  };
  return (
    <div className="text-black bg-amber-400">
      <button onClick={downloadFile}>download</button>
    </div>
  );
};
export default FileDownloaderView;
