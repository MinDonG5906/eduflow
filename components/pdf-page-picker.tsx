"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parsePdfPages, selectPdfPages } from "@/lib/pdf-source";
import { PdfPreview } from "./pdf-preview";

export function PdfPagePicker({ file, total, initialPages, onSelect, onCancel }: {
  file: File; total: number; initialPages: number[];
  onSelect: (file: Blob, pages: number[]) => Promise<void>; onCancel: () => void;
}) {
  const [range, setRange] = useState(initialPages.join(", "));
  const [current, setCurrent] = useState(initialPages[0] ?? 1);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  let pages: number[] = [], rangeError = "";
  try { pages = parsePdfPages(range, total); } catch (e) { rangeError = (e as Error).message; }
  function toggle(page: number) {
    setCurrent(page);
    setError("");
    setRange((pages.includes(page) ? pages.filter((value) => value !== page) : [...pages, page].sort((a, b) => a - b)).join(", "));
  }
  async function apply() {
    setWorking(true); setError("");
    try {
      const bytes = await selectPdfPages(new Uint8Array(await file.arrayBuffer()), pages);
      await onSelect(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), pages);
    } catch (e) { setError(e instanceof Error ? e.message : "PDF 페이지를 준비하지 못했습니다."); }
    finally { setWorking(false); }
  }
  return <section className="pdf-page-picker" aria-label="PDF 페이지 선택" aria-busy={working}>
    <h3>AI에 보낼 페이지를 선택하세요</h3>
    <p>표·그림·배치를 포함한 선택 페이지로 교육을 만듭니다. 페이지를 고르는 동안에는 AI 비용이 발생하지 않습니다.</p>
    <label className="form-field" htmlFor="pdf-page-range"><span>페이지 번호 또는 범위</span>
      <Input id="pdf-page-range" value={range} onChange={(e) => { setRange(e.target.value); setError(""); }} placeholder="예: 3-5, 8" disabled={working} aria-invalid={Boolean(rangeError)} aria-describedby="pdf-range-hint" />
    </label>
    <small id="pdf-range-hint">{rangeError || `총 ${total}페이지 · ${pages.length}페이지 선택 · PDF 파일의 순서 기준입니다.`}</small>
    <div className="pdf-page-grid" role="group" aria-label="보낼 페이지">
      {Array.from({ length: total }, (_, i) => i + 1).map((page) => <button key={page} type="button" aria-label={`${page}페이지`} aria-pressed={pages.includes(page)} disabled={working} onClick={() => toggle(page)}>{page}</button>)}
    </div>
    <PdfPreview file={file} page={current} label={`원본 PDF ${current}페이지 미리보기`} />
    <p className="pdf-preview-caption">원본 {current}페이지 미리보기 · 페이지 번호를 누르면 해당 페이지를 확인할 수 있습니다.</p>
    {error && <p role="alert">{error}</p>}
    <div className="document-source-actions">
      <Button disabled={working || Boolean(rangeError) || !pages.length} onClick={apply}>{working ? "선택 페이지 준비 중…" : `선택한 ${pages.length}페이지 사용`}</Button>
      <Button variant="ghost" disabled={working} onClick={onCancel}>닫기</Button>
    </div>
  </section>;
}
