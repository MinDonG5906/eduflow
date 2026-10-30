import { AlertCircle, BookOpen, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, FileText, Film, LayoutGrid, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Board } from "@/lib/storyboard";
import type { ExportFormat, GeneratorStatus, StudioModal } from "./types";

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  if (!message) return null;
  return (
    <div className="toast-message" role="status">
      <CheckCircle2 size={17} />
      {message}
      <button aria-label="알림 닫기" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

export function ProgressDialog({
  open,
  progress,
  generator,
  onCancel,
}: {
  open: boolean;
  progress: number;
  generator: GeneratorStatus;
  onCancel: () => void;
}) {
  const ai = generator?.mode === "ai";
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="progress-dialog">
        <DialogHeader>
          <div className="loading-icon">
            <Sparkles size={26} />
          </div>
          <DialogTitle>원고가 장면으로 바뀌는 중이에요</DialogTitle>
          <DialogDescription>
            입력한 원고에서 핵심 내용을 나누고 초안을 구성합니다.
          </DialogDescription>
        </DialogHeader>
        <div className={`progress-track ${ai ? "ai-pending" : ""}`}>
          <div style={{ width: `${progress}%` }} />
        </div>
        <div className="progress-label">
          <span>
            {ai ? "AI 응답을 기다린 뒤 필수 항목과 원문 근거를 확인합니다" : progress < 35
              ? "원고의 흐름을 살펴보고 있어요"
              : progress < 70
                ? "장면별 내용을 구성하고 있어요"
                : "원문 근거와 필수 항목을 확인하고 있어요"}
          </span>
          <span>{ai ? "생성 대기 중" : `${progress}%`}</span>
        </div>
        <p>{ai ? `${generator?.label}로 생성 중 · 최대 90초 · 취소해도 이미 시작한 호출은 비용이나 플랜 사용량에 반영될 수 있습니다` : "원문 발췌 데모 · 외부 AI 전송 없음"}</p>
        <Button variant="ghost" onClick={onCancel}>
          생성 취소
        </Button>
      </DialogContent>
    </Dialog>
  );
}

const modalText = {
  new: { title: "새로운 이야기를 시작할까요?", description: "현재 브라우저에 저장된 원고와 스토리보드가 초기화됩니다. 필요한 결과는 먼저 내보내 주세요." },
  delete: { title: "이 장면을 삭제할까요?", description: "선택한 장면과 수정 내용이 삭제됩니다. 이 작업은 되돌릴 수 없습니다." },
  regenerate: { title: "이 장면을 새롭게 구성합니다", description: "선택한 장면의 모든 내용을 새 초안으로 교체합니다. 다른 장면의 수정 내용은 유지됩니다." },
  export: { title: "다음 제작 단계로, 내보내기", description: "수정한 최신 내용과 현재 장면 순서가 그대로 담깁니다." },
  help: { title: "EduFlow 사용 가이드", description: "원고에서 시작해 제작 가능한 스토리보드로 정리해 보세요." },
} as const;

