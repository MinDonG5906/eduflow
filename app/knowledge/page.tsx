"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronRight, FileText, MoreHorizontal, Plus, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { KnowledgeDocument, RetrievedReference } from "@/lib/knowledge";
import { KnowledgeStructurePanel } from "@/components/knowledge-structure-panel";
import { KnowledgeSource } from "@/components/knowledge-source";
import { KnowledgeReviewPanel } from "@/components/knowledge-review-panel";

type DetailView = "structure" | "review" | "info";
type Filter = "all" | "review" | "archived";
function DocumentStatus({ document }: { document: KnowledgeDocument }) {
  return <span className={`kb-status ${!document.active ? "" : document.pendingPages ? "warning" : document.chunks ? "success" : ""}`}>
    {!document.active ? "검색 제외" : document.pendingPages ? <><TriangleAlert size={12} />{document.pendingPages}쪽 확인 필요</> : document.chunks ? <><Check size={12} />검색 가능</> : "검색 구간 없음"}
  </span>;
}

export default function KnowledgePage() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"library" | "search">("library");
  const [detail, setDetail] = useState<DetailView>("structure");
  const [filter, setFilter] = useState<Filter>("all");
  const [documentQuery, setDocumentQuery] = useState("");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDocument | null>(null);
  const [inputMode, setInputMode] = useState<"file" | "text">("file");
  const [title, setTitle] = useState("");
  const [origin, setOrigin] = useState<"official" | "internal">("official");
  const [url, setUrl] = useState("");
  const [published, setPublished] = useState("");
  const [revision, setRevision] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pdfPages, setPdfPages] = useState("");
  const [query, setQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [matches, setMatches] = useState<RetrievedReference[] | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [structureRevision, setStructureRevision] = useState(0);
  const [sourceTarget, setSourceTarget] = useState<{ documentId: string; page?: number; blockId?: string; figureId?: string } | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const justRegistered = useRef(false);
  const draftCache = useRef<Record<string, Record<number, string>>>({});
  const busy = !!action || panelBusy;
  const selected = documents.find(document => document.id === selectedId);
  const reviewCount = documents.filter(document => document.pendingPages).length;
  const visibleDocuments = documents.filter(document => (filter !== "review" || document.pendingPages) &&
    (filter !== "archived" || !document.active) && document.title.toLocaleLowerCase().includes(documentQuery.toLocaleLowerCase()));

  async function refresh() {
    const response = await fetch("/api/knowledge", { cache: "no-store" });
    if (!response.ok) throw new Error("자료 목록을 읽지 못했습니다. 다시 시도해 주세요.");
    const result = await response.json();
    setDocuments(result.documents);
    return result.documents as KnowledgeDocument[];
  }
  useEffect(() => {
    refresh().then(documents => {
      const params = new URLSearchParams(window.location.search);
      const id = params.get("document");
      if (!id) return;
      const document = documents.find(document => document.id === id);
      if (!document) { setError("연결된 지식베이스 자료를 찾을 수 없습니다. 삭제되었거나 이 PC에 저장되지 않았을 수 있습니다."); return; }
      const page = Number(params.get("page"));
      setSourceTarget({ documentId: id, ...(Number.isSafeInteger(page) && page > 0 ? { page } : {}), blockId: params.get("block") ?? undefined, figureId: params.get("figure") ?? undefined });
      selectDocument(document, document.hasFile ? "structure" : "info");
    }).catch(error => setError(error.message)).finally(() => setLoading(false));
  }, []);

  function selectDocument(document: KnowledgeDocument, target?: DetailView) {
    setSelectedId(document.id); setView("library");
    setDetail(target ?? (document.pendingPages ? "review" : document.hasFile ? "structure" : "info"));
    setNotice(""); setError("");
    requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 1000px)").matches) detailRef.current?.scrollIntoView({ block: "start" });
      detailRef.current?.focus({ preventScroll: true });
    });
  }
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setAction("add"); setFormError("");
    try {
      const data = new FormData();
      for (const [key, value] of Object.entries({ title, origin, url, published, revision, text: inputMode === "text" ? text : "", pdfPages: inputMode === "file" ? pdfPages : "" })) data.set(key, value);
      if (inputMode === "file" && file) data.set("file", file);
      const response = await fetch("/api/knowledge", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "자료 등록에 실패했습니다.");
      await refresh(); setFilter("all"); setDocumentQuery(""); selectDocument(result.document); justRegistered.current = true; setRegisterOpen(false);
      setTitle(""); setUrl(""); setPublished(""); setRevision(""); setText(""); setFile(null); setPdfPages("");
      setNotice(`자료를 등록했습니다. ${result.document.chunks}개 구간을 검색할 수 있습니다.${result.document.pendingPages ? " 확인할 페이지를 아래에서 검토해 주세요." : ""}`);
    } catch (error) { setFormError(error instanceof Error ? error.message : "자료 등록에 실패했습니다."); }
    finally { setAction(null); }
  }
  async function setActive(document: KnowledgeDocument) {
    if (busy) return; setAction("toggle"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/knowledge", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: document.id, active: !document.active }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "자료 상태를 바꾸지 못했습니다.");
      await refresh(); setMatches(null);
      setNotice(document.active ? "스토리보드 근거 검색에서 제외했습니다. 자료 관리에서 다시 포함할 수 있습니다." : "스토리보드 근거 검색에 다시 포함했습니다.");
    } catch (error) { setError(error instanceof Error ? error.message : "자료 상태를 바꾸지 못했습니다."); }
    finally { setAction(null); }
  }
  async function remove() {
    if (!deleteTarget || busy) return; setAction("delete"); setFormError("");
    try {
      const response = await fetch("/api/knowledge", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: deleteTarget.id }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "자료를 삭제하지 못했습니다.");
      setSelectedId(null); setMatches(null); await refresh(); setDeleteTarget(null); setNotice("자료를 삭제했습니다.");
    } catch (error) { setFormError(error instanceof Error ? error.message : "자료를 삭제하지 못했습니다."); }
    finally { setAction(null); }
  }
  async function preview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setAction("search"); setError(""); setMatches(null); setSearchedQuery(query.trim());
    try {
      const response = await fetch("/api/knowledge/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "검색에 실패했습니다.");
      setMatches(result.references);
    } catch (error) { setError(error instanceof Error ? error.message : "검색에 실패했습니다."); }
    finally { setAction(null); }
  }

  return <div className="knowledge-shell">
    <a className="skip-link" href="#knowledge-main">자료 관리로 건너뛰기</a>
    <aside className="sidebar kb-sidebar" aria-label="워크스페이스 탐색">
      <a className="brand" href="/"><div className="brand-symbol" aria-hidden="true"><span /><span /><span /></div><span>EduFlow</span></a>
      <div className="workspace-label">MY WORKSPACE <span>개인</span></div>
      <div className="nav-caption">스튜디오</div>
      <a className="nav-item" href="/"><FileText size={18} />스토리보드 작업<ChevronRight size={14} /></a>
      <a className="nav-item selected" href="/knowledge" aria-current="page"><BookOpen size={18} />지식베이스<ChevronRight size={14} /></a>
      <div className="sidebar-bottom"><div className="privacy"><ShieldCheck size={16} /><span>원본과 검토 결과는 이 PC에 보관</span></div><div className="profile"><div className="avatar">E</div><div><strong>나의 워크스페이스</strong><small>로컬 프로토타입</small></div></div></div>
    </aside>
    <div className="kb-workspace">
      <header className="kb-topbar"><a href="/" className="kb-back"><ArrowLeft size={16} />스토리보드</a><span className="kb-breadcrumb">워크스페이스 <ChevronRight size={14} />지식베이스</span><span className="kb-local"><ShieldCheck size={14} />로컬 보관</span></header>
      <main id="knowledge-main" className="kb-main">
        <div className="kb-page-heading"><div><h1>지식베이스</h1><p>스토리보드가 참고할 자료와 원문 근거를 관리하세요.</p></div><Button disabled={busy} onClick={() => { setFormError(""); setRegisterOpen(true); }}><Plus size={16} />자료 등록</Button></div>
        <nav className="kb-view-nav" aria-label="지식베이스 작업"><button aria-current={view === "library" ? "page" : undefined} disabled={busy} onClick={() => { setView("library"); setError(""); }}>등록 자료 <span>{documents.length}</span></button><button aria-current={view === "search" ? "page" : undefined} disabled={busy} onClick={() => { setView("search"); setError(""); }}><Search size={15} />근거 검색</button></nav>
        {error && <div className="kb-alert error" role="alert"><TriangleAlert size={16} /><span>{error}</span>{!documents.length && <Button variant="ghost" onClick={() => { setError(""); setLoading(true); refresh().catch(error => setError(error.message)).finally(() => setLoading(false)); }}>다시 시도</Button>}</div>}
        <div hidden={view !== "library"}><div className="kb-library">
          <section className="kb-document-list" aria-label="등록 자료 목록">
            <label className="kb-list-search"><Search size={16} /><input aria-label="자료 제목 검색" placeholder="자료 제목 찾기" value={documentQuery} onChange={event => setDocumentQuery(event.target.value)} /></label>
            <div className="kb-filters" aria-label="자료 필터">{([ ["all", "전체", documents.length], ["review", "확인 필요", reviewCount], ["archived", "검색 제외", documents.filter(d => !d.active).length] ] as const).map(([value, label, count]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{count}</span></button>)}</div>
            <div className="kb-document-items" aria-busy={loading}>
              {loading ? <p className="kb-empty-inline" role="status">자료를 불러오는 중…</p> : visibleDocuments.length ? visibleDocuments.map(document => <button className={`kb-document-item ${selectedId === document.id ? "selected" : ""}`} key={document.id} disabled={busy} aria-pressed={selectedId === document.id} aria-controls="knowledge-detail" onClick={() => selectDocument(document)}>
                <div className="kb-document-title"><FileText size={18} /><strong>{document.title}</strong><ChevronRight size={15} /></div>
                <span className="kb-document-meta">{document.origin === "official" ? "공식 자료" : "내부 자료"} · {document.chunks}개 검색 구간</span><DocumentStatus document={document} />
              </button>) : <div className="kb-empty-inline"><p>{documents.length ? "조건에 맞는 자료가 없습니다." : "아직 등록된 자료가 없습니다."}</p>{documents.length ? <Button variant="ghost" onClick={() => { setFilter("all"); setDocumentQuery(""); }}>필터 초기화</Button> : <Button variant="outline" onClick={() => setRegisterOpen(true)}>첫 자료 등록</Button>}</div>}
            </div>
          </section>
          <section id="knowledge-detail" className="kb-detail" ref={detailRef} tabIndex={-1} aria-label={selected ? `${selected.title} 상세` : "자료 상세"}>
            {notice && <div className="kb-alert" role="status"><Check size={16} /><span>{notice}</span></div>}
            {selected ? <>
              <header className="kb-detail-heading"><div><span className="kb-eyebrow">선택한 자료</span><h2>{selected.title}</h2><div className="kb-detail-meta"><DocumentStatus document={selected} /><span>{selected.published || "발행일 미기재"}{selected.revision ? ` · ${selected.revision}` : ""}</span></div></div>
                <details className="kb-manage" key={selected.id} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.removeAttribute("open"); event.currentTarget.querySelector("summary")?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute("open"); }}><summary aria-label="선택한 자료 관리"><MoreHorizontal size={18} /><span>자료 관리</span></summary><div><Button variant="ghost" disabled={busy} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setActive(selected); }}>{selected.active ? "근거 검색에서 제외" : "근거 검색에 다시 포함"}</Button><Button variant="ghost" className="kb-danger" disabled={busy} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setFormError(""); setDeleteTarget(selected); }}>자료 삭제…</Button></div></details>
              </header>
              {!selected.active && <div className="kb-alert warning">이 자료는 근거 검색에서 제외되어 있습니다. 자료 관리에서 다시 포함할 수 있습니다.</div>}
              <nav className="kb-detail-nav" aria-label="선택한 자료 보기">{([ ["structure", "표·그림"], ["review", `판독 확인${selected.pendingPages ? ` ${selected.pendingPages}` : ""}`], ["info", "자료 정보"] ] as const).map(([value, label]) => <button key={value} disabled={busy || (value !== "info" && !selected.hasFile)} aria-current={detail === value ? "page" : undefined} onClick={() => setDetail(value)}>{label}</button>)}</nav>
              <div className="kb-detail-body">
                {selected.hasFile && <div hidden={detail !== "structure"}><KnowledgeStructurePanel key={`${selected.id}:${structureRevision}`} documentId={selected.id} title={selected.title} initialPage={sourceTarget?.documentId === selected.id ? sourceTarget.page : undefined} initialBlockId={sourceTarget?.documentId === selected.id ? sourceTarget.blockId : undefined} initialFigureId={sourceTarget?.documentId === selected.id ? sourceTarget.figureId : undefined} onChange={async () => { await refresh(); }} onBusyChange={setPanelBusy} /></div>}
                {selected.hasFile && <div hidden={detail !== "review"}><KnowledgeReviewPanel key={selected.id} documentId={selected.id} initialDrafts={draftCache.current[selected.id]} onDraftsChange={drafts => { draftCache.current[selected.id] = drafts; }} onChange={async () => { await refresh(); }} onBusyChange={setPanelBusy} onRecheck={() => setStructureRevision(value => value + 1)} /></div>}
                {detail === "info" && <div className="kb-info"><h3>자료 정보</h3><dl><div><dt>자료 종류</dt><dd>{selected.origin === "official" ? "공식 자료" : "내부 승인 자료"}</dd></div><div><dt>검색 가능 구간</dt><dd>{selected.chunks}개</dd></div><div><dt>발행일·기준일</dt><dd>{selected.published || "미기재"}</dd></div><div><dt>판본·개정 정보</dt><dd>{selected.revision || "미기재"}</dd></div></dl><div className="kb-inline-actions">{selected.hasFile && <a className="kb-link-button" href={`/api/knowledge/file?id=${selected.id}`} target="_blank" rel="noopener noreferrer"><FileText size={15} />등록한 원본 PDF<ArrowUpRight size={14} /></a>}{selected.url && <a className="kb-link-button" href={selected.url} target="_blank" rel="noopener noreferrer">원본 출처<ArrowUpRight size={14} /></a>}</div>{!selected.hasFile && <p className="kb-hint">본문으로 등록한 자료입니다. 표·그림을 확인하려면 원본 파일을 새 자료로 등록해 주세요.</p>}</div>}
              </div>
            </> : <div className="kb-empty-detail"><BookOpen size={30} strokeWidth={1.4} /><h2>{documents.length ? "확인할 자료를 선택하세요" : "근거 자료부터 준비해 보세요"}</h2><p>{documents.length ? "목록에서 자료를 선택하면 표·그림과 확인할 페이지가 이곳에 표시됩니다." : "자료를 등록하면 스토리보드에 사용할 문장과 출처를 찾을 수 있습니다."}</p>{!documents.length && !loading && <Button onClick={() => setRegisterOpen(true)}><Plus size={16} />자료 등록</Button>}</div>}
          </section>
        </div></div><div hidden={view !== "search"}><section className="kb-search-panel"><h2>스토리보드에 사용할 근거 찾기</h2><p>등록된 자료에서 원고 주제와 관련된 문장과 출처를 확인하세요.</p><form onSubmit={preview} className="kb-search-form"><label className="kb-list-search"><Search size={18} /><input aria-label="검색할 원고나 주제" required minLength={3} value={query} onChange={event => setQuery(event.target.value)} placeholder="예: 밀폐공간 작업 전 환기 방법" /></label><Button disabled={busy || query.trim().length < 3}>{action === "search" ? "검색 중…" : "근거 검색"}</Button></form><p className="kb-hint">3자 이상 입력 · 검색에서 제외한 자료와 미승인 내용은 결과에 포함되지 않습니다.</p>
          {matches && <div className="kb-search-results" aria-live="polite"><h3>“{searchedQuery}” 검색 결과 · {matches.length}개</h3>{matches.length ? matches.map(match => <article key={match.id}><span className="kb-eyebrow">{match.page ? `원본 ${match.page}페이지` : "본문 근거"}</span><h4>{match.title}</h4><blockquote>{match.excerpt}</blockquote><KnowledgeSource references={[match]} /><Button variant="outline" disabled={busy} onClick={() => { const document = documents.find(d => d.id === match.documentId); if (document) { setFilter("all"); setDocumentQuery(""); selectDocument(document, "info"); } }}>자료 상세 보기<ChevronRight size={14} /></Button></article>) : <p className="kb-empty-inline">관련 근거를 찾지 못했습니다. 다른 표현으로 검색하거나 자료의 검토 상태를 확인해 주세요.</p>}</div>}
        </section></div>
      </main>
    </div>
    <Dialog open={registerOpen} onOpenChange={open => { if (!busy) setRegisterOpen(open); }}><DialogContent className="kb-dialog" showCloseButton={!busy} finalFocus={() => { if (justRegistered.current) { justRegistered.current = false; return detailRef.current; } return true; }}><DialogHeader><DialogTitle>근거 자료 등록</DialogTitle><DialogDescription>파일 또는 본문을 등록하고, 판독 결과를 확인하세요.</DialogDescription></DialogHeader>
      <form onSubmit={add} className="kb-register-form"><fieldset disabled={busy}>
        <label>자료 제목<input required minLength={2} maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="예: 밀폐공간 안전작업 가이드" /></label>
        <div className="kb-form-row"><label>자료 종류<select value={origin} onChange={event => setOrigin(event.target.value as "official" | "internal")}><option value="official">공식 자료</option><option value="internal">내부 승인 자료</option></select></label><label>출처 주소 {origin === "official" ? "(필수)" : "(선택)"}<input type="url" required={origin === "official"} maxLength={500} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://" /></label></div>
        <div className="kb-segmented" aria-label="등록 방식"><button type="button" aria-pressed={inputMode === "file"} onClick={() => setInputMode("file")}>파일 업로드</button><button type="button" aria-pressed={inputMode === "text"} onClick={() => setInputMode("text")}>본문 붙여넣기</button></div>
        {inputMode === "file" ? <label className="kb-file-input"><FileText size={24} /><strong>{file?.name || "등록할 문서 파일을 선택하세요"}</strong><span>PDF · Word · 한글 · PPT · TXT / 최대 50MB</span><input type="file" aria-label="문서 파일" accept=".pdf,.docx,.txt,.hwp,.hwpx,.ppt,.pptx" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label> : <label>본문 텍스트<textarea rows={6} minLength={30} maxLength={200000} value={text} onChange={event => setText(event.target.value)} placeholder="본문을 30자 이상 붙여넣으세요." /></label>}
        <details className="kb-optional"><summary>페이지 범위·발행 정보 (선택)</summary><div className="kb-form-row">{inputMode === "file" && <label>페이지 범위<input value={pdfPages} onChange={event => setPdfPages(event.target.value)} placeholder="전체 페이지 · 예: 11, 15-17" /></label>}<label>발행일·기준일<input maxLength={100} value={published} onChange={event => setPublished(event.target.value)} placeholder="예: 2026-10-01" /></label><label>판본·개정 정보<input maxLength={100} value={revision} onChange={event => setRevision(event.target.value)} /></label></div></details>
      </fieldset>{formError && <p className="kb-alert error" role="alert">{formError}</p>}{action === "add" && <p className="kb-alert" role="status">문서를 읽고 있습니다. 완료되면 등록한 자료의 검토 화면으로 이동합니다.</p>}<div className="kb-dialog-actions"><Button variant="outline" type="button" disabled={busy} onClick={() => setRegisterOpen(false)}>취소</Button><Button type="submit" disabled={busy || (inputMode === "file" ? !file : text.trim().length < 30)}>{action === "add" ? "자료 읽는 중…" : "등록하고 확인하기"}</Button></div></form>
    </DialogContent></Dialog>
    <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !busy) setDeleteTarget(null); }}><DialogContent showCloseButton={!busy} finalFocus={() => document.querySelector<HTMLElement>(".kb-manage summary") ?? detailRef.current}><DialogHeader><DialogTitle>자료를 삭제할까요?</DialogTitle><DialogDescription>“{deleteTarget?.title}”의 원본, 검색 구간, 검토 결과를 함께 삭제합니다. 복구할 수 없습니다.</DialogDescription></DialogHeader><p className="kb-hint">잠시 사용하지 않으려면 자료 관리에서 ‘근거 검색에서 제외’를 선택하세요.</p>{formError && <p className="kb-alert error" role="alert">{formError}</p>}<div className="kb-dialog-actions"><Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>취소</Button><Button variant="destructive" disabled={busy} onClick={remove}>{action === "delete" ? "삭제 중…" : "완전히 삭제"}</Button></div></DialogContent></Dialog>
  </div>;
}
