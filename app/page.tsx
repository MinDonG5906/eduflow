"use client";

import { useEffect, useRef, useState } from "react";
import { CircleHelp, Clock3, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectionDialog } from "@/components/studio/connection-dialog";
import { DocumentSource } from "@/components/studio/document-source";
import { ManuscriptPanel } from "@/components/studio/manuscript-panel";
import { SceneEditor } from "@/components/studio/scene-editor";
import { ScriptView } from "@/components/studio/script-view";
import { SceneList } from "@/components/studio/scene-list";
import { GenerationBar, SettingsPanel } from "@/components/studio/settings-panel";
import { ProgressDialog, StudioDialog, Toast } from "@/components/studio/studio-dialogs";
import { ErrorBanner, StudioStepper, StudioTopbar } from "@/components/studio/studio-header";
import { StudioSidebar } from "@/components/studio/studio-sidebar";
import type { ExportFormat, StudioModal, StudioView } from "@/components/studio/types";
import { useDraftStorage } from "@/hooks/use-draft-storage";
import { canStartGeneration } from "@/lib/generation-availability";
import { useGeneratorStatus } from "@/hooks/use-generator-status";
import { usePdfSelection } from "@/hooks/use-pdf-selection";
import { useBusyProgress, useNotice } from "@/hooks/use-timed-state";
import { editScene, insertSceneAfter, MAX_SCENES, moveScene, removeScene, replaceScene } from "@/lib/board-edit";
import { downloadBlob, downloadText, exportFilename } from "@/lib/download";
import {
  defaults,
  sample,
  markdown,
  requestSchema,
  type Board,
  type Scene,
  type Settings,
} from "@/lib/storyboard";
import { captureGeneration, retryConflict, type GenerationJob } from "@/lib/studio-state";
import { apiErrorSchema, CLIENT_TIMEOUT_MS, GenerationError, parseGenerationResponse } from "@/lib/generation-contract";
import { findDocumentExcerpt, MAX_MANUSCRIPT_CHARS, type SourceDocument } from "@/lib/documents";
import { deletePdf, savePdf } from "@/lib/pdf-storage";
import { loadSceneImages } from "@/lib/scene-image-storage";
import { defaultImageSettings } from "@/lib/scene-image";
import { TERM_CORRECTION_NOTICE_PREFIX } from "@/lib/term-corrections";
import { readDocumentUpload } from "@/lib/document-upload";
import { citedPdfPage, sourceFormat, sourceUnit } from "@/lib/pdf-source";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

// Remembered per browser tab so a reload keeps the board view.
const BOARD_MODE_KEY = "eduflow-board-mode";

