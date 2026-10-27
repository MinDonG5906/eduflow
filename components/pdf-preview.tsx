"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_AI_PDF_BYTES, type SourceFormat } from "@/lib/pdf-source";
import { defaults } from "@/lib/storyboard";
import type { SourceBox } from "@/lib/source-location";

export function PdfPreview({ file, total, selectedPages, originalPages, format = "PDF", initialPage = 1, highlightBoxes, evidenceMode = false }: {
  file: Blob; total: number; selectedPages?: number[]; originalPages?: number[];
  format?: SourceFormat; initialPage?: number; highlightBoxes?: SourceBox[]; evidenceMode?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [ratios, setRatios] = useState<number[]>([]);
  const [documentError, setDocumentError] = useState("");
  const unit = format === "PPT" ? "슬라이드" : "페이지";
  const selected = selectedPages ? new Set(selectedPages) : undefined;

  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const controller = new AbortController();
    const wanted = new Set<number>();
    const cache = new Map<number, string>();
    const failed = new Set<number>();
    let running = false;
    setImages({}); setErrors({}); setRatios([]); setDocumentError("");
    root.scrollTop = 0;

    // Parse the original once. Each local rendering request contains just one page.
    const sourceReady = (async () => {
      const { PDFDocument } = await import("pdf-lib");
      controller.signal.throwIfAborted();
      const source = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
      controller.signal.throwIfAborted();
      return { source, PDFDocument };
    })();
    void sourceReady.then(({ source }) => {
      if (controller.signal.aborted) return;
      setRatios(source.getPages().map((page) => {
        const { width, height } = page.getCropBox();
        const rotated = Math.abs(page.getRotation().angle % 180) === 90;
        const ratio = rotated ? height / width : width / height;
        return Number.isFinite(ratio) && ratio > 0 ? evidenceMode ? ratio : Math.max(0.5, Math.min(2, ratio)) : 1;
      }));
    }).catch(() => {
      if (!controller.signal.aborted) setDocumentError("미리보기를 열지 못했습니다. 범위 입력은 계속 사용할 수 있습니다.");
    });

    async function render(page: number) {
      const { source, PDFDocument } = await sourceReady;
      controller.signal.throwIfAborted();
      const single = await PDFDocument.create();
      const [copied] = await single.copyPages(source, [page - 1]);
      single.addPage(copied);
      const bytes = await single.save({ useObjectStreams: false });
      controller.signal.throwIfAborted();
      if (bytes.length >= MAX_AI_PDF_BYTES) throw new Error("Preview too large");
      const form = new FormData();
      form.set("input", JSON.stringify({ manuscript: "", settings: defaults, pdfSource: { name: "preview.pdf", pages: [1] } }));
      form.set("pdf", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), "preview.pdf");
      const response = await fetch("/api/documents/preview", {
        method: "POST", body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok) throw new Error("Preview unavailable");
      const blob = await response.blob();
      controller.signal.throwIfAborted();
      return URL.createObjectURL(blob);
    }
    async function pump() {
      if (running) return;
      running = true;
      try {
        while (!controller.signal.aborted) {
          const page = [...wanted].find((value) => !cache.has(value) && !failed.has(value));
          if (page === undefined) break;
          try {
            const url = await render(page);
            if (controller.signal.aborted) { URL.revokeObjectURL(url); return; }
            cache.set(page, url);
            // Keep nearby images; release old ones rather than retaining a whole deck.
            for (const [oldPage, oldUrl] of cache) {
              if (cache.size <= 12) break;
              if (!wanted.has(oldPage)) { URL.revokeObjectURL(oldUrl); cache.delete(oldPage); }
            }
            setImages(Object.fromEntries(cache));
          } catch {
            if (controller.signal.aborted) return;
            failed.add(page);
            setErrors((previous) => ({ ...previous, [page]: "미리보기를 불러오지 못했습니다." }));
          }
        }
      } finally { running = false; }
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.previewPage);
        if (entry.isIntersecting) wanted.add(page);
        else wanted.delete(page);
      }
      void pump();
    }, { root, rootMargin: "200px 0px" });
    root.querySelectorAll("[data-preview-page]").forEach((page) => observer.observe(page));
    return () => {
      controller.abort(); observer.disconnect();
      for (const url of cache.values()) URL.revokeObjectURL(url);
    };
  }, [file, total, evidenceMode]);

  useEffect(() => {
    if (!ratios.length || !viewport.current) return;
    const page = viewport.current.querySelector<HTMLElement>(`[data-preview-page="${initialPage}"]`);
    if (page) viewport.current.scrollTop = page.offsetTop - 8;
  }, [ratios, initialPage]);

  useEffect(() => {
    if (!evidenceMode || !highlightBoxes?.length || !images[1] || !viewport.current) return;
    const image = viewport.current.querySelector<HTMLElement>(".pdf-scroll-image");
    if (image) viewport.current.scrollTop = image.offsetTop + highlightBoxes[0][1] * image.offsetHeight - 80;
  }, [images, highlightBoxes, evidenceMode]);

  return <div className="pdf-scroll-preview">
    {!evidenceMode && <p className="pdf-scroll-hint">마우스 휠로 {unit}를 내려보세요.</p>}
    <div ref={viewport} className="pdf-scroll-viewport" role="region" aria-label={`${format} ${unit} 미리보기 목록`} tabIndex={0}>
      {Array.from({ length: total }, (_, i) => i + 1).map((page) => {
        const original = originalPages?.[page - 1] ?? page;
        const included = !selected || selected.has(page);
        return <figure key={page} data-preview-page={page} className={included ? "pdf-scroll-page is-selected" : "pdf-scroll-page"}>
          <div className="pdf-scroll-image" style={{ aspectRatio: ratios[page - 1] ?? (format === "PPT" ? 16 / 9 : 1 / Math.SQRT2) }} aria-busy={!images[page] && !errors[page] && !documentError}>
            {images[page] ? <><img src={images[page]} alt={`원본 ${format} ${original}${unit} 미리보기`} />
              {highlightBoxes?.map((box, index) => <span key={index} className="source-box" aria-hidden="true" style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` }} />)}
            </> : <p>{documentError || errors[page] || "미리보기 준비 중…"}</p>}
          </div>
          <figcaption><span>원본 {original}{unit}</span>{included && !evidenceMode && <small>사용 예정</small>}{evidenceMode && Boolean(highlightBoxes?.length) && <small>일치 구절 강조</small>}</figcaption>
        </figure>;
      })}
    </div>
  </div>;
}
