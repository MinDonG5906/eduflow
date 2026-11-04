import type { ReactNode, RefObject } from "react";
import { FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ManuscriptPanel({
  manuscript, isPdf, valid, busy, importing, storageBlocked, uploadRef,
  onImport, onCancelImport, documentSource, generationAction,
}: {
  manuscript: string;
  isPdf: boolean;
  valid: boolean;
  busy: boolean;
  importing: boolean;
  storageBlocked: boolean;
  uploadRef: RefObject<HTMLInputElement | null>;
  onImport: (file?: File) => void;
  onCancelImport: () => void;
  documentSource: ReactNode;
  generationAction?: ReactNode;
}) {
  const disabled = busy || importing || storageBlocked;
  return <section className="manuscript-panel panel"
    onDragOver={event => event.preventDefault()}
    onDrop={event => {
      event.preventDefault();
      if (!disabled) onImport(event.dataTransfer.files[0]);
    }}>
    <div className="panel-title">
      <div><span className="section-icon"><FileText size={18} /></span><h2>교육원문 파일</h2></div>
      {documentSource && <Button variant="outline" disabled={disabled} onClick={() => uploadRef.current?.click()}>
        <Upload size={15} /> 파일 변경
      </Button>}
    </div>
    <input ref={uploadRef} type="file"
      accept=".txt,.pdf,.ppt,.pptx,.hwp,.hwpx,.docx,application/x-hwp,application/haansofthwp,application/hwp+zip,text/plain,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      className="sr-only" aria-label="PDF, PPT, 한글, Word, TXT 원고 불러오기"
      disabled={disabled} onChange={event => onImport(event.target.files?.[0])} />
    {!documentSource && <button className="manuscript-file-drop" disabled={disabled} onClick={() => uploadRef.current?.click()}>
      <Upload size={28} aria-hidden="true" />
      <strong>{importing ? "파일을 불러오는 중…" : "파일 불러오기"}</strong>
      <span>PDF · PPT · 한글 · Word · TXT</span>
    </button>}
    {importing && <div className="manuscript-import-status" role="status">
      <span>파일을 읽고 있습니다.</span><Button variant="outline" onClick={onCancelImport}>불러오기 취소</Button>
    </div>}
    {documentSource && <div className="manuscript-document-content">{documentSource}</div>}
    {!isPdf && manuscript && <details className="manuscript-file-preview">
      <summary>{documentSource ? "불러온 원문 확인" : "이전에 저장한 원문 확인"}</summary>
      <pre>{manuscript}</pre>
    </details>}
    {documentSource && !isPdf && !valid && <p className="manuscript-file-error" role="status">
      {manuscript.length > 20000 ? "원문이 20,000자를 넘었습니다. 제작할 부분을 선택해 주세요." : "100자 이상의 교육 내용이 필요합니다. 문서 전체를 사용하거나 다른 부분을 선택해 주세요."}
    </p>}
    {documentSource && generationAction}
  </section>;
}
