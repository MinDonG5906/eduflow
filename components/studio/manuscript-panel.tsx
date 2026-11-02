import type { ReactNode, RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { SourceFormat } from "@/lib/pdf-source";

export function ManuscriptPanel({
  manuscript,
  onManuscriptChange,
  isPdf,
  documentFormat,
  documentUnit,
  valid,
  busy,
  importing,
  storageBlocked,
  uploadRef,
  onLoadSample,
  onImport,
  onCancelImport,
  documentSource,
}: {
  manuscript: string;
  onManuscriptChange: (value: string) => void;
  isPdf: boolean;
  documentFormat: SourceFormat;
  documentUnit: string;
  valid: boolean;
  busy: boolean;
  importing: boolean;
  storageBlocked: boolean;
  uploadRef: RefObject<HTMLInputElement | null>;
  onLoadSample: () => void;
  onImport: (file?: File) => void;
  onCancelImport: () => void;
  // The attached document block, rendered between the file controls and the editor.
  documentSource: ReactNode;
}) {
  return (
    <section className="manuscript-panel panel">
      <div className="panel-title">
        <div>
          <h2>원고 입력</h2>
          <span className="required">필수</span>
        </div>
        <Button
          variant="ghost"
          className="sample-button"
          onClick={onLoadSample}
          disabled={busy || importing || storageBlocked}
        >
          샘플 원고 사용
        </Button>
      </div>
      <div className="manuscript-tabs">
        <span>
          직접 입력
        </span>
        <button onClick={() => uploadRef.current?.click()} disabled={busy || importing || storageBlocked}>
          {importing ? "문서 읽는 중…" : "파일 불러오기"}
        </button>
        {importing && <button onClick={onCancelImport}>불러오기 취소</button>}
        <input
          ref={uploadRef}
          type="file"
          accept=".txt,.pdf,.ppt,.pptx,.hwp,.hwpx,.docx,application/x-hwp,application/haansofthwp,application/hwp+zip,text/plain,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="sr-only"
          aria-label="PDF, PPT, 한글, Word, TXT 원고 불러오기"
          disabled={busy || importing || storageBlocked}
          onChange={(e) => onImport(e.target.files?.[0])}
        />
      </div>
      <p className="file-formats" role="status">PDF · PPT/PPTX · HWP/HWPX · Word(.docx) · TXT{importing && " · 문서 변환과 큰 문서 읽기는 시간이 걸릴 수 있습니다."}</p>
      {documentSource}
      <div
        className="manuscript-editor"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy && !importing) onImport(e.dataTransfer.files[0]);
        }}
      >
        <label className="sr-only" htmlFor="manuscript">
          {isPdf ? `${documentFormat}에 덧붙일 설명 (선택)` : "교육 원고"}
        </label>
        <textarea
          id="manuscript"
          aria-describedby="manuscript-hint"
          aria-invalid={Boolean(manuscript) && (manuscript.length > 20000 || (!isPdf && !valid))}
          value={manuscript}
          onChange={(e) => onManuscriptChange(e.target.value)}
          disabled={busy || importing || storageBlocked}
          placeholder={
            isPdf ? `${documentFormat}에 덧붙일 설명이 있다면 입력해 주세요.\n선택한 ${documentUnit}를 직접 읽으므로 별도로 원고를 붙여 넣지 않아도 됩니다.` : "교육 원고를 입력하거나 붙여 넣어 주세요."
          }
        />
        {!manuscript && !isPdf && (
          <div className="editor-empty">
            <small>파일을 여기에 놓아도 됩니다.</small>
          </div>
        )}
      </div>
      <div className="editor-footer">
        <span id="manuscript-hint" className={manuscript.length > 20000 ? "invalid" : ""}>
          {manuscript.length > 20000
            ? `${(manuscript.length - 20000).toLocaleString()}자 초과`
            : isPdf ? `${documentFormat}에 덧붙일 설명 · 선택 입력`
            : manuscript && !valid
              ? "공백 제외 100자 이상 입력해 주세요"
              : "공백 제외 최소 100자"}
        </span>
        <span>
          <strong>{manuscript.length.toLocaleString()}</strong> / 20,000자
        </span>
      </div>
    </section>
  );
}
