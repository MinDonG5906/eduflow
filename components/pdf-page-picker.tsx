"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatPdfPages, parsePdfPages, selectPdfPages, type SourceFormat } from "@/lib/pdf-source";
import { PdfPreview } from "./pdf-preview";

export function PdfPagePicker({ file, total, initialPages, format = "PDF", onSelect, onCancel }: {
  file: File; total: number; initialPages: number[];
  format?: SourceFormat;
  onSelect: (file: Blob, pages: number[]) => Promise<void>; onCancel: () => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<"all" | "custom">(!initialPages.length || initialPages.length === total ? "all" : "custom");
  const [range, setRange] = useState(formatPdfPages(initialPages));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const unit = format === "PPT" ? "슬라이드" : "페이지";
  let pages: number[] = [], rangeError = "";
  if (mode === "all") pages = Array.from({ length: total }, (_, i) => i + 1);
  else {
    try { pages = parsePdfPages(range, total); }
    catch (e) { rangeError = (e as Error).message.replaceAll("페이지", unit); }
  }
  function changeRange(value: string) {
    setRange(value); setError("");
  }
  async function apply() {
    if (working || rangeError || !pages.length) return;
    setWorking(true); setError("");
    try {
      const bytes = await selectPdfPages(new Uint8Array(await file.arrayBuffer()), pages);
      await onSelect(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), pages);
    } catch (e) { setError(e instanceof Error ? e.message.replaceAll("페이지", unit) : `${unit}를 준비하지 못했습니다.`); }
    finally { setWorking(false); }
  }
  return <section className="pdf-page-picker" aria-label={`${format} ${unit} 선택`} aria-busy={working}>
    <div className="pdf-picker-heading">
      <h3>사용할 {unit} 선택</h3>
      <span>총 <strong>{total}</strong>{unit}</span>
    </div>
    <div className="pdf-picker-layout">
      <div className="pdf-range-controls">
        <fieldset disabled={working}>
          <legend>사용할 영역</legend>
          <label className="pdf-range-option">
            <input type="radio" name={`${id}-mode`} value="all" checked={mode === "all"} onChange={() => { setMode("all"); setError(""); }} />
            <span>전체 <small>1–{total}{unit}</small></span>
          </label>
          <label className="pdf-range-option">
            <input type="radio" name={`${id}-mode`} value="custom" checked={mode === "custom"} onChange={() => { setMode("custom"); setError(""); }} />
            <span>일부</span>
          </label>
          <div className="pdf-range-input">
            <label className="sr-only" htmlFor={`${id}-range`}>{unit} 번호 또는 범위</label>
            <Input id={`${id}-range`} value={range} onChange={(e) => changeRange(e.target.value)} placeholder="예: 1, 3, 5-7" disabled={mode === "all"} aria-invalid={Boolean(rangeError)} aria-describedby={`${id}-hint`} />
            <p id={`${id}-hint`} className={rangeError ? "invalid" : undefined}>{rangeError || `원본 ${unit} 번호로 입력해 주세요.`}</p>
          </div>
        </fieldset>
        <p className="pdf-range-count" role="status">{pages.length ? <><strong>{pages.length}{unit}</strong> 사용 예정</> : "사용할 범위를 입력해 주세요."}</p>
        <div className="document-source-actions">
          <Button disabled={working || Boolean(rangeError) || !pages.length} onClick={apply}>{working ? "선택 영역 준비 중…" : "이 영역 사용"}</Button>
          <Button variant="ghost" disabled={working} onClick={onCancel}>닫기</Button>
        </div>
        <p className="pdf-picker-note">선택한 부분의 글자·표·그림을 AI에 보냅니다. 범위를 고르는 동안에는 AI 비용이 발생하지 않습니다.</p>
      </div>
      <div className="pdf-picker-preview">
        <PdfPreview file={file} total={total} selectedPages={pages} format={format} initialPage={initialPages[0] ?? 1} />
      </div>
    </div>
    {format === "PPT" && <p className="pdf-picker-note">PDF로 변환한 미리보기입니다. 글꼴·배치를 확인해 주세요. 숨긴 슬라이드도 포함하며, 발표자 노트·동영상·애니메이션은 전달하지 않습니다.</p>}
    {(format === "HWP" || format === "HWPX") && <p className="pdf-picker-note">변환된 페이지 기준입니다. 원본과 글꼴·표·그림·쪽 나눔을 확인한 뒤 사용할 범위를 선택해 주세요.</p>}
    {error && <p role="alert" className="invalid">{error}</p>}
  </section>;
}
