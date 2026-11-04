import type { ReactNode } from "react";
import { ArrowDown, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PdfPagePicker } from "@/components/pdf-page-picker";
import { PdfPreview } from "@/components/pdf-preview";
import { MAX_MANUSCRIPT_CHARS, type SourceDocument } from "@/lib/documents";
import { formatPdfPages, sourceFormat, sourceUnit } from "@/lib/pdf-source";
import type { GeneratorStatus } from "./types";

export function DocumentSource({
  document,
  isPdf,
  documentPending,
  disabled,
  pdf,
  onChange,
  onDetach,
  onSelectPages,
  onReupload,
  onFindPart,
  onUseWhole,
  generationAction,
}: {
  generationAction?: ReactNode;
  document: SourceDocument;
  isPdf: boolean;
  documentPending: boolean;
  generator: GeneratorStatus;
  disabled: boolean;
  pdf: {
    original: File | null;
    selected: Blob | null;
    pickerOpen: boolean;
    pickerVersion: number;
    setPickerOpen: (open: boolean) => void;
  };
  onChange: (document: SourceDocument) => void;
  onDetach: () => void;
  onSelectPages: (blob: Blob, pages: number[]) => Promise<void>;
  onReupload: () => void;
  onFindPart: () => void;
  onUseWhole: () => void;
}) {
  const unit = sourceUnit(document.name);
  const format = sourceFormat(document.name);
  return (
    <div className="document-source">
      <div className="document-source-heading">
        <FileText size={16} />
        <div><strong>{document.name}</strong><small>{isPdf ? `원본 ${format} · ${document.pages}${unit} · 표·그림 포함` : `${document.text.length.toLocaleString()}자 읽음`}</small></div>
        <button className="icon-button" aria-label="첨부 문서 해제" disabled={disabled} onClick={onDetach}><X size={15} /></button>
      </div>
      {isPdf ? <>
        {pdf.pickerOpen && pdf.original && document.pages ?
          <PdfPagePicker key={pdf.pickerVersion} file={pdf.original} total={document.pages} initialPages={document.selectedPages ?? []} format={format}
            onSelect={onSelectPages} onCancel={() => pdf.setPickerOpen(false)} /> :
          <div className="pdf-selection-summary">
            <strong>{document.selectedPages?.length ? document.selectedPages.length === document.pages ? `전체 ${document.pages}${unit} 선택됨` : `원본 ${formatPdfPages(document.selectedPages)}${unit} 선택됨` : `먼저 AI에 보낼 ${format} ${unit}를 선택해 주세요.`}</strong>
            <Button variant="outline" disabled={disabled} onClick={() => pdf.original ? pdf.setPickerOpen(true) : onReupload()}>{pdf.original ? `${unit} 선택` : `원본 ${format} 다시 불러오기`}</Button>
            {!pdf.original && <small>선택본은 브라우저에서 복구됩니다. {unit}를 변경하려면 원본 {format}를 다시 불러와 주세요.</small>}
          </div>}
        {!pdf.pickerOpen && pdf.selected && <PdfPreview file={pdf.selected} total={document.selectedPages?.length ?? 0} originalPages={document.selectedPages} format={format} />}
        <label className="document-request-label" htmlFor="document-request">
          <span>선택한 {unit}로 어떤 교육을 만들까요?</span>
        </label>
        <div className="document-request-composer">
          <Textarea id="document-request" rows={2} value={document.query} maxLength={500} disabled={disabled}
            onChange={(e) => onChange({ ...document, query: e.target.value })} />
          {generationAction}
        </div>
      </> : <>
        <label className="form-field" htmlFor="document-request">
          <span>문서에서 어떤 부분을 제작할까요?</span>
          <Textarea id="document-request" value={document.query} maxLength={500} disabled={disabled}
            onChange={(e) => onChange({ ...document, query: e.target.value })}
            placeholder="예: 올려둔 PDF 파일에서 산업안전수칙 부분을 제작하고 싶어"
            aria-describedby="document-request-hint" />
        </label>
        <div className="document-source-actions">
          <Button variant="outline" disabled={disabled || !document.query.trim()} onClick={onFindPart}>요청한 부분 찾기 <ArrowDown size={14} /></Button>
          {document.text.length <= MAX_MANUSCRIPT_CHARS && <button disabled={disabled} onClick={onUseWhole}>문서 전체 사용</button>}
        </div>
        <p id="document-request-hint">{documentPending ? "요청을 변경했습니다. ‘요청한 부분 찾기’로 원고에 반영해 주세요." : document.appliedQuery ? "찾은 내용이 아래 원고에 반영되었습니다. 확인한 뒤 생성해 주세요." : document.text.length > MAX_MANUSCRIPT_CHARS ? "긴 문서입니다. 제목이나 핵심 단어로 제작 범위를 좁혀 주세요." : "문서 전체를 사용하거나, 제목·핵심 단어로 필요한 부분을 찾을 수 있습니다."}</p>
      </>}
    </div>
  );
}