export default function Studio() {
  const [manuscript, setManuscript] = useState("");
  const [sourceDocument, setSourceDocument] = useState<SourceDocument | null>(null);
  const [importing, setImporting] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [board, setBoard] = useState<Board | null>(null);
  const [view, setView] = useState<StudioView>("input");
  const [active, setActive] = useState(0);
  const [modal, setModal] = useState<StudioModal>(null);
  const [busy, setBusy] = useState(false);
  const [failedRequest, setFailedRequest] = useState<GenerationJob | null>(null);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [direction, setDirection] = useState("");
  const [sceneSourceScope, setSceneSourceScope] = useState<"citation" | "selection">("citation");
  const [filename, setFilename] = useState("나의 스토리보드");
  const [reviewOnly, setReviewOnly] = useState(false);
  // The board view only renders after the draft is restored on the client, so reading here cannot mismatch hydration.
  const [boardMode, setBoardModeState] = useState<"scene" | "script">(() => { try { return sessionStorage.getItem(BOARD_MODE_KEY) === "script" ? "script" : "scene"; } catch { return "scene"; } });
  const setBoardMode = (next: "scene" | "script") => { setBoardModeState(next); try { sessionStorage.setItem(BOARD_MODE_KEY, next); } catch {} };
  const [sidebar, setSidebar] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const importRequestRef = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const importInFlight = useRef(false);

  const fail = (message: string) => {
    setFailedRequest(null);
    setError(message);
  };
  const generator = useGeneratorStatus(setError);
  const draft = useDraftStorage(
    { manuscript, settings, board, document: sourceDocument },
    {
      onRestore(parsed, removedExample) {
        setManuscript(parsed.manuscript);
        setSettings(parsed.settings);
        setSourceDocument(parsed.document ?? null);
        setBoard(parsed.board);
        setView(parsed.board ? "board" : "input");
        if (removedExample)
          setNotice("이전 훈민정음 예제 결과를 정리했어요. 현재 원고·첨부 자료·설정은 유지됩니다.");
      },
      onError: fail,
    },
  );
  const { ready, storageBlocked } = draft;
  const pdf = usePdfSelection(sourceDocument?.fileId, setError);
  const [notice, setNotice] = useNotice();
  const [progress, setProgress] = useBusyProgress(busy);

  const isPdf = Boolean(sourceDocument && (sourceDocument.kind === "pdf" || /\.pdf$/i.test(sourceDocument.name)));
  const documentUnit = sourceUnit(sourceDocument?.name ?? "");
  const documentFormat = sourceFormat(sourceDocument?.name ?? "");
  const pdfReady = isPdf && Boolean(pdf.selected) && Boolean(sourceDocument?.selectedPages?.length) && !pdf.pickerOpen;
  const valid = manuscript.length <= 20000 && (isPdf ? pdfReady : manuscript.replace(/\s/g, "").length >= 100);
  const scene = board?.scenes[active];
  const citedPage = isPdf && sourceDocument ? citedPdfPage({ name: sourceDocument.name, pages: sourceDocument.selectedPages ?? [] }, scene) : null;
  const total = board?.scenes.reduce((n, s) => n + s.duration, 0) || 0;
  const reviewCount = board?.scenes.filter((s) => s.review).length || 0;
  const target = (board?.settings.minutes || 0) * 60;
  const offTarget = Math.abs(total - target) > target * 0.15;
  // Next scene still needing review, wrapping past the end; never the current one.
  const nextReview = board ? [...board.scenes.keys()].map(i => (active + 1 + i) % board.scenes.length)
    .find(i => i !== active && board.scenes[i].review) : undefined;
  const documentPending = !isPdf && sourceDocument && sourceDocument.query.trim() !== (sourceDocument.appliedQuery ?? "");
  const canGenerate = canStartGeneration({ generator, isPdf, valid, ready, busy, importing, documentPending: Boolean(documentPending), keyword, storageBlocked });
  const notify = (text: string) => setNotice(text);

  useEffect(() => () => {
    requestRef.current?.abort();
    importRequestRef.current?.abort();
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);

  function updateScene<K extends keyof Scene>(key: K, value: Scene[K]) {
    setBoard((b) => (b ? editScene(b, active, key, value) : b));
  }
  function editSceneAt<K extends keyof Scene>(index: number, key: K, value: Scene[K]) {
    setBoard((b) => (b ? editScene(b, index, key, value) : b));
  }
  function loadSample() {
    setSourceDocument(null);
    pdf.clear();
    setManuscript(sample);
    notify("탄소중립 교육 원고를 불러왔어요. 자유롭게 수정해 보세요.");
  }
  async function importFile(file?: File) {
    if (!file || importInFlight.current || busy || storageBlocked) return;
    importInFlight.current = true;
    const controller = new AbortController();
    importRequestRef.current = controller;
    setImporting(true);
    setError("");
    try {
      if (!/\.(txt|pdf|pptx?|hwpx?|docx)$/i.test(file.name))
        throw new Error("PDF, PPT/PPTX, HWP/HWPX, Word(.docx), TXT 파일을 지원합니다. 구형 DOC는 PDF 또는 DOCX로 저장해 주세요.");
      const response = await fetch("/api/documents", {
        method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Document-Name": encodeURIComponent(file.name) },
        body: file, signal: controller.signal,
      });
      const { document, pdf: converted } = await readDocumentUpload(response, file);
      controller.signal.throwIfAborted();
      pdf.clear();
      if (document.kind === "pdf") pdf.open(converted!);
      setSourceDocument({ ...document, appliedQuery: "" });
      setManuscript(document.kind !== "pdf" && document.text.length <= MAX_MANUSCRIPT_CHARS ? document.text : "");
      setFailedRequest(null);
      notify(document.kind === "pdf" ? `${sourceFormat(file.name)}를 열었어요. AI에 보낼 ${sourceUnit(file.name)}를 먼저 선택해 주세요.` : document.text.length <= MAX_MANUSCRIPT_CHARS ? `${file.name}의 내용을 불러왔어요. 원하는 부분만 찾아서 제작할 수도 있어요.` : `${file.name}을 읽었어요. 제작할 부분을 입력해 원고로 가져와 주세요.`);
    } catch (e) {
      setFailedRequest(null);
      if (controller.signal.aborted) notify("문서 불러오기를 취소했어요. 기존 원고를 유지합니다.");
      else setError(e instanceof Error ? e.message : "파일을 읽을 수 없습니다.");
    } finally {
      importRequestRef.current = null;
      importInFlight.current = false;
      setImporting(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }
  async function applyPdfPages(blob: Blob, pages: number[]) {
    const original = pdf.original;
    if (!original || !pdf.isCurrent(original)) return;
    const id = crypto.randomUUID();
    let storedId: string | undefined;
    try { await savePdf(id, blob); storedId = id; }
    catch { setError("선택 자료는 현재 화면에서 사용할 수 있지만 브라우저에 저장하지 못했습니다. 새로고침하면 다시 첨부해 주세요."); }
    if (!pdf.isCurrent(original)) { if (storedId) void deletePdf(storedId).catch(() => {}); return; }
    pdf.select(blob);
    setSourceDocument((document) => document ? { ...document, selectedPages: pages, fileId: storedId } : document);
    setFailedRequest(null);
    notify(`${pages.length}${documentUnit}를 선택했어요. 제작 요청과 설정을 확인한 뒤 생성해 주세요.`);
  }
  function findDocumentPart() {
    if (!sourceDocument) return;
    try {
      const result = findDocumentExcerpt(sourceDocument, sourceDocument.query);
      setManuscript(result.excerpt);
      setSourceDocument({ ...sourceDocument, appliedQuery: sourceDocument.query.trim() });
      setError("");
      setFailedRequest(null);
      notify(`“${result.topic}” 관련 ${result.matches}곳을 원고로 가져왔어요. 내용을 확인한 뒤 생성해 주세요.`);
    } catch (e) { setError(e instanceof Error ? e.message : "요청한 부분을 찾지 못했습니다."); }
  }
  function useWholeDocument() {
    if (!sourceDocument || sourceDocument.text.length > MAX_MANUSCRIPT_CHARS) return;
    setManuscript(sourceDocument.text);
    setSourceDocument({ ...sourceDocument, query: "", appliedQuery: "" });
    setError("");
  }
  async function generate(regenerate = false, retry?: GenerationJob) {
    if (inFlight.current || importInFlight.current || storageBlocked || !generator?.available) return;
    if (!retry && (!valid || documentPending || (isPdf && generator.mode !== "ai") || (regenerate && !scene))) return;
    const job = retry ?? captureGeneration({
      manuscript,
      settings,
      ...(isPdf && sourceDocument ? { pdfSource: { name: sourceDocument.name, pages: sourceDocument.selectedPages ?? [] }, sourceRequest: sourceDocument.query.trim() } : sourceDocument?.appliedQuery ? { sourceRequest: sourceDocument.appliedQuery } : {}),
      ...(regenerate ? { scene, direction, sceneSourceScope: citedPage === null ? "selection" as const : sceneSourceScope } : {}),
    }, board, isPdf ? pdf.selected ?? undefined : undefined);
    setFailedRequest(null);
    const conflict = retry ? retryConflict(job, board) : null;
    if (conflict || !requestSchema.safeParse(job.input).success) {
      setError(conflict || "원고와 생성 조건을 확인해 주세요.");
      return;
    }
    inFlight.current = true;
    setError("");
    setBusy(true);
    setProgress(12);
    setModal(null);
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort("timeout"), CLIENT_TIMEOUT_MS);
    const sceneId = job.input.scene?.id;
    try {
      let body: string | FormData = JSON.stringify(job.input);
      if (job.input.pdfSource) {
        if (!job.pdf) throw new GenerationError("PDF_NOT_ATTACHED");
        const form = new FormData(); form.set("input", JSON.stringify(job.input));
        form.set("pdf", job.pdf, "selected-pages.pdf"); body = form;
      }
      const response = await fetch("/api/generate", {
        method: "POST",
        ...(typeof body === "string" ? { headers: { "Content-Type": "application/json" } } : {}),
        body,
        signal: controller.signal,
      });
      const raw = await response.json();
      if (!response.ok) {
        const failure = apiErrorSchema.safeParse(raw);
        throw new GenerationError(failure.success ? failure.data.code : "INTERNAL_ERROR",
          failure.success ? failure.data.inputUsage : undefined);
      }
      const result = parseGenerationResponse(raw, job.input);
      if (sceneId) {
        setBoard((b) => (b ? replaceScene(b, sceneId, result.scenes[0]) : b));
        const targetIndex = board?.scenes.findIndex((s) => s.id === sceneId);
        if (targetIndex !== undefined && targetIndex >= 0) setActive(targetIndex);
        notify("요청한 장면의 초안을 새로 구성했어요.");
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
      else {
        if (!(e instanceof GenerationError) || e.retryable) setFailedRequest(job);
        setError(
          controller.signal.aborted
            ? "요청 시간이 초과되었습니다. 다시 시도해 주세요."
            : e instanceof TypeError
              ? "네트워크에 연결할 수 없습니다. 연결을 확인하고 다시 시도해 주세요."
              : e instanceof Error
                ? e.message
                : "생성에 실패했습니다. 다시 시도해 주세요.",
        );
      }
    } finally {
      clearTimeout(timeout);
      inFlight.current = false;
      setBusy(false);
      requestRef.current = null;
    }
  }
  function addScene() {
    if (!board || board.scenes.length >= MAX_SCENES) {
      notify("프로토타입은 최대 30개 장면을 지원해요.");
      return;
    }
    setBoard(insertSceneAfter(board, active));
    setActive(active + 1);
    setReviewOnly(false);
  }
  function moveActiveScene(delta: number) {
    const next = board && moveScene(board, active, delta);
    if (!next) return;
    setBoard(next);
    setActive(active + delta);
  }
  function removeActiveScene() {
    const next = board && removeScene(board, active);
    if (!next) return;
    setBoard(next);
    setActive(Math.max(0, active - 1));
    setModal(null);
  }
  function reset() {
    requestRef.current?.abort();
    setManuscript("");
    setSourceDocument(null);
    pdf.clear();
    setSettings(defaults);
    setBoard(null);
    setView("input");
    setActive(0);
    setModal(null);
    setError("");
    setKeyword("");
    setDirection("");
    setFailedRequest(null);
    draft.releaseProtectedDraft();
    notify("새 작업을 시작합니다.");
  }
  function downloadProtectedDraft() {
    if (draft.protectedDraft === null) return;
    try {
      downloadText(draft.protectedDraft, "application/json;charset=utf-8", "eduflow-saved-draft.json");
      notify("기존 저장 원본을 내보냈어요.");
    } catch {
      setError("저장 원본을 내려받지 못했습니다. 기존 저장 데이터는 계속 보호됩니다. 브라우저 다운로드 권한을 확인해 주세요.");
    }
  }
  async function exportBoard(format: ExportFormat) {
    if (!board) return;
    try {
      if (format === "pdf") {
        notify("PDF 스토리보드를 생성하고 있어요...");
        const formData = new FormData();
        formData.set("board", JSON.stringify(board));
        if (pdfReady && pdf.selected && sourceDocument?.selectedPages?.length) {
          formData.set("pdf", pdf.selected, "selected-pages.pdf");
          formData.set("pdfSource", JSON.stringify({ name: sourceDocument.name, pages: sourceDocument.selectedPages }));
        }
        // Attach scene reference images from IndexedDB
        const imageIds = board.scenes
          .map((s) => s.image?.id)
          .filter((id): id is string => Boolean(id));
        if (imageIds.length > 0) {
          const imageMap = await loadSceneImages(imageIds);
          for (const s of board.scenes) {
            if (s.image?.id && imageMap.has(s.image.id)) {
              formData.set(`scene_image_${s.id}`, imageMap.get(s.image.id)!, s.image.name || "image.png");
            }
          }
        }
        const response = await fetch("/api/export/pdf", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || "PDF 생성에 실패했습니다.");
        }
        const blob = await response.blob();
        downloadBlob(blob, exportFilename(filename, "pdf"));
        notify("PDF 스토리보드를 내보냈어요.");
        setModal(null);
        return;
      }
      const content = markdown(board);
      if (format === "copy") {
        await navigator.clipboard.writeText(content);
        notify("전체 스토리보드를 복사했어요.");
        return;
      }
      downloadText(content, "text/markdown;charset=utf-8", exportFilename(filename, format));
      notify(`${format.toUpperCase()} 파일을 내보냈어요.`);
    } catch (e) {
      setModal(null);
      fail(format === "copy"
        ? "복사할 수 없습니다. 브라우저의 클립보드 권한을 확인하거나 Markdown 파일로 내려받아 주세요."
        : format === "pdf"
          ? (e instanceof Error ? e.message : "PDF 내보내기에 실패했습니다.")
          : "내보내기에 실패했습니다. 브라우저의 다운로드 권한을 확인해 주세요.");
    }
  }
  function openExport() {
    setFilename(board?.title || "스토리보드");
    setModal("export");
  }

  return (
    <div className="studio-shell">
      <a className="skip-link" href="#main-content">본문으로 이동</a>
      <StudioSidebar
        open={sidebar}
        setOpen={setSidebar}
        view={view}
        onNavigate={setView}
        sceneCount={board?.scenes.length || 0}
        hasBoard={Boolean(board)}
        busy={busy}
        importing={importing}
        onNew={() => setModal("new")}
        onHelp={() => setModal("help")}
      />
      <div className="workspace" inert={sidebar}>
        <StudioTopbar
          view={view}
          saved={draft.saved}
          generator={generator}
          onOpenConnection={() => setConnectionOpen(true)}
          sidebarOpen={sidebar}
          onToggleSidebar={() => setSidebar(!sidebar)}
        />
        <main id="main-content" tabIndex={-1}>
          <StudioStepper view={view} busy={busy} hasBoard={Boolean(board)} onNavigate={setView} onExport={openExport} />
          <ErrorBanner
            error={error}
            storageBlocked={storageBlocked}
            canDownloadDraft={draft.protectedDraft !== null}
            canRetry={Boolean(failedRequest)}
            busy={busy}
            onDownloadDraft={downloadProtectedDraft}
            onRetry={() => failedRequest && generate(false, failedRequest)}
            onDismiss={() => { setError(""); setFailedRequest(null); }}
          />
          {view === "input" ? (
            <>
              <header className="workspace-heading">
                <h1>원고 및 설정</h1>
                <Button variant="ghost" onClick={() => setModal("help")}>
                  <CircleHelp size={16} /> 사용 가이드
                </Button>
              </header>
              <div className="input-layout">
                <ManuscriptPanel
                  manuscript={manuscript}
                  onManuscriptChange={setManuscript}
                  isPdf={isPdf}
                  documentFormat={documentFormat}
                  documentUnit={documentUnit}
                  valid={valid}
                  busy={busy}
                  importing={importing}
                  storageBlocked={storageBlocked}
                  uploadRef={uploadRef}
                  onLoadSample={loadSample}
                  onImport={importFile}
                  onCancelImport={() => importRequestRef.current?.abort()}
                  documentSource={sourceDocument && (
                    <DocumentSource
                      document={sourceDocument}
                      isPdf={isPdf}
                      documentPending={Boolean(documentPending)}
                      generator={generator}
                      disabled={busy || importing}
                      pdf={pdf}
                      onChange={setSourceDocument}
                      onDetach={() => { setSourceDocument(null); pdf.clear(); }}
                      onSelectPages={applyPdfPages}
                      onReupload={() => uploadRef.current?.click()}
                      onFindPart={findDocumentPart}
                      onUseWhole={useWholeDocument}
                    />
                  )}
                />
                <SettingsPanel
                  settings={settings}
                  setSettings={setSettings}
                  keyword={keyword}
                  setKeyword={setKeyword}
                  busy={busy}
                  generator={generator}
                  notify={notify}
                />
              </div>
              <GenerationBar
                settings={settings}
                isPdf={isPdf}
                documentFormat={documentFormat}
                documentUnit={documentUnit}
                canGenerate={canGenerate}
                storageBlocked={storageBlocked}
                generator={generator}
                onOpenConnection={() => setConnectionOpen(true)}
                onGenerate={() => generate()}
              />
            </>
          ) : (
            board && (
              <>
                <header className="workspace-heading">
                  <h1 className="sr-only">스토리보드 편집</h1>
                  <input className="board-title-input" aria-label="콘텐츠 제목" value={board.title} onChange={event => setBoard({ ...board, title: event.target.value })} />
                  <Button className="export-top" onClick={openExport}>
                    <Download size={16} /> 내보내기
                  </Button>
                </header>
                <div className="board-summary" aria-label="생성 조건과 진행 상황">
                  <span className="board-chip">{board.settings.audience}</span>
                  <span className="board-chip">난이도 {board.settings.difficulty}</span>
                  <span className="board-chip">출력 {board.settings.language}</span>
                  <span className={`board-chip ${offTarget ? "is-warning" : ""}`}>
                    <Clock3 size={12} aria-hidden="true" /> 총 {clock(total)} / 목표 {board.settings.minutes}분
                  </span>
                  <span className="board-review-progress">
                    검토 완료 {board.scenes.length - reviewCount}/{board.scenes.length}
                    <span className="board-review-meter" aria-hidden="true">
                      <span style={{ width: `${((board.scenes.length - reviewCount) / board.scenes.length) * 100}%` }} />
                    </span>
                  </span>
                </div>
                <div className="segmented board-mode" role="group" aria-label="편집 보기">
                  {([["scene", "장면 편집"], ["script", "대본 보기"]] as const).map(([mode, label]) => (
                    <button key={mode} aria-pressed={boardMode === mode} className={boardMode === mode ? "active" : ""} onClick={() => setBoardMode(mode)}>{label}</button>
                  ))}
                </div>
                {board.generation?.warnings.filter(warning => warning.startsWith(TERM_CORRECTION_NOTICE_PREFIX)).map(warning => (
                  <p key={warning} className="term-correction-notice" role="status">{warning}</p>
                ))}
                {offTarget && (
                  <div className="duration-warning">
                    <Clock3 size={15} />
                    현재 예상 시간이 목표 길이의 ±15%를 벗어났습니다. 장면별 시간을 조정해 주세요.
                  </div>
                )}
                {boardMode === "script" ? (
                  <ScriptView scenes={board.scenes} onEdit={editSceneAt} onOpen={index => { setActive(index); setBoardMode("scene"); }} />
                ) : <div className="board-layout">
                  <SceneList
                    scenes={board.scenes}
                    active={active}
                    onSelect={setActive}
                    reviewOnly={reviewOnly}
                    onToggleReviewOnly={() => setReviewOnly(!reviewOnly)}
                    reviewCount={reviewCount}
                    onAdd={addScene}
                  />
                  {scene && (
                    <SceneEditor
                      key={scene.id}
                      scene={scene}
                      index={active}
                      sceneCount={board.scenes.length}
                      manuscript={manuscript}
                      sourceFile={pdf.selected}
                      source={isPdf && sourceDocument ? { name: sourceDocument.name, pages: sourceDocument.selectedPages ?? [] } : undefined}
                      onChange={updateScene}
                      onMove={moveActiveScene}
                      onDelete={() => setModal("delete")}
                      onNextReview={nextReview === undefined ? undefined : () => setActive(nextReview)}
                      onRegenerate={() => {
                        setDirection("");
                        setSceneSourceScope("citation");
                        setModal("regenerate");
                      }}
                      canRegenerate={canGenerate}
                      settings={board.settings}
                      imageSettings={board.imageSettings ?? defaultImageSettings}
                      onImageSettingsChange={imageSettings => setBoard(current => current ? { ...current, imageSettings } : current)}
                      onOpenConnection={() => setConnectionOpen(true)}
                    />
                  )}
                </div>}
              </>
            )
          )}
        </main>
      </div>
      <ConnectionDialog open={connectionOpen} onOpenChange={setConnectionOpen} />
      <Toast message={notice} onClose={() => setNotice("")} />
      <ProgressDialog open={busy} progress={progress} generator={generator} onCancel={() => requestRef.current?.abort()} />
      <StudioDialog
        modal={modal}
        onClose={() => setModal(null)}
        board={board}
        reviewCount={reviewCount}
        generator={generator}
        canGenerate={canGenerate}
        filename={filename}
        onFilenameChange={setFilename}
        onExport={exportBoard}
        direction={direction}
        onDirectionChange={setDirection}
        isPdf={isPdf}
        citedPage={citedPage}
        documentUnit={documentUnit}
        sceneSourceScope={sceneSourceScope}
        onSceneSourceScopeChange={setSceneSourceScope}
        onRegenerate={() => generate(true)}
        onReset={reset}
        onRemoveScene={removeActiveScene}
      />
    </div>
  );
}
