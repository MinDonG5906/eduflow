"use client";
import { useEffect, useRef, useState } from "react";
import { Plus, Info } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { validationCounts, type ValidationRun, type ValidationJob } from "@/lib/knowledge-validation";
import type { KnowledgeDocument } from "@/lib/knowledge";

type Settings = { model: boolean; retrieval: boolean; perPageCeiling: number; mode: string };
const endpoint = "/api/knowledge/validation";
const jobLabel = { queued: "자동 처리 대기", processing: "자동 처리 중", waiting: "한도·연결 대기", paused: "일시 중지", complete: "처리 완료", blocked: "실행 설정 확인" };
export function KnowledgeValidationPanel({ documents, onChange, onBusyChange }: {
  documents: KnowledgeDocument[]; onChange: () => Promise<unknown>; onBusyChange: (busy: boolean) => void;
}) {
  const [runs, setRuns] = useState<ValidationRun[]>([]), [jobs, setJobs] = useState<ValidationJob[]>([]);
  const [settings, setSettings] = useState<Settings>(), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false), [infoOpen, setInfoOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [files, setFiles] = useState<File[]>([]), [sourceUrl, setSourceUrl] = useState("");
  const version = useRef(0), change = useRef(onChange), statusKey = useRef("");
  change.current = onChange;
  async function refresh() {
    const requestVersion = ++version.current;
    const response = await fetch(endpoint, { cache: "no-store" }); const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (requestVersion !== version.current) return;
    setRuns(result.runs); setJobs(result.jobs); setSettings(result.settings); setLoaded(true);
    const key = JSON.stringify(result.runs.map((r: ValidationRun) => [r.id, r.status]));
    if (statusKey.current && key !== statusKey.current) await change.current();
    statusKey.current = key;
    if (!result.workerAlive && result.jobs.some((job: ValidationJob) => ["queued", "processing", "waiting"].includes(job.state)))
      await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "wake" }) });

  }
  useEffect(() => {
    let mounted = true;
    const update = () => { if (mounted) refresh().catch(e => { if (mounted) setError(e.message); }); };
    update(); const timer = setInterval(update, 5000);
    return () => { mounted = false; clearInterval(timer); version.current++; };
  }, []);
  function working(value: boolean) { setBusy(value); onBusyChange(value); }
  async function command(action: string, ids: string[] = [], documentIds?: string[]) {
    working(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ids, documentIds }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      const failures = data.results?.filter((item: { error?: string }) => item.error) ?? [];
      if (failures.length) setError(failures.map((item: { error: string }) => item.error).join(" "));
      setNotice(action === "pause" ? "현재 페이지 처리 후 일시 중지합니다." : "자동 처리를 시작합니다.");
      await refresh(); await onChange();
    } catch (e) { setError(e instanceof Error ? e.message : "요청을 처리하지 못했습니다."); }
    finally { working(false); }
  }
  async function upload(event: React.FormEvent) {
    event.preventDefault(); if (!files.length || busy) return;
    if (files.length > 50) { setError("한 번에 PDF 50개까지 선택해 주세요."); return; }
    working(true); setError(""); const failures: string[] = [], remaining: File[] = [];
    try {
      for (const [index, file] of files.entries()) {
        setNotice(`${index + 1}/${files.length} 파일을 등록하고 있습니다.`);
        try {
          const form = new FormData(); form.set("file", file); form.set("auto", "true");
          if (files.length === 1 && sourceUrl) form.set("url", sourceUrl);
          const response = await fetch(endpoint, { method: "POST", body: form }); const data = await response.json();
          if (!response.ok) throw new Error(data.error);
        } catch (e) { remaining.push(file); failures.push(`${file.name}: ${e instanceof Error ? e.message : "등록 실패"}`); }
      }
      setFiles(remaining); setError(failures.join("\n"));
      if (!remaining.length) { setUploadOpen(false); setSourceUrl(""); }
      setNotice(`${files.length - failures.length}개 자료 등록 완료. 자동 처리와 저장은 백그라운드에서 이어집니다.`);
      await refresh();
    } finally { working(false); }
  }
  const visible = runs.filter(run => !run.testOnly);
  const managed = new Set(runs.flatMap(run => [run.localDocumentId, run.sourceDocumentId]));
  const existing = documents.filter(doc => doc.hasFile && doc.active && !managed.has(doc.id) && !doc.title.startsWith("[시험용]"));
  return <section className="kb-validation kb-simple" aria-label="자료 처리 현황">
    <div className="kb-simple-toolbar">
      <p className="kb-quiet-status">{loaded ? `등록 자료 ${visible.length}개` : "처리 상태를 불러오는 중…"}</p>
      <div className="kb-simple-actions"><Button variant="ghost" size="icon" aria-label="자동 처리 안내" onClick={() => setInfoOpen(true)}><Info size={17} /></Button>
        <Button disabled={busy} onClick={() => { setError(""); setNotice(""); setUploadOpen(true); }}><Plus size={16} />자료 추가</Button></div>
    </div>
    {error && !uploadOpen && <p className="kb-alert error" role="alert">{error}</p>}
    {notice && !uploadOpen && <p className="kb-hint" role="status">{notice}</p>}
    {settings && (!settings.model || !settings.retrieval) && <p className="kb-alert warning" role="alert">{!settings.model ? "AI 연결이 필요합니다. 스토리보드의 모델 연결에서 설정해 주세요." : "자료 검색 준비가 필요합니다. 연결 상태를 확인해 주세요."}</p>}
    <div className="kb-simple-list" aria-label="자동 처리 자료 목록">
      {loaded && !visible.length && <p className="kb-empty-inline">PDF를 추가하면 자동으로 처리하고 저장합니다.</p>}
      {visible.map(run => {
        const counts = validationCounts(run), state = jobs.find(j => j.runId === run.id);
        const checked = run.pages.filter(page => ["passed", "processed", "skipped"].includes(page.status)).length;
        const running = !!state && ["queued", "processing", "waiting"].includes(state.state);
        const canResume = !run.quarantine && (!state && run.status !== "published" || state && ["paused", "blocked"].includes(state.state));
        const status = run.quarantine ? "검색 제외" : run.status === "published" ? counts.exceptions ? "일부 저장" : "저장 완료" : state?.state === "complete" ? "처리 완료 · 검색 제외" : state ? jobLabel[state.state] : "처리 전";
        return <article className="kb-simple-row" key={run.id}>
          <div className="kb-simple-document"><h3>{run.metadata.title}</h3>
            <div className="kb-simple-progress"><span className={`kb-status ${state?.state === "blocked" ? "warning" : ""}`}>{status}</span><span>{checked} / {run.pages.length}쪽 처리</span></div>
            {checked < run.pages.length && <progress aria-label={`${run.metadata.title} 처리 진행`} value={checked} max={run.pages.length} />}
            {state?.state === "waiting" && <p className="kb-hint">{state.reason}{state.nextAt > Date.now() ? ` · ${new Date(state.nextAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })} 재개 예정` : ""}</p>}
            {state?.state === "blocked" && <p className="kb-alert warning">{state.reason}</p>}
          </div>
          <div className="kb-simple-actions">
            {running && <Button variant="ghost" disabled={busy} aria-label={`${run.metadata.title} 일시 중지`} onClick={() => command("pause", [run.id])}>일시 중지</Button>}
            {canResume && <Button variant="outline" disabled={busy} onClick={() => command("queue", [run.id])}>{state ? "다시 시작" : "자동 처리"}</Button>}
          </div>
        </article>;
      })}
    </div>
    {existing.length > 0 && <div className="kb-existing-prompt"><span>자동 처리 전인 기존 PDF {existing.length}개</span>
      <Button variant="outline" disabled={busy} onClick={() => command("enqueue-existing", [], existing.slice(0, 50).map(doc => doc.id))}>자동 처리 시작</Button></div>}

    <Dialog open={uploadOpen} onOpenChange={open => { if (!busy) setUploadOpen(open); }}>
      <DialogContent className="kb-dialog" showCloseButton={!busy}><DialogHeader><DialogTitle>자료 추가</DialogTitle><DialogDescription>PDF 최대 50개 · 판독한 내용을 자동 저장합니다.</DialogDescription></DialogHeader>
        <form className="kb-auto-upload kb-simple-upload" onSubmit={upload}>
          <label>PDF 파일<input aria-label="자동 처리할 PDF 파일" type="file" multiple accept=".pdf" disabled={busy} onChange={event => setFiles(Array.from(event.target.files ?? []))} /></label>
          {files.length > 0 && <ul className="kb-upload-files">{files.map((file, i) => <li key={`${file.name}:${i}`}>{file.name}</li>)}</ul>}
          <p className="kb-hint">파일당 최대 50MB · 200쪽</p>
          {files.length === 1 && <label>원문 링크 (선택)<input type="url" disabled={busy} value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} /></label>}
          {error && <p className="kb-alert error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
          <div className="kb-dialog-actions"><Button type="button" variant="outline" disabled={busy} onClick={() => setUploadOpen(false)}>취소</Button><Button type="submit" disabled={busy || !files.length || files.length > 50}>{busy ? "등록 중…" : `${files.length || ""}${files.length ? "개 " : ""}추가하고 자동 처리`}</Button></div>
          {files.length > 50 && <p className="kb-alert error" role="alert">한 번에 50개까지 선택해 주세요.</p>}
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={infoOpen} onOpenChange={setInfoOpen}><DialogContent><DialogHeader><DialogTitle>자동 처리 안내</DialogTitle><DialogDescription>페이지를 한 번 판독한 뒤 검색에 저장합니다.</DialogDescription></DialogHeader>
      <p>AI 재검수와 수동 승인은 진행하지 않습니다. 추출할 내용이 없는 페이지는 건너뛰고 원본은 보관합니다.</p>
      <p>정상 처리 시 페이지당 AI 1회 · 최대 ${settings?.perPageCeiling.toFixed(3) ?? "—"}. 연결 실패 시 최대 3회까지 시도하며, 설정된 호출·비용 한도에 도달하면 기다렸다가 이어서 처리합니다.</p>
      <p>브라우저를 닫아도 이 Mac이 켜져 있으면 처리합니다. Mac 재시작 후에는 지식베이스를 열어 주세요.</p>
    </DialogContent></Dialog>
  </section>;
}