export function StudioDialog({
  modal,
  onClose,
  board,
  reviewCount,
  generator,
  canGenerate,
  filename,
  onFilenameChange,
  onExport,
  direction,
  onDirectionChange,
  isPdf,
  citedPage,
  documentUnit,
  sceneSourceScope,
  onSceneSourceScopeChange,
  onRegenerate,
  onReset,
  onRemoveScene,
}: {
  modal: StudioModal;
  onClose: () => void;
  board: Board | null;
  reviewCount: number;
  generator: GeneratorStatus;
  canGenerate: boolean;
  filename: string;
  onFilenameChange: (value: string) => void;
  onExport: (format: ExportFormat) => void;
  direction: string;
  onDirectionChange: (value: string) => void;
  isPdf: boolean;
  citedPage: number | null;
  documentUnit: string;
  sceneSourceScope: "citation" | "selection";
  onSceneSourceScopeChange: (value: "citation" | "selection") => void;
  onRegenerate: () => void;
  onReset: () => void;
  onRemoveScene: () => void;
}) {
  // Text for the closing animation falls back to the help copy, as before.
  const text = modalText[modal ?? "help"];
  return (
    <Dialog
      open={modal !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={modal === "export" ? "export-dialog" : ""}>
        <DialogHeader>
          <div className="modal-icon">
            {modal === "export" ? (
              <Download size={22} />
            ) : modal === "regenerate" ? (
              <Sparkles size={22} />
            ) : modal === "help" ? (
              <BookOpen size={22} />
            ) : (
              <AlertCircle size={22} />
            )}
          </div>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        {modal === "export" && board && (
          <ExportOptions
            board={board}
            reviewCount={reviewCount}
            filename={filename}
            onFilenameChange={onFilenameChange}
            onExport={onExport}
          />
        )}
        {modal === "regenerate" && (
          <>
            {isPdf && (
              <label className="form-field">
                다시 참고할 자료
                <div className="select-wrap">
                  <select value={citedPage === null ? "selection" : sceneSourceScope}
                    onChange={(e) => onSceneSourceScopeChange(e.target.value as "citation" | "selection")}>
                    {citedPage !== null && <option value="citation">기존 출처 {citedPage}{documentUnit}만</option>}
                    <option value="selection">선택 자료 전체</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
                <small>{citedPage === null ? "현재 선택 자료에서 기존 출처를 확인할 수 없어 전체를 참고합니다." : "다른 페이지의 내용으로 바꾸려면 ‘선택 자료 전체’를 선택하세요."}</small>
              </label>
            )}
            <label className="form-field">
              어떻게 바꿀까요?{" "}
              <Textarea
                value={direction}
                maxLength={300}
                onChange={(e) => onDirectionChange(e.target.value)}
                placeholder="예: 핵심 개념을 더 크게 강조해 주세요."
              />
              <small>{direction.length} / 300자 · {generator?.mode === "ai" ? "AI 재생성에 반영됩니다." : "데모에서는 제작 메모로 반영됩니다."}</small>
            </label>
            <div className="modal-actions">
              <Button variant="outline" onClick={onClose}>
                취소
              </Button>
              <Button disabled={!canGenerate} onClick={onRegenerate}>
                <Sparkles size={15} /> 교체하고 재생성
              </Button>
            </div>
          </>
        )}
        {(modal === "new" || modal === "delete") && (
          <div className="modal-actions">
            <Button variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button variant="destructive" onClick={modal === "new" ? onReset : onRemoveScene}>
              {modal === "new" ? "초기화하고 시작" : "장면 삭제"}
            </Button>
          </div>
        )}
        {modal === "help" && <HelpContent generator={generator} />}
      </DialogContent>
    </Dialog>
  );
}

function ExportOptions({
  board,
  reviewCount,
  filename,
  onFilenameChange,
  onExport,
}: {
  board: Board;
  reviewCount: number;
  filename: string;
  onFilenameChange: (value: string) => void;
  onExport: (format: ExportFormat) => void;
}) {
  return (
    <>
      <div className="export-summary">
        <Film size={19} />
        <span>{board.title}</span>
        <small>{board.scenes.length}개 장면</small>
      </div>
      <label className="form-field">
        파일명
        <Input
          value={filename}
          onChange={(e) => onFilenameChange(e.target.value)}
          maxLength={100}
        />
      </label>
      <div className="export-options">
        <button onClick={() => onExport("pdf")}>
          <div>
            <FileText size={22} />
          </div>
          <span>
            <strong>PDF 스토리보드</strong>
            <small>영상 제작자용 A4 가로 인쇄 및 문서</small>
          </span>
          <Download size={17} />
        </button>
        <button onClick={() => onExport("md")}>
          <div>
            <FileText size={22} />
          </div>
          <span>
            <strong>Markdown</strong>
            <small>문서로 정리하고 자유롭게 편집</small>
          </span>
          <Download size={17} />
        </button>
        <button onClick={() => onExport("csv")}>
          <div>
            <LayoutGrid size={22} />
          </div>
          <span>
            <strong>CSV 스프레드시트</strong>
            <small>Excel · Google Sheets에서 활용</small>
          </span>
          <Download size={17} />
        </button>
        <button onClick={() => onExport("copy")}>
          <div>
            <Copy size={22} />
          </div>
          <span>
            <strong>전체 내용 복사</strong>
            <small>Markdown 형식으로 클립보드에 복사</small>
          </span>
          <ChevronRight size={17} />
        </button>
      </div>
      <p className="export-note">
        <AlertCircle size={14} />
        검토 필요 장면 {reviewCount}개가 포함됩니다.
      </p>
    </>
  );
}

function HelpContent({ generator }: { generator: GeneratorStatus }) {
  return (
    <div className="help-content">
      <ol>
        <li>
          <strong>원고를 준비하세요</strong>
          <p>
            PDF·PPT·HWP/HWPX를 불러오면 AI에 보낼 페이지·슬라이드를 먼저 선택합니다. PPT와 한글 파일은 이 PC에서 PDF로 변환하며, 미리보기에서 글꼴·배치를 확인해 주세요. 선택한 부분의 표·그림으로 생성하며 별도 원고는 필수가 아닙니다. Word(.docx)·TXT 또는 직접 입력 원고는 공백 제외 100자 이상 준비해 주세요.
          </p>
        </li>
        <li>
          <strong>학습 대상과 조건을 정하세요</strong>
          <p>대상, 난이도, 길이, 장면 수를 선택해 초안을 생성하세요.</p>
        </li>
        <li>
          <strong>장면을 검토하고 다듬으세요</strong>
          <p>
            모든 필드를 수정하고, 장면을 추가·삭제·이동할 수 있어요. 원문 근거를 확인한 뒤
            검토 완료로 표시하세요.
          </p>
        </li>
        <li>
          <strong>제작을 위해 내보내세요</strong>
          <p>Markdown 또는 CSV로 내려받거나 전체 내용을 복사하세요.</p>
        </li>
      </ol>
      <div className="help-demo">
        <Sparkles size={16} />
        <p>
          {generator?.mode === "ai"
            ? `${generator.label}로 초안을 생성합니다. 원고·설정·선택 장면·추가 지시가 ${generator.vendor}에 전송되며, 생성 결과는 현재 브라우저에 저장합니다. AI 결과는 원문과 대조한 뒤 사용해 주세요.`
            : "원문 발췌 데모입니다. 추가 지시는 제작 메모로 반영됩니다. 원고는 로컬 서버에서 처리하고 현재 브라우저에 저장합니다."}
        </p>
      </div>
    </div>
  );
}
