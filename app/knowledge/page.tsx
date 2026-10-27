"use client";

import { useEffect, useState } from "react";
import type { KnowledgeDocument, KnowledgeReviewPage, RetrievedReference } from "@/lib/knowledge";

export default function KnowledgePage() {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [title, setTitle] = useState("");
  const [origin, setOrigin] = useState<"official" | "internal">("official");
  const [url, setUrl] = useState("");
  const [published, setPublished] = useState("");
  const [revision, setRevision] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pdfPages, setPdfPages] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<RetrievedReference[] | null>(null);
  const [reviewDocument, setReviewDocument] = useState<string | null>(null);
  const [reviewPages, setReviewPages] = useState<KnowledgeReviewPage[]>([]);
  const [reviewText, setReviewText] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function refresh() {
    const response = await fetch("/api/knowledge", { cache: "no-store" });
    if (!response.ok) throw new Error("지식베이스 목록을 읽지 못했습니다.");
    const result = await response.json();
    setDocuments(result.documents);
  }

  useEffect(() => { refresh().catch((error) => setNotice(error.message)); }, []);

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      const data = new FormData();
      for (const [key, value] of Object.entries({ title, origin, url, published, revision, text, pdfPages })) data.set(key, value);
      if (file) data.set("file", file);
      const response = await fetch("/api/knowledge", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "자료 등록에 실패했습니다.");
      await refresh();
      if (result.document.pendingPages) await openReview(result.document.id);
      setTitle(""); setUrl(""); setPublished(""); setRevision(""); setText(""); setFile(null); setPdfPages("");
      const fileInput = document.getElementById("knowledge-file") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      setNotice(`“${result.document.title}” 자료 ${result.document.chunks}개 구간을 색인했습니다.${result.document.pendingPages ? ` ${result.document.pendingPages}페이지는 확인 전까지 검색에서 제외됩니다.` : ""}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "자료 등록에 실패했습니다."); }
    finally { setBusy(false); }
  }

  async function openReview(id: string) {
    const response = await fetch(`/api/knowledge/review?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("확인할 페이지를 읽지 못했습니다.");
    const result = await response.json();
    setReviewDocument(id);
    setReviewPages(result.pages);
    setReviewText(Object.fromEntries(result.pages.map((page: KnowledgeReviewPage) => [page.page, page.text])));
  }

  async function decide(page: number, action: "approve" | "exclude") {
    if (!reviewDocument || busy) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/knowledge/review", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reviewDocument, page, action, text: reviewText[page] ?? "" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "페이지를 처리하지 못했습니다.");
      await openReview(reviewDocument);
      await refresh();
      setNotice(`${page}페이지를 ${action === "approve" ? "검색 자료로 승인" : "검색에서 제외"}했습니다.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "페이지를 처리하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function recheck(id: string) {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/knowledge/recheck", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "다시 판독하지 못했습니다.");
      await refresh();
      if (reviewDocument === id) await openReview(id);
      setMatches(null);
      setNotice(`${result.autoIndexed}페이지를 자동으로 검색 자료에 추가했습니다.${result.pendingPages ? ` 확인이 필요한 페이지는 ${result.pendingPages}쪽입니다.` : ""}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "다시 판독하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function setActive(document: KnowledgeDocument) {
    if (busy) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/knowledge", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: document.id, active: !document.active }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "자료 상태 변경에 실패했습니다.");
      await refresh();
      setMatches(null);
    } catch (error) { setNotice(error instanceof Error ? error.message : "자료 상태 변경에 실패했습니다."); }
    finally { setBusy(false); }
  }

  async function remove(document: KnowledgeDocument) {
    if (busy || !window.confirm(`“${document.title}” 자료를 완전히 삭제할까요?\n검색 구간, 원본 파일, 판독 기록이 함께 삭제되며 복구할 수 없습니다.`)) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/knowledge", { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: document.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "자료를 삭제하지 못했습니다.");
      if (reviewDocument === document.id) { setReviewDocument(null); setReviewPages([]); setReviewText({}); }
      setMatches(null);
      await refresh();
      setNotice(`“${document.title}” 자료를 삭제했습니다.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "자료를 삭제하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function preview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/knowledge/search", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "검색에 실패했습니다.");
      setMatches(result.references);
    } catch (error) { setNotice(error instanceof Error ? error.message : "검색에 실패했습니다."); }
    finally { setBusy(false); }
  }

  return <main className="knowledge-page">
    <header><a href="/">← 스토리보드로 돌아가기</a><h1>RAG 지식베이스</h1>
      <p>근거 자료를 등록하면 원문을 구간별로 색인합니다. AI 생성은 관련 구간을 찾은 뒤 그 내용과 출처를 사용합니다.</p></header>
    {notice && <p className="knowledge-notice" role="status">{notice}</p>}
    <section className="knowledge-panel">
      <h2>자료 등록</h2>
      <p>PDF·Word·한글·PPT 파일의 글자를 자동으로 읽고, 글자가 없는 페이지에는 OCR을 적용합니다. 실제 표나 판독이 모호한 페이지는 확인 전까지 검색에 넣지 않습니다.</p>
      <form onSubmit={add} className="knowledge-form">
        <label>자료 제목<input required minLength={2} maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>자료 종류<select value={origin} onChange={(event) => setOrigin(event.target.value as "official" | "internal")}>
          <option value="official">공식 자료</option><option value="internal">내부 승인 자료</option>
        </select></label>
        <label>출처 주소 {origin === "official" ? "(필수)" : "(선택)"}<input type="url" required={origin === "official"} maxLength={500} value={url} onChange={(event) => setUrl(event.target.value)} /></label>
        <label>발행일·기준일 (선택)<input maxLength={100} value={published} onChange={(event) => setPublished(event.target.value)} placeholder="예: 2026-10-01" /></label>
        <label>판본·개정 정보 (선택)<input maxLength={100} value={revision} onChange={(event) => setRevision(event.target.value)} /></label>
        <label>문서 파일<input id="knowledge-file" type="file" accept=".pdf,.docx,.txt,.hwp,.hwpx,.ppt,.pptx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        <label>페이지 범위 (선택)<input value={pdfPages} onChange={(event) => setPdfPages(event.target.value)} placeholder="예: 11, 15-17" /></label>
        <label className="knowledge-wide">본문 텍스트 (파일 대신 입력 가능)<textarea rows={6} maxLength={200000} value={text} onChange={(event) => setText(event.target.value)} /></label>
        <button disabled={busy || (!file && text.trim().length < 30)} type="submit">{busy ? "자료 읽는 중…" : "자료 읽고 색인하기"}</button>
      </form>
    </section>
    <section className="knowledge-panel">
      <h2>등록 자료 <small>{documents.filter((document) => document.active && document.chunks > 0).length}개 검색 가능</small></h2>
      {!documents.length && <p>아직 등록된 자료가 없습니다. 관련 자료를 등록해야 AI 스토리보드를 생성할 수 있습니다.</p>}
      <div className="knowledge-documents">{documents.map((document) => <article key={document.id}>
        <div><strong>{document.title}</strong><span>{!document.active ? "보관" : document.chunks ? "검색 가능" : document.pendingPages ? "검토 대기" : "검색 구간 없음"} · {document.origin === "official" ? "공식" : "내부"} · {document.chunks}개 구간{document.pendingPages ? ` · 확인 필요 ${document.pendingPages}페이지` : ""}</span></div>
        <p>{document.published || "발행일 미기재"}{document.revision ? ` · ${document.revision}` : ""}</p>
        {document.url && <a href={document.url} target="_blank" rel="noopener noreferrer">원본 출처 열기</a>}
        <button type="button" disabled={busy} onClick={() => setActive(document)}>{document.active ? "검색에서 제외" : "다시 활성화"}</button>
        <button type="button" className="knowledge-delete" disabled={busy} onClick={() => remove(document)}>완전 삭제</button>
        {document.pendingPages ? <><button type="button" disabled={busy} onClick={() => recheck(document.id)}>미확인 페이지 다시 판독</button>
          <button type="button" disabled={busy} onClick={() => openReview(document.id).catch((error) => setNotice(error.message))}>확인할 페이지 보기</button></> : null}
      </article>)}</div>
    </section>
    {reviewDocument && reviewPages.some((page) => page.status === "pending") && <section className="knowledge-panel" id="knowledge-review">
      <h2>판독 확인</h2>
      <p>각 페이지 제목에 확인이 필요한 이유가 표시됩니다. 원본과 추출 글을 비교해 빠진 글자나 표의 행·열 연결만 확인해 주세요. 승인 전 페이지는 검색되지 않습니다.</p>
      {reviewPages.filter((page) => page.status === "pending").map((page) => <article className="knowledge-review" key={page.page}>
        <h3>{page.page}페이지 · {page.reviewReason}</h3>
        <div className="knowledge-review-columns">
          <img alt={`${page.page}페이지 원본`} src={`/api/knowledge/page?id=${encodeURIComponent(reviewDocument)}&page=${page.filePage}`} />
          <label>읽은 글<textarea value={reviewText[page.page] ?? ""} onChange={(event) => setReviewText((previous) => ({ ...previous, [page.page]: event.target.value }))} /></label>
        </div>
        <div className="knowledge-review-actions"><button type="button" disabled={busy || (reviewText[page.page] ?? "").trim().length < 10} onClick={() => decide(page.page, "approve")}>이 내용 승인</button>
          <button type="button" disabled={busy} onClick={() => decide(page.page, "exclude")}>이 페이지 제외</button></div>
      </article>)}
    </section>}
    <section className="knowledge-panel">
      <h2>검색 미리보기</h2>
      <form onSubmit={preview} className="knowledge-search"><input aria-label="검색할 원고나 주제" minLength={3} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="원고 제목이나 핵심 내용을 입력하세요" /><button disabled={busy || query.trim().length < 3}>검색</button></form>
      {matches && <div className="knowledge-matches">{matches.length ? matches.map((match) => <article key={match.id}>
        <strong>{match.title}{match.page ? ` · ${match.page}페이지` : ""}</strong><p>{match.excerpt}</p>
      </article>) : <p>관련 근거를 찾지 못했습니다.</p>}</div>}
    </section>
  </main>;
}
