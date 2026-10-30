"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { KnowledgeReviewPage } from "@/lib/knowledge";

export function KnowledgeReviewPanel({ documentId, onChange, onBusyChange, onRecheck, initialDrafts, onDraftsChange }: {
  initialDrafts?: Record<number, string>; onDraftsChange: (drafts: Record<number, string>) => void;
  documentId: string; onChange: () => Promise<void>; onBusyChange: (busy: boolean) => void; onRecheck: () => void;
}) {
  const [pages, setPages] = useState<KnowledgeReviewPage[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>(initialDrafts ?? {});
  const [pageNumber, setPageNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  useEffect(() => { onDraftsChange(drafts); }, [drafts, onDraftsChange]);
  const pending = pages.filter(page => page.status === "pending");
  const page = pending.find(page => page.page === pageNumber) ?? pending[0];
  const index = page ? pending.indexOf(page) : -1;
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/knowledge/review?id=${encodeURIComponent(documentId)}`, { cache: "no-store", signal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "확인할 페이지를 읽지 못했습니다.");
    setPages(result.pages);
    setDrafts(previous => Object.fromEntries(result.pages.map((page: KnowledgeReviewPage) => [page.page, previous[page.page] ?? page.text])));
  }, [documentId]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);

  async function perform(kind: "approve" | "exclude" | "recheck") {
    if (lock.current || (kind !== "recheck" && !page)) return;
    lock.current = true; setAction(kind); onBusyChange(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/knowledge/${kind === "recheck" ? "recheck" : "review"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(kind === "recheck" ? { id: documentId } : { id: documentId, page: page.page, action: kind, text: drafts[page.page] ?? "" }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "처리하지 못했습니다.");
      // Re-reading replaces OCR drafts only after the explicit reread action.
      if (kind === "recheck") setDrafts({});
      await load(); await onChange(); onRecheck();
      setNotice(kind === "recheck" ? `${result.autoIndexed}페이지를 자동으로 검색에 반영했습니다. 남은 페이지를 확인해 주세요.` : `${page.page}페이지를 ${kind === "approve" ? "검색에 반영" : "검색에서 제외"}했습니다.`);
    } catch (error) { setError(error instanceof Error ? error.message : "처리하지 못했습니다."); }
    finally { setAction(null); onBusyChange(false); lock.current = false; }
  }
  if (loading) return <p className="kb-empty-inline" role="status">확인할 페이지를 불러오는 중…</p>;
  return <section aria-label="판독 확인">
    <div className="kb-section-heading"><div><h3>판독 확인 {pending.length > 0 && <span>{pending.length}쪽 남음</span>}</h3><p>원본과 읽은 글을 비교하고, 필요한 부분을 수정해 검색에 반영하세요.</p></div></div>
    {error && <div className="kb-alert error" role="alert">{error}<Button variant="ghost" disabled={!!action} onClick={() => { setError(""); load().catch(error => setError(error.message)); }}>다시 불러오기</Button></div>}
    {notice && <p className="kb-alert" role="status">{notice}</p>}
    {!pending.length && !error ? <div className="kb-complete"><CheckCircle2 size={28} /><h3>확인할 페이지가 없습니다</h3><p>표·그림 탭에서 보존된 구조와 시각자료를 살펴볼 수 있습니다.</p></div> : page && <>
      <div className="kb-page-picker"><label>확인할 페이지<select disabled={!!action} value={page.page} onChange={event => setPageNumber(Number(event.target.value))}>{pending.map(item => <option key={item.page} value={item.page}>원본 {item.page}페이지</option>)}</select></label><span>{index + 1} / {pending.length}</span><Button variant="outline" size="icon" aria-label="이전 확인 페이지" disabled={!!action || index <= 0} onClick={() => setPageNumber(pending[index - 1].page)}><ChevronLeft size={16} /></Button><Button variant="outline" size="icon" aria-label="다음 확인 페이지" disabled={!!action || index >= pending.length - 1} onClick={() => setPageNumber(pending[index + 1].page)}><ChevronRight size={16} /></Button></div>
      <p className="kb-alert warning">확인할 이유: {page.reviewReason}</p>
      <div className="kb-review-columns"><div><div className="kb-column-heading"><h4>원본 {page.page}페이지</h4><a className="kb-text-link" href={`/api/knowledge/file?id=${documentId}#page=${page.filePage}`} target="_blank" rel="noopener noreferrer">크게 보기<ArrowUpRight size={14} /></a></div><img loading="lazy" alt={`원본 ${page.page}페이지`} src={`/api/knowledge/page?id=${documentId}&page=${page.filePage}`} /></div><label>읽은 글 · 수정 가능<textarea disabled={!!action} value={drafts[page.page] ?? ""} onChange={event => setDrafts(previous => ({ ...previous, [page.page]: event.target.value }))} /><span className="kb-hint">전체 내용을 확인한 뒤 반영하세요. 표·그림 탭에서는 일부 내용만 승인할 수도 있습니다.</span></label></div>
      <div className="kb-review-footer"><Button variant="ghost" disabled={!!action} onClick={() => perform("exclude")}>이 페이지 제외</Button><Button disabled={!!action || (drafts[page.page] ?? "").trim().length < 10} onClick={() => perform("approve")}>{action === "approve" ? "반영 중…" : pending.length > 1 ? "반영하고 다음 페이지" : "검색에 반영"}<ChevronRight size={16} /></Button></div>
      <details className="kb-maintenance"><summary>글을 잘못 읽었나요?</summary><p>미확인 페이지를 다시 판독합니다. 아직 저장하지 않은 글 수정 내용은 다시 읽은 내용으로 바뀝니다.</p><Button variant="outline" disabled={!!action} onClick={() => perform("recheck")}><RotateCw size={14} />{action === "recheck" ? "다시 읽는 중…" : "미확인 페이지 다시 읽기"}</Button></details>
    </>}
  </section>;
}
