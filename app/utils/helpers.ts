export const fmt = (b: number) =>
  b >= 1e12
    ? `${(b / 1e12).toFixed(2)} TB`
    : b >= 1e9
      ? `${(b / 1e9).toFixed(2)} GB`
      : b >= 1e6
        ? `${(b / 1e6).toFixed(2)} MB`
        : b >= 1e3
          ? `${(b / 1e3).toFixed(1)} KB`
          : `${b} B`;

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const dlText = (txt: string, name: string) => {
  const b = new Blob([txt], { type: "text/plain" });
  const u = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  URL.revokeObjectURL(u);
};

export function inferExt(name: string): string {
  const s = name
    .replace(/[._-](part|chunk|p|c)\d+$/i, "")
    .replace(/\.\d+$/, "");
  const d = s.lastIndexOf(".");
  return d > 0 ? s.slice(d) : "";
}

export function urlFilename(url: string): string {
  try {
    const u = new URL(url);
    const qf = u.searchParams.get("filename");
    if (qf) {
      const m = qf.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
      if (m) return decodeURIComponent(m[1].replace(/['"]/g, "").trim());
      return decodeURIComponent(qf);
    }
    return decodeURIComponent(
      u.pathname.split("/").filter(Boolean).pop() ?? "",
    );
  } catch {
    return "";
  }
}

/** Generate a QR code URL using the free qrserver API. */
export function qrUrl(data: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data)}`;
}

export function copyToClipboard(text: string, setCopied: (v: boolean) => void) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });
}
