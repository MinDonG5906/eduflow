export function exportFilename(name: string, extension: string): string {
  return `${name.trim().replace(/[\\/:*?"<>|]/g, "_") || "스토리보드"}.${extension}`;
}

// Browser only. Throws if the browser blocks object URLs or downloads.
export function downloadText(content: string, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
