import { ArrowDown, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PdfPagePicker } from "@/components/pdf-page-picker";
import { PdfPreview } from "@/components/pdf-preview";
import { MAX_MANUSCRIPT_CHARS, type SourceDocument } from "@/lib/documents";
import type { GeneratorStatus } from "./types";

export function DocumentSource({
  document,
  isPdf,
  documentPending,
  generator,
  disabled,
  pdf,
  onChange,
  onDetach,
  onSelectPages,
  onReupload,
  onFindPart,
  onUseWhole,
}: {
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
  return (
    <div className="document-source">
      <div className="document-source-heading">
        <FileText size={16} />
        <div><strong>{document.name}</strong><small>{isPdf ? `원본 PDF · ${document.pages}페이지 · 표·그림 포함` : `${document.text.length.toLocaleString()}자 읽음`}</small></div>
        <button className="icon-button" aria-label="첨부 문서 해제" disabled={disabled} onClick={onDetach}><X size={15} /></button>
      </div>
      {isPdf ? <>
        {pdf.pickerOpen && pdf.original && document.pages ?
          <PdfPagePicker key={pdf.pickerVersion} file={pdf.original} total={document.pages} initialPages={document.selectedPages ?? []}
            onSelect={onSelectPages} onCancel={() => pdf.setPickerOpen(false)} /> :
          <div className="pdf-selection-summary">
            <strong>{document.selectedPages?.length ? `원본 ${document.selectedPages.join(", ")}페이지 선택됨` : "먼저 AI에 보낼 PDF 페이지를 선택해 주세요."}</strong>
            <Button variant="outline" disabled={disabled} onClick={() => pdf.original ? pdf.setPickerOpen(true) : onReupload()}>{pdf.original ? "페이지 선택" : "원본 PDF 다시 불러오기"}</Button>
            {!pdf.original && <small>선택한 PDF는 브라우저에서 복구됩니다. 페이지를 변경하려면 원본 PDF를 다시 불러와 주세요.</small>}
          </div>}
        {!pdf.pickerOpen && pdf.selected && <><PdfPreview file={pdf.selected} page={1} label={`선택 PDF 첫 페이지 · 원본 ${document.selectedPages?.[0]}페이지`} /><p className="pdf-preview-caption">선택본 첫 페이지 미리보기 · 원본 {document.selectedPages?.[0]}페이지</p></>}
        <label className="form-field" htmlFor="document-request">
          <span>선택한 페이지로 어떤 교육을 만들까요? <small>선택</small></span>
          <Textarea id="document-request" value={document.query} maxLength={500} disabled={disabled}
            onChange={(e) => onChange({ ...document, query: e.target.value })}
            placeholder="예: 산업안전수칙을 중심으로, 표와 그림의 의미를 풀어서 설명해 주세요."
            aria-describedby="document-request-hint" />
        </label>
        <p id="document-request-hint">{generator?.mode === "demo" ? "표·그림을 읽는 PDF 생성에는 실제 AI 연결이 필요합니다. 무료 데모에서는 생성하지 않습니다." : "AI가 선택한 PDF의 글자·표·그림·배치를 읽고 판단합니다. 오른쪽 교육대상·난이도·길이 설정을 함께 적용합니다."}</p>
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
        <p id="document-request-hint">{documentPending ? "요청을 변경했습니다. ‘요청한 부분 찾기’로 원고에 반영해 주세요." : document.appliedQuery ? "찾은 내용이 아래 원고에 반영되었습니다. 확인·수정한 뒤 생성해 주세요." : document.text.length > MAX_MANUSCRIPT_CHARS ? "긴 문서입니다. 제목이나 핵심 단어로 제작 범위를 좁혀 주세요." : "문서 전체를 사용하거나, 제목·핵심 단어로 필요한 부분을 찾을 수 있습니다."}</p>
      </>}
    </div>
  );
}
