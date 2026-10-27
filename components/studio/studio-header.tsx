import { AlertCircle, Check, ChevronRight, CloudCheck, PanelLeftClose, PlugZap, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GeneratorStatus, StudioView } from "./types";

export function StudioTopbar({
  view,
  saved,
  generator,
  sidebarOpen,
  onToggleSidebar,
  onOpenConnection,
}: {
  view: StudioView;
  saved: string;
  generator: GeneratorStatus;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenConnection: () => void;
}) {
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <button
          className="mobile-menu"
          aria-label="메뉴 열기"
          aria-expanded={sidebarOpen}
          aria-controls="studio-navigation"
          onClick={onToggleSidebar}
        >
          <PanelLeftClose size={20} />
        </button>
        <b className="mobile-brand">EduFlow</b>
        <span>워크스페이스</span>
        <ChevronRight size={14} />
        <strong>{view === "input" ? "새 스토리보드" : "스토리보드 편집"}</strong>
      </div>
      <div className="topbar-right">
        <span className="save-state">
          <CloudCheck size={16} />
          {saved}
        </span>
        <button className={`demo-badge connection-badge ${generator?.mode === "ai" && !generator.available ? "needs-setup" : ""}`}
          aria-label="모델 연결 설정 열기" onClick={onOpenConnection}>
          <PlugZap size={12} />
          {generator ? (generator.mode === "ai" && !generator.available ? `${generator.label} · 설정 필요` : generator.label) : "연결 확인 중"}
        </button>
      </div>
    </header>
  );
}

export function StudioStepper({
  view,
  busy,
  hasBoard,
  onNavigate,
  onExport,
}: {
  view: StudioView;
  busy: boolean;
  hasBoard: boolean;
  onNavigate: (view: StudioView) => void;
  onExport: () => void;
}) {
  return (
    <nav className="stepper" aria-label="스토리보드 작업 단계">
      <button
        className={view === "input" ? "current" : "completed"}
        aria-current={view === "input" ? "step" : undefined}
        disabled={busy}
        onClick={() => !busy && onNavigate("input")}
      >
        <span>{view === "board" ? <Check size={13} /> : "1"}</span> 원고 및 설정
      </button>
      <div className="step-line" />
      <button
        className={view === "board" ? "current" : ""}
        aria-current={view === "board" ? "step" : undefined}
        disabled={!hasBoard || busy}
        onClick={() => onNavigate("board")}
      >
        <span>2</span> 스토리보드 편집
      </button>
      <div className="step-line" />
      <button disabled={!hasBoard || busy} onClick={onExport}>
        <span>3</span> 내보내기
      </button>
    </nav>
  );
}

export function ErrorBanner({
  error,
  storageBlocked,
  canDownloadDraft,
  canRetry,
  busy,
  onDownloadDraft,
  onRetry,
  onDismiss,
}: {
  error: string;
  storageBlocked: boolean;
  canDownloadDraft: boolean;
  canRetry: boolean;
  busy: boolean;
  onDownloadDraft: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (!error && !storageBlocked) return null;
  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={18} />
      <span>{error || "기존 저장 데이터를 보호하기 위해 자동 저장이 중지되어 있습니다."}</span>
      {storageBlocked && canDownloadDraft && (
        <Button variant="ghost" onClick={onDownloadDraft}>
          저장 원본 다운로드
        </Button>
      )}
      {canRetry && !storageBlocked && (
        <Button variant="ghost" onClick={onRetry} disabled={busy}>
          다시 시도
        </Button>
      )}
      {!storageBlocked && <button aria-label="오류 닫기" onClick={onDismiss}>
        <X size={16} />
      </button>}
    </div>
  );
}
