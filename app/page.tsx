"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  CloudCheck,
  Copy,
  Download,
  FileText,
  Film,
  GraduationCap,
  Layers3,
  Lightbulb,
  PanelLeftClose,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
  AlertCircle,
  CheckCircle2,
  SlidersHorizontal,
  MonitorPlay,
  MessageSquareText,
  Quote,
  PencilLine,
  LayoutGrid,
} from "lucide-react";
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
import {
  boardSchema,
  defaults,
  sample,
  newScene,
  markdown,
  csv,
  fieldLabels,
  settingsSchema,
  type Board,
  type Scene,
  type Settings,
} from "@/lib/storyboard";

// Keep the original key so existing Frame drafts open in EduFlow without migration.
const STORAGE = "frame-studio-v1";
type Modal = "new" | "export" | "help" | "regenerate" | "delete" | null;
const textFields = [
  "purpose",
  "visual",
  "assets",
  "narration",
  "subtitle",
  "evidence",
  "reviewReason",
] as const;
function SelectField({
  label,
  value,
  options,
  onChange,
  children,
}: {
  label: string;
  value: string | number;
  options: (string | { value: string; label: string })[];
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  return (
    <label className="form-field">
      <span>
        {label}
        {children}
      </span>
      <div className="select-wrap">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option
              key={typeof o === "string" ? o : o.value}
              value={typeof o === "string" ? o : o.value}
            >
              {typeof o === "string" ? o : o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} />
      </div>
    </label>
  );
}
function ScenePreview({ scene, index }: { scene: Scene; index: number }) {
  return (
    <div className="scene-preview" aria-label="장면 제목과 자막 배치 미리보기">
      <div className="preview-topline">
        <span>EDUFLOW / SCENE {String(index + 1).padStart(2, "0")}</span>
        <MonitorPlay size={14} />
      </div>
      <div className="preview-copy">
        <span className="preview-rule" />
        <strong>{scene.title || "장면 제목을 입력하세요"}</strong>
        <p>{scene.subtitle || "장면의 핵심 자막이 여기에 표시됩니다."}</p>
      </div>
      <div className="preview-bottomline">
        <span>제목·자막 배치 예시</span><span>16:9 · {scene.duration}초</span>
      </div>
    </div>
  );
}

export default function Studio() {
  const [manuscript, setManuscript] = useState("");
  const [settings, setSettings] = useState<Settings>(defaults);
  const [board, setBoard] = useState<Board | null>(null);
  const [view, setView] = useState<"input" | "board">("input");
  const [active, setActive] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState("브라우저에 자동 저장");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [direction, setDirection] = useState("");
  const [filename, setFilename] = useState("나의 스토리보드");
  const [overview, setOverview] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const retryRef = useRef(false);
  const valid = manuscript.replace(/\s/g, "").length >= 100 && manuscript.length <= 20000;
  const scene = board?.scenes[active];
  const total = board?.scenes.reduce((n, s) => n + s.duration, 0) || 0;
  const reviewCount = board?.scenes.filter((s) => s.review).length || 0;
  const canGenerate = valid && ready && !busy && !keyword.trim();
  const notify = (text: string) => setNotice(text);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE);
      if (stored) {
        const parsed = JSON.parse(stored);
        const s = settingsSchema.safeParse(parsed.settings);
        const b = parsed.board ? boardSchema.safeParse(parsed.board) : null;
        if (typeof parsed.manuscript !== "string" || !s.success || (b && !b.success))
          throw new Error();
        setManuscript(parsed.manuscript);
        setSettings(s.data);
        if (b?.success) {
          setBoard(b.data);
          setView("board");
        }
        setSaved("이전 작업을 복구했어요");
      }
    } catch {
      setError(
        "저장된 작업을 복구하지 못했습니다. 새로 입력하거나 기존 내보내기 파일을 확인해 주세요.",
      );
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ manuscript, settings, board }));
      setSaved("모든 변경사항 저장됨");
    } catch {
      setSaved("자동 저장 실패");
      setError("브라우저 저장 공간이 부족하거나 저장이 차단되어 있습니다. 결과를 내보내 주세요.");
    }
  }, [manuscript, settings, board, ready]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setProgress((p) => Math.min(p + 9, 90)), 180);
    return () => clearInterval(t);
  }, [busy]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);
  useEffect(() => {
    if (!sidebar) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const navigation = sidebarRef.current;
    const focusable = () => Array.from(
      navigation?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? [],
    );
    focusable()[0]?.focus();
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebar(false);
      if (event.key !== "Tab") return;
      const targets = focusable();
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const desktop = window.matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => { if (desktop.matches) setSidebar(false); };
    document.addEventListener("keydown", handleKey);
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
      desktop.removeEventListener("change", closeOnDesktop);
      previousFocus?.focus();
    };
  }, [sidebar]);

  const setting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  function updateScene(key: keyof Scene, value: Scene[keyof Scene]) {
    setBoard((b) =>
      b
        ? {
            ...b,
            scenes: b.scenes.map((s, i) =>
              i === active
                ? { ...s, [key]: value, edited: Array.from(new Set([...s.edited, key])) }
                : s,
            ),
          }
        : b,
    );
  }
  function loadSample() {
    setManuscript(sample);
    notify("탄소중립 교육 원고를 불러왔어요. 자유롭게 수정해 보세요.");
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (!file.name.toLowerCase().endsWith(".txt"))
        throw new Error("TXT 파일만 불러올 수 있습니다.");
      if (file.size > 100000)
        throw new Error("파일이 너무 큽니다. 20,000자 이하의 원고를 선택해 주세요.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (text.includes("\0")) throw new Error("텍스트 파일을 확인해 주세요.");
      setManuscript(text);
      notify(`${file.name}을 불러왔어요.`);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "파일 인코딩을 읽을 수 없습니다. UTF-8 TXT 파일로 저장해 주세요."
          : e instanceof Error
            ? e.message
            : "파일을 읽을 수 없습니다.",
      );
    }
    if (uploadRef.current) uploadRef.current.value = "";
  }
  function addKeyword() {
    const k = keyword.trim();
    if (!k) return;
    if (settings.keywords.length >= 10) {
      notify("키워드는 최대 10개까지 추가할 수 있어요.");
      return;
    }
    if (k.length > 40) {
      notify("키워드는 40자 이하로 입력해 주세요.");
      return;
    }
    if (!settings.keywords.includes(k)) setting("keywords", [...settings.keywords, k]);
    setKeyword("");
  }
  async function generate(regenerate = false) {
    if (!valid || inFlight.current) return;
    inFlight.current = true;
    retryRef.current = regenerate;
    setError("");
    setBusy(true);
    setProgress(12);
    setModal(null);
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort("timeout"), 20000);
    const sceneId = regenerate ? scene?.id : undefined;
    try {
      let result: Board | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manuscript,
            settings,
            ...(regenerate ? { scene, direction } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            response.status === 400
              ? "원고와 생성 조건을 확인해 주세요."
              : "생성 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          );
        const parsed = boardSchema.safeParse(await response.json());
        if (parsed.success) {
          result = parsed.data;
          break;
        }
      }
      if (!result)
        throw new Error(
          "초안의 형식이 올바르지 않습니다. 기존 작업은 유지됩니다. 다시 시도해 주세요.",
        );
      if (regenerate) {
        const replacement = result.scenes[0];
        setBoard((b) =>
          b
            ? {
                ...b,
                scenes: b.scenes.map((s) => (s.id === sceneId ? { ...replacement, id: s.id } : s)),
              }
            : b,
        );
        notify("선택한 장면의 초안을 새로 구성했어요.");
      } else {
        setBoard(result);
        setActive(0);
        setReviewOnly(false);
        setFilename(result.title);
        notify("스토리보드 초안이 준비됐어요. 장면별로 검토해 보세요.");
      }
      setProgress(100);
      setView("board");
      setDirection("");
    } catch (e) {
      if (controller.signal.aborted && controller.signal.reason !== "timeout")
        notify("생성을 취소했어요. 기존 작업은 유지됩니다.");
      else
        setError(
          controller.signal.aborted
            ? "요청 시간이 초과되었습니다. 다시 시도해 주세요."
            : e instanceof TypeError
              ? "네트워크에 연결할 수 없습니다. 연결을 확인하고 다시 시도해 주세요."
              : e instanceof Error
                ? e.message
                : "생성에 실패했습니다. 다시 시도해 주세요.",
        );
    } finally {
      clearTimeout(timeout);
      inFlight.current = false;
      setBusy(false);
      requestRef.current = null;
    }
  }
  function addScene() {
    if (!board || board.scenes.length >= 30) {
      notify("프로토타입은 최대 30개 장면을 지원해요.");
      return;
    }
    const next = [...board.scenes];
    next.splice(active + 1, 0, newScene());
    setBoard({ ...board, scenes: next });
    setActive(active + 1);
    setReviewOnly(false);
  }
  function moveScene(delta: number) {
    if (!board) return;
    const target = active + delta;
    if (target < 0 || target >= board.scenes.length) return;
    const next = [...board.scenes];
    [next[active], next[target]] = [next[target], next[active]];
    setBoard({ ...board, scenes: next });
    setActive(target);
  }
  function removeScene() {
    if (!board || board.scenes.length <= 1) return;
    setBoard({ ...board, scenes: board.scenes.filter((_, i) => i !== active) });
    setActive(Math.max(0, active - 1));
    setModal(null);
  }
  function reset() {
    requestRef.current?.abort();
    setManuscript("");
    setSettings(defaults);
    setBoard(null);
    setView("input");
    setActive(0);
    setModal(null);
    setError("");
    setKeyword("");
    setDirection("");
    notify("새 작업을 시작합니다.");
  }
  async function exportBoard(format: "md" | "csv" | "copy") {
    if (!board) return;
    try {
      const content = format === "csv" ? csv(board) : markdown(board);
      if (format === "copy") {
        await navigator.clipboard.writeText(content);
        notify("전체 스토리보드를 복사했어요.");
        return;
      }
      const blob = new Blob([content], {
        type: format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename.trim().replace(/[\\/:*?"<>|]/g, "_") || "스토리보드"}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`${format.toUpperCase()} 파일을 내보냈어요.`);
    } catch {
      setError("내보내기에 실패했습니다. 브라우저의 다운로드 또는 클립보드 권한을 확인해 주세요.");
    }
  }

  return (
    <div className="studio-shell">
      <a className="skip-link" href="#main-content">본문으로 이동</a>
      <aside ref={sidebarRef} id="studio-navigation" className={`sidebar ${sidebar ? "sidebar-open" : ""}`} aria-label="워크스페이스 탐색" role={sidebar ? "dialog" : undefined} aria-modal={sidebar || undefined}>
        <a className="brand" href="/" aria-label="EduFlow 홈">
          <div className="brand-symbol" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span>EduFlow</span>
        </a>
        <div className="workspace-label">
          MY WORKSPACE <span>개인</span>
        </div>
        <Button
          variant="outline"
          className="new-work"
          onClick={() => setModal("new")}
          disabled={busy}
        >
          <Plus size={17} /> 새 스토리보드
        </Button>
        <div className="nav-caption">스튜디오</div>
        <button
          className={`nav-item ${view === "input" ? "selected" : ""}`}
          aria-current={view === "input" ? "page" : undefined}
          onClick={() => {
            setView("input");
            setSidebar(false);
          }}
          disabled={busy}
        >
          <FileText size={18} /> 원고 및 생성 설정 <ChevronRight size={14} />
        </button>
        <button
          className={`nav-item ${view === "board" ? "selected" : ""}`}
          aria-current={view === "board" ? "page" : undefined}
          onClick={() => {
            setView("board");
            setSidebar(false);
          }}
          disabled={!board || busy}
        >
          <LayoutGrid size={18} /> 스토리보드{" "}
          <span className="nav-count">{board?.scenes.length || 0}</span>
        </button>
        <div className="sidebar-bottom">
          <div className="privacy">
            <ShieldCheck size={16} />
            <span>내 브라우저에 안전하게 저장</span>
          </div>
          <button onClick={() => setModal("help")}>
            <CircleHelp size={17} /> 도움말 및 안내 <ChevronRight size={14} />
          </button>
          <div className="profile">
            <div className="avatar">E</div>
            <div>
              <strong>나의 워크스페이스</strong>
              <small>로컬 프로토타입</small>
            </div>
            <span className="status-dot" />
          </div>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="메뉴 닫기"
          onClick={() => setSidebar(false)}
        />
      )}
      <div className="workspace" inert={sidebar}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu"
              aria-label="메뉴 열기"
              aria-expanded={sidebar}
              aria-controls="studio-navigation"
              onClick={() => setSidebar(!sidebar)}
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
            <span className="demo-badge">
              <span />
              데모 모드
            </span>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <nav className="stepper" aria-label="스토리보드 작업 단계">
            <button
              className={view === "input" ? "current" : "completed"}
              aria-current={view === "input" ? "step" : undefined}
              disabled={busy}
              onClick={() => !busy && setView("input")}
            >
              <span>{view === "board" ? <Check size={13} /> : "1"}</span> 원고 및 설정
            </button>
            <div className="step-line" />
            <button
              className={view === "board" ? "current" : ""}
              aria-current={view === "board" ? "step" : undefined}
              disabled={!board || busy}
              onClick={() => setView("board")}
            >
              <span>2</span> 스토리보드 편집
            </button>
            <div className="step-line" />
            <button
              disabled={!board || busy}
              onClick={() => {
                setFilename(board?.title || "스토리보드");
                setModal("export");
              }}
            >
              <span>3</span> 내보내기
            </button>
          </nav>
          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              {valid && (
                <Button variant="ghost" onClick={() => generate(retryRef.current)} disabled={busy}>
                  다시 시도
                </Button>
              )}
              <button aria-label="오류 닫기" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {view === "input" ? (
            <>
              <header className="workspace-heading">
                <h1>원고 및 설정</h1>
                <Button variant="ghost" onClick={() => setModal("help")}>
                  <CircleHelp size={16} /> 사용 가이드
                </Button>
              </header>
              <div className="input-layout">
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
                      onClick={loadSample}
                      disabled={busy}
                    >
                      <BookOpen size={15} /> 샘플 원고 사용
                    </Button>
                  </div>
                  <div className="manuscript-tabs">
                    <span>
                      <PencilLine size={14} /> 직접 입력
                    </span>
                    <button onClick={() => uploadRef.current?.click()} disabled={busy}>
                      <Upload size={14} /> TXT 파일 불러오기
                    </button>
                    <input
                      ref={uploadRef}
                      type="file"
                      accept=".txt,text/plain"
                      className="sr-only"
                      aria-label="TXT 원고 불러오기"
                      onChange={(e) => importFile(e.target.files?.[0])}
                    />
                  </div>
                  <div
                    className="manuscript-editor"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!busy) importFile(e.dataTransfer.files[0]);
                    }}
                  >
                    <label className="sr-only" htmlFor="manuscript">
                      교육 원고
                    </label>
                    <textarea
                      id="manuscript"
                      aria-describedby="manuscript-hint"
                      aria-invalid={Boolean(manuscript) && !valid}
                      value={manuscript}
                      onChange={(e) => setManuscript(e.target.value)}
                      disabled={busy}
                      placeholder={
                        "어떤 이야기를 전하고 싶으신가요?\n\n교육 원고를 입력하거나, 준비한 내용을 붙여 넣어 주세요.\n학습자가 꼭 알아야 할 핵심 개념과 설명이 담겨 있으면 좋아요."
                      }
                    />
                    {!manuscript && (
                      <div className="editor-empty">
                        <div className="empty-illustration">
                          <div />
                          <FileText size={29} />
                          <span>
                            <Plus size={13} />
                          </span>
                        </div>
                        <p>아이디어가 장면이 되는 곳</p>
                        <small>원고를 작성하거나 TXT 파일을 여기에 놓아 주세요.</small>
                      </div>
                    )}
                  </div>
                  <div className="editor-footer">
                    <span id="manuscript-hint" className={manuscript.length > 20000 ? "invalid" : ""}>
                      {manuscript.length > 20000
                        ? `${(manuscript.length - 20000).toLocaleString()}자 초과`
                        : manuscript && !valid
                          ? "공백 제외 100자 이상 입력해 주세요"
                          : "공백 제외 최소 100자 · TXT 지원"}
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
                <section className="settings-panel panel">
                  <div className="panel-title">
                    <div>
                      <span className="section-icon">
                        <SlidersHorizontal size={18} />
                      </span>
                      <h2>생성 설정</h2>
                    </div>
                    <button
                      className="icon-button"
                      title="설정 초기화"
                      aria-label="설정 초기화"
                      disabled={busy}
                      onClick={() => {
                        setSettings(defaults);
                        setKeyword("");
                        notify("생성 설정을 초기화했어요.");
                      }}
                    >
                      <RotateCcw size={15} />
                    </button>
                  </div>
                  <fieldset disabled={busy} className="settings-fields">
                    <SelectField
                      label="누구를 위한 교육인가요?"
                      value={settings.audience}
                      options={[
                        "초등 저학년",
                        "초등 고학년",
                        "중고등학생",
                        "대학생/일반인",
                        "실무자/전문가",
                      ]}
                      onChange={(v) => setting("audience", v as Settings["audience"])}
                    />
                    <div className="form-field">
                      <span>설명 난이도</span>
                      <div className="segmented">
                        {["쉬움", "보통", "심화"].map((v) => (
                          <button
                            key={v}
                            aria-pressed={settings.difficulty === v}
                            className={settings.difficulty === v ? "active" : ""}
                            onClick={() => setting("difficulty", v as Settings["difficulty"])}
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="field-row">
                      <SelectField
                        label="영상 길이"
                        value={settings.minutes}
                        options={Array.from({ length: 10 }, (_, i) => ({
                          value: String(i + 1),
                          label: `${i + 1}분`,
                        }))}
                        onChange={(v) => setting("minutes", Number(v))}
                      />
                      <SelectField
                        label="장면 수"
                        value={settings.count}
                        options={[
                          { value: "auto", label: "자동 추천" },
                          ...Array.from({ length: 18 }, (_, i) => ({
                            value: String(i + 3),
                            label: `${i + 3}개`,
                          })),
                        ]}
                        onChange={(v) => setting("count", v === "auto" ? "auto" : Number(v))}
                      />
                    </div>
                    <SelectField
                      label="톤앤매너"
                      value={settings.tone}
                      options={["친근한 설명", "차분한 교육", "공식적", "간결한 안내"]}
                      onChange={(v) => setting("tone", v as Settings["tone"])}
                    />
                    <div className="form-field">
                      <label htmlFor="keywords">
                        강조 키워드 <small>선택 · 최대 10개</small>
                      </label>
                      <div className="keyword-input">
                        <Input
                          id="keywords"
                          placeholder="키워드 입력 후 Enter"
                          value={keyword}
                          maxLength={40}
                          onChange={(e) => setKeyword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addKeyword();
                            }
                          }}
                        />
                        <button aria-label="키워드 추가" onClick={addKeyword}>
                          <Plus size={15} />
                        </button>
                      </div>
                      {settings.keywords.length > 0 && (
                        <div className="keyword-tags">
                          {settings.keywords.map((k) => (
                            <span key={k}>
                              {k}
                              <button
                                aria-label={`${k} 키워드 삭제`}
                                onClick={() =>
                                  setting(
                                    "keywords",
                                    settings.keywords.filter((v) => v !== k),
                                  )
                                }
                              >
                                <X size={11} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {keyword.trim() && (
                        <small>Enter 또는 + 버튼으로 키워드를 추가해 주세요.</small>
                      )}
                    </div>
                    <div className="settings-divider" />
                    <SelectField
                      label="출력 언어"
                      value={settings.language}
                      options={["한국어", "영어"]}
                      onChange={(v) => setting("language", v as Settings["language"])}
                    />
                    <details className="additional">
                      <summary>
                        <Plus size={14} /> 추가 요청 <span>선택</span>
                      </summary>
                      <label className="sr-only" htmlFor="instructions">
                        추가 요청
                      </label>
                      <Textarea
                        id="instructions"
                        maxLength={500}
                        value={settings.instructions}
                        onChange={(e) => setting("instructions", e.target.value)}
                        placeholder="예: 실천 방법을 중심으로 구성해 주세요."
                      />
                      <small>
                        {settings.instructions.length} / 500자 · 데모에서는 제작 메모로 반영
                      </small>
                    </details>
                  </fieldset>
                </section>
              </div>
              <div className="generation-bar">
                <div>
                  <span className="round-spark">
                    <Sparkles size={19} />
                  </span>
                  <div>
                    <strong>생성 조건</strong>
                    <p>
                      {settings.audience} <span>·</span> {settings.minutes}분 <span>·</span>{" "}
                      {settings.count === "auto" ? "장면 수 자동" : `${settings.count}개 장면`}{" "}
                      <span>·</span> {settings.tone}
                    </p>
                  </div>
                </div>
                <Button
                  className="generate-button"
                  disabled={!canGenerate}
                  onClick={() => generate()}
                >
                  <Sparkles size={17} /> 스토리보드 생성 <ArrowRight size={17} />
                </Button>
              </div>
              <div className="bottom-note">
                <ShieldCheck size={13} />
                <span>작업은 이 브라우저에 자동 저장됩니다.</span>
                <span className="note-dot">·</span>
                <span>
                  데모 모드에서는 원문 발췌 기반 초안을 생성하며, 외부 AI로 전송하지 않습니다.
                </span>
              </div>
            </>
          ) : (
            board && (
              <>
                <header className="workspace-heading">
                  <h1>스토리보드 편집</h1>
                  <Button
                    className="export-top"
                    onClick={() => {
                      setFilename(board.title);
                      setModal("export");
                    }}
                  >
                    <Download size={16} /> 내보내기
                  </Button>
                </header>
                <section className="overview-panel panel">
                  <div className="overview-top">
                    <div className="overview-icon">
                      <Film size={22} />
                    </div>
                    <div className="overview-title">
                      <input
                        aria-label="콘텐츠 제목"
                        value={board.title}
                        onChange={(e) => setBoard({ ...board, title: e.target.value })}
                      />
                      <div className="overview-meta">
                        <span>
                          <Layers3 size={13} />
                          {board.scenes.length}개 장면
                        </span>
                        <span>
                          <Clock3 size={13} />
                          {Math.floor(total / 60)}분 {total % 60 ? `${total % 60}초` : ""}
                        </span>
                        <span>
                          <GraduationCap size={14} />
                          {board.settings.audience}
                        </span>
                        <span className="review-pill">
                          <AlertCircle size={12} /> {reviewCount}개 검토 필요
                        </span>
                      </div>
                    </div>
                    <button
                      className="overview-toggle"
                      aria-expanded={overview}
                      onClick={() => setOverview(!overview)}
                    >
                      콘텐츠 개요 <ChevronDown size={16} className={overview ? "rotate" : ""} />
                    </button>
                  </div>
                  {overview && (
                    <div className="overview-edit">
                      <label>
                        핵심 요약
                        <Textarea
                          value={board.summary}
                          onChange={(e) => setBoard({ ...board, summary: e.target.value })}
                        />
                      </label>
                      <label>
                        학습 목표 <small>한 줄에 하나씩 · 최대 5개</small>
                        <Textarea
                          value={board.objectives.join("\n")}
                          onChange={(e) =>
                            setBoard({
                              ...board,
                              objectives: e.target.value.split("\n").slice(0, 5),
                            })
                          }
                        />
                      </label>
                      <div className="settings-summary">
                        {board.settings.difficulty} · 목표 {board.settings.minutes}분 ·{" "}
                        {board.settings.tone} · {board.settings.language}
                        {board.settings.keywords.length > 0 &&
                          ` · ${board.settings.keywords.join(", ")}`}
                        {board.settings.instructions && (
                          <p>추가 요청: {board.settings.instructions}</p>
                        )}
                      </div>
                    </div>
                  )}
                </section>
                {Math.abs(total - board.settings.minutes * 60) >
                  board.settings.minutes * 60 * 0.15 && (
                  <div className="duration-warning">
                    <Clock3 size={15} />
                    현재 예상 시간이 목표 길이의 ±15%를 벗어났습니다. 장면별 시간을 조정해 주세요.
                  </div>
                )}
                <div className="board-layout">
                  <section className="scene-list">
                    <div className="scene-list-heading">
                      <h2>
                        장면 목록 <span>{board.scenes.length}</span>
                      </h2>
                      <button
                        aria-label="검토 필요한 장면만 보기"
                        title="검토 필요한 장면만 보기"
                        className={reviewOnly ? "filter-active" : ""}
                        aria-pressed={reviewOnly}
                        onClick={() => setReviewOnly(!reviewOnly)}
                      >
                        <Settings2 size={16} />
                      </button>
                    </div>
                    {reviewOnly && <div className="filter-label">검토 필요한 장면만 표시</div>}
                    {board.scenes.map(
                      (s, i) =>
                        (!reviewOnly || s.review) && (
                          <button
                            key={s.id}
                            className={`scene-item ${i === active ? "active" : ""}`}
                            onClick={() => setActive(i)}
                          >
                            <div className="scene-mini-art">
                              <span>{String(i + 1).padStart(2, "0")}</span>
                              <div className={`mini-landscape landscape-${i % 3}`}>
                                <FileText size={22} />
                              </div>
                            </div>
                            <div className="scene-item-body">
                              <strong>{s.title || "제목 없는 장면"}</strong>
                              <span>
                                <Clock3 size={11} />
                                {s.duration}초{" "}
                                <span className={s.review ? "review-dot" : "done-dot"} />
                                {s.review ? "검토 필요" : "검토 완료"}
                              </span>
                            </div>
                          </button>
                        ),
                    )}
                    {reviewOnly && !reviewCount && (
                      <p className="all-reviewed">
                        <CheckCheck size={24} /> 모든 장면을 검토했어요.
                      </p>
                    )}
                    <Button variant="outline" className="add-scene" onClick={addScene}>
                      <Plus size={15} /> 선택 장면 다음에 추가
                    </Button>
                    <div className="scene-list-note">
                      <ShieldCheck size={15} />
                      <p>
                        원문 근거를 확인하고
                        <br />
                        검토를 완료해 주세요.
                      </p>
                    </div>
                  </section>
                  {scene && (
                    <section className="scene-editor panel" key={scene.id}>
                      <div className="scene-editor-head">
                        <div>
                          <span className="scene-number">
                            SCENE {String(active + 1).padStart(2, "0")}
                          </span>
                          <span className={`status-tag ${scene.review ? "" : "done"}`}>
                            {scene.review ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}{" "}
                            {scene.review ? "검토 필요" : "검토 완료"}
                          </span>
                          {scene.edited.length > 0 && (
                            <span className="edited-tag">
                              <PencilLine size={11} /> 수정됨
                            </span>
                          )}
                        </div>
                        <div className="scene-tools">
                          <button
                            aria-label="장면 위로 이동"
                            disabled={active === 0}
                            onClick={() => moveScene(-1)}
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            aria-label="장면 아래로 이동"
                            disabled={active === board.scenes.length - 1}
                            onClick={() => moveScene(1)}
                          >
                            <ArrowDown size={16} />
                          </button>
                          <span />
                          <button
                            aria-label="장면 삭제"
                            disabled={board.scenes.length === 1}
                            onClick={() => setModal("delete")}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                      <Input
                        className="scene-title-input"
                        aria-label="장면 제목"
                        value={scene.title}
                        onChange={(e) => updateScene("title", e.target.value)}
                      />
                      <div className="scene-hero">
                        <ScenePreview scene={scene} index={active} />
                        <div className="scene-purpose">
                          <label>
                            <GraduationCap size={15} /> 장면 목적{" "}
                            {scene.edited.includes("purpose") && <small>수정됨</small>}
                          </label>
                          <Textarea
                            aria-label="장면 목적"
                            value={scene.purpose}
                            onChange={(e) => updateScene("purpose", e.target.value)}
                          />
                          <label className="duration-label" htmlFor="duration">
                            <Clock3 size={14} /> 예상 시간
                          </label>
                          <div className="duration-input">
                            <Input
                              id="duration"
                              type="number"
                              min={1}
                              max={600}
                              value={scene.duration}
                              onChange={(e) =>
                                updateScene(
                                  "duration",
                                  Math.min(600, Math.max(1, Number(e.target.value) || 1)),
                                )
                              }
                            />
                            <span>초</span>
                          </div>
                        </div>
                      </div>
                      <div className="scene-fields">
                        {textFields
                          .filter((k) => k !== "purpose")
                          .map((key) => (
                            <div key={key} className={`scene-field field-${key}`}>
                              <label htmlFor={`field-${key}`}>
                                {key === "visual" ? (
                                  <MonitorPlay size={15} />
                                ) : key === "assets" ? (
                                  <Layers3 size={15} />
                                ) : key === "narration" ? (
                                  <MessageSquareText size={15} />
                                ) : key === "evidence" ? (
                                  <Quote size={15} />
                                ) : key === "reviewReason" ? (
                                  <AlertCircle size={15} />
                                ) : (
                                  <FileText size={15} />
                                )}{" "}
                                {fieldLabels[key]}
                                {scene.edited.includes(key) && <small>수정됨</small>}
                                {key === "evidence" && (
                                  <span className="source-tag">{scene.sourceId}</span>
                                )}
                              </label>
                              <Textarea
                                id={`field-${key}`}
                                value={scene[key]}
                                onChange={(e) => updateScene(key, e.target.value)}
                                rows={key === "narration" ? 4 : 2}
                              />
                            </div>
                          ))}
                      </div>
                      <div className="scene-editor-footer">
                        <Button
                          variant="outline"
                          disabled={!valid || busy}
                          onClick={() => {
                            setDirection("");
                            setModal("regenerate");
                          }}
                        >
                          <RotateCcw size={15} /> 이 장면 재생성
                        </Button>
                        <Button
                          variant={scene.review ? "default" : "secondary"}
                          onClick={() => updateScene("review", !scene.review)}
                        >
                          <Check size={15} />
                          {scene.review ? "검토 완료로 표시" : "검토 필요로 변경"}
                        </Button>
                      </div>
                    </section>
                  )}
                </div>
                <div className="bottom-note">
                  <Sparkles size={13} /> 데모 초안입니다. 원문의 의미와 교육 대상에 맞는 표현인지
                  확인한 후 사용해 주세요.
                </div>
              </>
            )
          )}
          <footer className="page-footer">
            <span>
              EduFlow <span>Make knowledge flow.</span>
            </span>
            <span>교육 콘텐츠 스토리보드 스튜디오</span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast-message" role="status">
          <CheckCircle2 size={17} />
          {notice}
          <button aria-label="알림 닫기" onClick={() => setNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <Dialog open={busy} onOpenChange={() => {}}>
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
          <div className="progress-track">
            <div style={{ width: `${progress}%` }} />
          </div>
          <div className="progress-label">
            <span>
              {progress < 35
                ? "원고의 흐름을 살펴보고 있어요"
                : progress < 70
                  ? "장면별 내용을 구성하고 있어요"
                  : "원문 근거와 필수 항목을 확인하고 있어요"}
            </span>
            <span>{progress}%</span>
          </div>
          <p>원문 발췌 데모 · 외부 AI 전송 없음</p>
          <Button variant="ghost" onClick={() => requestRef.current?.abort()}>
            생성 취소
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open) setModal(null);
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
            <DialogTitle>
              {modal === "new"
                ? "새로운 이야기를 시작할까요?"
                : modal === "delete"
                  ? "이 장면을 삭제할까요?"
                  : modal === "regenerate"
                    ? "이 장면을 새롭게 구성합니다"
                    : modal === "export"
                      ? "다음 제작 단계로, 내보내기"
                      : "EduFlow 사용 가이드"}
            </DialogTitle>
            <DialogDescription>
              {modal === "new"
                ? "현재 브라우저에 저장된 원고와 스토리보드가 초기화됩니다. 필요한 결과는 먼저 내보내 주세요."
                : modal === "delete"
                  ? "선택한 장면과 수정 내용이 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
                  : modal === "regenerate"
                    ? "선택한 장면의 모든 내용을 새 초안으로 교체합니다. 다른 장면의 수정 내용은 유지됩니다."
                    : modal === "export"
                      ? "수정한 최신 내용과 현재 장면 순서가 그대로 담깁니다."
                      : "원고에서 시작해 제작 가능한 스토리보드로 정리해 보세요."}
            </DialogDescription>
          </DialogHeader>
          {modal === "export" && board && (
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
                  onChange={(e) => setFilename(e.target.value)}
                  maxLength={100}
                />
              </label>
              <div className="export-options">
                <button onClick={() => exportBoard("md")}>
                  <div>
                    <FileText size={22} />
                  </div>
                  <span>
                    <strong>Markdown</strong>
                    <small>문서로 정리하고 자유롭게 편집</small>
                  </span>
                  <Download size={17} />
                </button>
                <button onClick={() => exportBoard("csv")}>
                  <div>
                    <LayoutGrid size={22} />
                  </div>
                  <span>
                    <strong>CSV 스프레드시트</strong>
                    <small>Excel · Google Sheets에서 활용</small>
                  </span>
                  <Download size={17} />
                </button>
                <button onClick={() => exportBoard("copy")}>
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
          )}
          {modal === "regenerate" && (
            <>
              <label className="form-field">
                어떻게 바꿀까요?{" "}
                <Textarea
                  value={direction}
                  maxLength={300}
                  onChange={(e) => setDirection(e.target.value)}
                  placeholder="예: 핵심 개념을 더 크게 강조해 주세요."
                />
                <small>{direction.length} / 300자 · 데모에서는 제작 메모로 반영됩니다.</small>
              </label>
              <div className="modal-actions">
                <Button variant="outline" onClick={() => setModal(null)}>
                  취소
                </Button>
                <Button onClick={() => generate(true)}>
                  <Sparkles size={15} /> 교체하고 재생성
                </Button>
              </div>
            </>
          )}
          {(modal === "new" || modal === "delete") && (
            <div className="modal-actions">
              <Button variant="outline" onClick={() => setModal(null)}>
                취소
              </Button>
              <Button variant="destructive" onClick={modal === "new" ? reset : removeScene}>
                {modal === "new" ? "초기화하고 시작" : "장면 삭제"}
              </Button>
            </div>
          )}
          {modal === "help" && (
            <div className="help-content">
              <ol>
                <li>
                  <strong>원고를 준비하세요</strong>
                  <p>
                    100자 이상의 원고를 붙여 넣거나 TXT 파일을 불러오세요. 샘플 원고로 바로 체험할
                    수도 있어요.
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
                  현재는 <strong>원문 발췌 데모</strong>입니다. 실제 AI 생성·번역은 연결되어 있지
                  않으며, 추가 지시는 제작 메모로 반영됩니다. 원고는 로컬 서버에서 처리하고 현재
                  브라우저에 저장합니다.
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
