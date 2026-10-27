"use client";

import { useEffect, useState } from "react";
import type { KnowledgeDocument, RetrievedReference } from "@/lib/knowledge";

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
      setTitle(""); setUrl(""); setPublished(""); setRevision(""); setText(""); setFile(null); setPdfPages("");
      const fileInput = document.getElementById("knowledge-file") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      setNotice(`“${result.document.title}” 자료 ${result.document.chunks}개 구간을 색인했습니다.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "자료 등록에 실패했습니다."); }
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
      <p>PDF·DOCX·TXT 파일 또는 본문 텍스트를 등록할 수 있습니다. 이미지 전용 PDF는 OCR 후 등록해 주세요. 출처와 발행일은 실제 자료에 맞게 입력하세요.</p>
      <form onSubmit={add} className="knowledge-form">
        <label>자료 제목<input required minLength={2} maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>자료 종류<select value={origin} onChange={(event) => setOrigin(event.target.value as "official" | "internal")}>
          <option value="official">공식 자료</option><option value="internal">내부 승인 자료</option>
        </select></label>
        <label>출처 주소 {origin === "official" ? "(필수)" : "(선택)"}<input type="url" required={origin === "official"} maxLength={500} value={url} onChange={(event) => setUrl(event.target.value)} /></label>
        <label>발행일·기준일 (선택)<input maxLength={100} value={published} onChange={(event) => setPublished(event.target.value)} placeholder="예: 2026-10-01" /></label>
        <label>판본·개정 정보 (선택)<input maxLength={100} value={revision} onChange={(event) => setRevision(event.target.value)} /></label>
        <label>문서 파일<input id="knowledge-file" type="file" accept=".pdf,.docx,.txt" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        <label>PDF 원본 페이지 범위 (선택)<input value={pdfPages} onChange={(event) => setPdfPages(event.target.value)} placeholder="예: 11, 15-17" /></label>
        <label className="knowledge-wide">본문 텍스트 (파일 대신 입력 가능)<textarea rows={6} maxLength={200000} value={text} onChange={(event) => setText(event.target.value)} /></label>
        <button disabled={busy || (!file && text.trim().length < 30)} type="submit">자료 색인하기</button>
      </form>
    </section>
    <section className="knowledge-panel">
      <h2>등록 자료 <small>{documents.filter((document) => document.active).length}개 활성</small></h2>
      {!documents.length && <p>아직 등록된 자료가 없습니다. 관련 자료를 등록해야 AI 스토리보드를 생성할 수 있습니다.</p>}
      <div className="knowledge-documents">{documents.map((document) => <article key={document.id}>
        <div><strong>{document.title}</strong><span>{document.active ? "활성" : "보관"} · {document.origin === "official" ? "공식" : "내부"} · {document.chunks}개 구간</span></div>
        <p>{document.published || "발행일 미기재"}{document.revision ? ` · ${document.revision}` : ""}</p>
        {document.url && <a href={document.url} target="_blank" rel="noopener noreferrer">원본 출처 열기</a>}
        <button type="button" disabled={busy} onClick={() => setActive(document)}>{document.active ? "검색에서 제외" : "다시 활성화"}</button>
      </article>)}</div>
    </section>
    <section className="knowledge-panel">
      <h2>검색 미리보기</h2>
      <form onSubmit={preview} className="knowledge-search"><input aria-label="검색할 원고나 주제" minLength={3} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="원고 제목이나 핵심 내용을 입력하세요" /><button disabled={busy || query.trim().length < 3}>검색</button></form>
      {matches && <div className="knowledge-matches">{matches.length ? matches.map((match) => <article key={match.id}>
        <strong>{match.title}{match.page ? ` · ${match.page}페이지` : ""}</strong><p>{match.excerpt}</p>
      </article>) : <p>관련 근거를 찾지 못했습니다.</p>}</div>}
    </section>
  </main>;
}
