import type { ReactNode, RefObject } from "react";
import { BookOpen, FileText, Lightbulb, PencilLine, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ManuscriptPanel({
  manuscript,
  onManuscriptChange,
  isPdf,
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
          <span className="section-icon">
            <FileText size={18} />
          </span>
          <h2>원고 입력</h2>
          <span className="required">필수</span>
        </div>
        <Button
          variant="ghost"
          className="sample-button"
          onClick={onLoadSample}
          disabled={busy || importing || storageBlocked}
        >
          <BookOpen size={15} /> 샘플 원고 사용
        </Button>
      </div>
      <div className="manuscript-tabs">
        <span>
          <PencilLine size={14} /> 직접 입력
        </span>
        <button onClick={() => uploadRef.current?.click()} disabled={busy || importing || storageBlocked}>
          <Upload size={14} /> {importing ? "문서 읽는 중…" : "파일 불러오기"}
        </button>
        {importing && <button onClick={onCancelImport}>불러오기 취소</button>}
        <input
          ref={uploadRef}
          type="file"
          accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="sr-only"
          aria-label="PDF, Word, TXT 원고 불러오기"
          disabled={busy || importing || storageBlocked}
          onChange={(e) => onImport(e.target.files?.[0])}
        />
      </div>
      <p className="file-formats" role="status">PDF · Word(.docx) · TXT · 파일 용량 제한 없음 {importing && "· 큰 문서는 읽는 데 시간이 걸릴 수 있습니다."}</p>
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
          {isPdf ? "PDF에 덧붙일 설명 (선택)" : "교육 원고"}
        </label>
        <textarea
          id="manuscript"
          aria-describedby="manuscript-hint"
          aria-invalid={Boolean(manuscript) && (manuscript.length > 20000 || (!isPdf && !valid))}
          value={manuscript}
          onChange={(e) => onManuscriptChange(e.target.value)}
          disabled={busy || importing || storageBlocked}
          placeholder={
            isPdf ? "PDF에 덧붙일 설명이 있다면 입력해 주세요.\n선택한 PDF 페이지를 직접 읽으므로 별도로 원고를 붙여 넣지 않아도 됩니다." : "어떤 이야기를 전하고 싶으신가요?\n\n교육 원고를 입력하거나, 준비한 내용을 붙여 넣어 주세요.\n학습자가 꼭 알아야 할 핵심 개념과 설명이 담겨 있으면 좋아요."
          }
        />
        {!manuscript && !isPdf && (
          <div className="editor-empty">
            <div className="empty-illustration">
              <div />
              <FileText size={29} />
              <span>
                <Plus size={13} />
              </span>
            </div>
            <p>아이디어가 장면이 되는 곳</p>
            <small>원고를 작성하거나 PDF·Word·TXT 파일을 여기에 놓아 주세요.</small>
          </div>
        )}
      </div>
      <div className="editor-footer">
        <span id="manuscript-hint" className={manuscript.length > 20000 ? "invalid" : ""}>
          {manuscript.length > 20000
            ? `${(manuscript.length - 20000).toLocaleString()}자 초과`
            : isPdf ? "PDF에 덧붙일 설명 · 선택 입력"
            : manuscript && !valid
              ? "공백 제외 100자 이상 입력해 주세요"
              : "공백 제외 최소 100자 · PDF·Word·TXT 지원"}
        </span>
        <span>
          <strong>{manuscript.length.toLocaleString()}</strong> / 20,000자
        </span>
      </div>
      <div className="writing-tip">
        <Lightbulb size={16} />
        <div>
          <strong>이런 원고일수록 더 좋아요</strong>
          <p>
            주제와 학습 목표가 분명하고, 핵심 개념과 사례가 순서대로 정리된 원고를
            준비해 주세요.
          </p>
        </div>
      </div>
    </section>
  );
}
