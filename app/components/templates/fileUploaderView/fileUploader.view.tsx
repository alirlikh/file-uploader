"use client";

import { useState } from "react";
import axios from "axios";

export default function FileUploaderView() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [error, setError] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);

  const handleFileChange = (event) => {
    setFile(event.target.files[0]);
  };

  const uploadFile = async () => {
    if (!file) {
      return alert("Please choose a file first.");
    }

    const formData = new FormData();
    formData.append("file", file);

    try {
      setIsUploading(true);
      setError(false);
      setUploadMessage(null);

      const res = await axios.post("/api/upload", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      });

      setUploadMessage(res.data.message);
    } catch (err) {
      setError(true);
      console.error(err);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div>
      <input type="file" onChange={handleFileChange} />
      <button
        className="p-4 bg-amber-400 "
        onClick={uploadFile}
        disabled={isUploading}
      >
        {isUploading ? "Uploading..." : "Upload"}
      </button>

      {uploadMessage && <p>{uploadMessage}</p>}
      {error && <p style={{ color: "red" }}>Error in upload phase!!</p>}
    </div>
  );
}
