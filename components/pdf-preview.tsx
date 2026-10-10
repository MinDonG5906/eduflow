"use client";

import { useEffect, useState } from "react";
import { selectPdfPages } from "@/lib/pdf-source";
import { defaults } from "@/lib/storyboard";

export function PdfPreview({ file, page, label }: { file: Blob; page: number; label: string }) {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setImage(""); setError("");
    void (async () => {
      try {
        const bytes = await selectPdfPages(new Uint8Array(await file.arrayBuffer()), [page]);
        controller.signal.throwIfAborted();
        const form = new FormData();
        form.set("input", JSON.stringify({ manuscript: "", settings: defaults, pdfSource: { name: "preview.pdf", pages: [1] } }));
        form.set("pdf", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), "preview.pdf");
        const response = await fetch("/api/documents/preview", { method: "POST", body: form, signal: controller.signal });
        if (!response.ok) throw new Error("페이지 미리보기를 열지 못했습니다. 페이지 번호로 선택할 수 있습니다.");
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        url = URL.createObjectURL(blob); setImage(url);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "페이지 미리보기를 열지 못했습니다.");
      }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [file, page]);
  return <div className="pdf-preview" aria-busy={!image && !error}>
    {image ? <img src={image} alt={label} /> : <p>{error || "페이지 미리보기 준비 중…"}</p>}
  </div>;
}
