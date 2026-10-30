"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, ImageIcon, RotateCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { KnowledgeStructure, KnowledgeTable } from "@/lib/knowledge-structure";

function StructureTable({ table }: { table: KnowledgeTable }) {
  return <div className="knowledge-table-scroll" tabIndex={0} role="region" aria-label="보존된 표 · 넓은 표는 좌우로 스크롤"><table className="knowledge-structure-table"><tbody>
    {Array.from({ length: table.rows }, (_, index) => <tr key={index}>
      {table.cells.filter(cell => cell.row === index + 1).sort((a,b) => a.col - b.col).map(cell =>
        <td key={cell.col} rowSpan={cell.rowSpan} colSpan={cell.colSpan}>{cell.text || <span className="empty-answer">빈 칸 · 미기입</span>}</td>)}
    </tr>)}
  </tbody></table></div>;
}
function pageLabel(page: KnowledgeStructure) {
  return [`원본 ${page.page}페이지`, page.tables.length ? `표 ${page.tables.length}개` : "", page.figures.length ? `그림 ${page.figures.length}개` : !page.analyzed && page.figureCandidates?.length ? `그림 후보 ${page.figureCandidates.length}개` : "", page.proposedTables.length || page.tableWarnings?.length ? "표 확인 필요" : ""].filter(Boolean).join(" · ");
}
type AnalysisState = { pages: KnowledgeStructure[]; ai: { available: boolean; error?: string; perPageCeilingUSD?: number; reservationUSD?: number } };

export function KnowledgeStructurePanel({ documentId, title, initialPage, initialBlockId, initialFigureId, onChange, onBusyChange }: {
  documentId: string; title: string; initialPage?: number; initialBlockId?: string; initialFigureId?: string; onChange: () => Promise<void>; onBusyChange: (busy: boolean) => void;
}) {
  const [state, setState] = useState<AnalysisState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showEmptyPages, setShowEmptyPages] = useState(Boolean(initialPage));
  const [pageNumber, setPageNumber] = useState<number | null>(initialPage ?? null);
  const targetRef = useRef<HTMLElement>(null);
  const lock = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/knowledge/structure?id=${encodeURIComponent(documentId)}`, { cache: "no-store", signal });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "분석 내용을 읽지 못했습니다.");
    setState(data);
  }, [documentId]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [load]);
  const relevantPages = state?.pages.filter(page => page.tables.length || page.figures.length ||
    page.proposedTables.length || page.tableWarnings?.length || (!page.analyzed && page.figureCandidates?.length)) ?? [];
  const hiddenPageCount = (state?.pages.length ?? 0) - relevantPages.length;
  const visiblePages = showEmptyPages ? state?.pages ?? [] : relevantPages;
  const selectedPage = visiblePages.find(page => page.page === pageNumber) ?? visiblePages[0];
  const pageIndex = selectedPage ? visiblePages.indexOf(selectedPage) : -1;
  useEffect(() => { targetRef.current?.scrollIntoView({ block: "nearest" }); }, [state, selectedPage?.page]);

  async function act(action: Record<string, unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError("");
    setNotice(action.action === "analyze" ? "그림과 관련 문장을 연결하고 있습니다. 결과가 이 페이지 아래에 표시됩니다…" : "변경 내용을 저장하고 있습니다…");
    try {
      const response = await fetch("/api/knowledge/structure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: documentId, ...action }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "분석을 처리하지 못했습니다.");
      await load(); await onChange();
      setNotice(action.action === "analyze" ? data.cached ? "저장된 연결 결과를 불러왔습니다." : "연결 결과를 저장했습니다. 아래 그림과 인용문을 확인해 주세요."
        : action.action === "prepare" ? "원본에서 표와 페이지 목록을 갱신했습니다." : "검토 결과를 저장하고 검색에 반영했습니다.");
    } catch (error) { setNotice(""); setError(error instanceof Error ? error.message : "처리하지 못했습니다."); }
    finally { setBusy(false); onBusyChange(false); lock.current = false; }
  }

  return <section className="knowledge-structure-panel" aria-label={`${title} 표와 그림`}>
    <div className="kb-section-heading"><div><h3>표와 그림</h3><p>페이지를 선택해 원본 구조와 관련 문장을 확인하세요.</p></div>{state && <span className="kb-count">{relevantPages.length}쪽에 자료 있음</span>}</div>
    {error && <div className="kb-alert error" role="alert">{error}{!state && <Button variant="ghost" onClick={() => { setError(""); load().catch(error => setError(error.message)); }}>다시 불러오기</Button>}</div>}
    {notice && <p role="status" className="kb-alert">{notice}</p>}
    {!state && !error && <p className="kb-empty-inline" role="status">표와 그림을 불러오는 중…</p>}
    {state && !visiblePages.length && <div className="kb-complete"><ImageIcon size={28} /><h3>감지된 표·그림이 없습니다</h3><p>원본에 표나 그림이 있다면 아래에서 페이지를 모두 표시하거나 구조를 갱신해 주세요.</p></div>}
    {state && initialPage && !state.pages.some(page => page.page === initialPage) && <p className="kb-alert warning">연결된 원본 {initialPage}페이지가 현재 자료에 없습니다.</p>}
    {selectedPage && <div className="kb-page-picker"><label>확인할 페이지<select disabled={busy} value={selectedPage.page} onChange={event => { setPageNumber(Number(event.target.value)); setNotice(""); }}>{visiblePages.map(page => <option key={page.page} value={page.page}>{pageLabel(page)}</option>)}</select></label><span>{pageIndex + 1} / {visiblePages.length}</span><Button variant="outline" size="icon" aria-label="이전 표·그림 페이지" disabled={busy || pageIndex <= 0} onClick={() => { setPageNumber(visiblePages[pageIndex - 1].page); setNotice(""); }}><ChevronLeft size={16} /></Button><Button variant="outline" size="icon" aria-label="다음 표·그림 페이지" disabled={busy || pageIndex >= visiblePages.length - 1} onClick={() => { setPageNumber(visiblePages[pageIndex + 1].page); setNotice(""); }}><ChevronRight size={16} /></Button></div>}
    {hiddenPageCount > 0 && <label className="kb-checkbox"><input type="checkbox" checked={showEmptyPages} disabled={busy} onChange={event => setShowEmptyPages(event.target.checked)} />표·그림 미감지 페이지 {hiddenPageCount}쪽도 표시</label>}
    {selectedPage && [selectedPage].map(page => <div className="kb-page-content" key={page.page}>
      <div className="kb-page-heading-row"><h4>원본 {page.page}페이지</h4><a className="kb-text-link" href={`/api/knowledge/file?id=${encodeURIComponent(documentId)}#page=${page.filePage}`} target="_blank" rel="noopener noreferrer">원본 보기<ArrowUpRight size={14} /></a></div>
      {!page.searchable && <p className="kb-alert warning">판독 확인이 필요한 페이지입니다. 표나 그림·인용문을 개별 승인하면 승인한 내용만 검색됩니다.</p>}
      {page.blocks.filter(block => block.id === initialBlockId).map(block => <blockquote className="knowledge-source-target" ref={element => { if (!initialFigureId) targetRef.current = element; }} key={block.id}>스토리보드에서 확인한 근거: <mark>{block.text}</mark></blockquote>)}
      {page.page === initialPage && initialBlockId && !page.blocks.some(block => block.id === initialBlockId) && <p className="kb-alert warning">연결된 근거 구절이 변경되었거나 삭제되었습니다. 스토리보드에 저장된 인용문과 원본을 비교해 주세요.</p>}
      {page.page === initialPage && initialFigureId && !page.figures.some(figure => figure.id === initialFigureId) && <p className="kb-alert warning">연결된 그림이 현재 자료에 없습니다. 연결 분석 결과가 변경되었을 수 있습니다.</p>}
      {page.tableWarnings?.map(warning => <p key={warning} className="kb-alert warning">{warning}</p>)}
      {page.tables.map((table, index) => <div className="kb-table-section" key={table.id}><h4>보존된 표{page.tables.length > 1 ? ` ${index + 1}` : ""}</h4><StructureTable table={table} />
        {table.cells.filter(cell => cell.text.includes("[원본 기호 확인]")).map(cell => <form key={`${cell.row}:${cell.col}`} className="kb-cell-review" onSubmit={event => {
          event.preventDefault(); const form = new FormData(event.currentTarget);
          act({ action: "cell", page: page.page, tableId: table.id, row: cell.row, col: cell.col, text: String(form.get("text") ?? "") });
        }}><label>{cell.row}행 {cell.col}열 · 원본의 기호를 확인해 주세요<textarea name="text" defaultValue={cell.text} rows={2} /></label><Button variant="outline" type="submit" disabled={busy}>이 셀 저장</Button></form>)}
      </div>)}
      {page.proposedTables.map(table => <div className="knowledge-table-proposal" key={table.id}><h4>AI가 읽은 표 · 확인 필요</h4><StructureTable table={table} /><p className="kb-hint">원본과 행·열·병합 범위·체크 표시를 비교하세요. 빈 칸은 미기입 상태입니다.</p><div className="kb-inline-actions"><Button disabled={busy} onClick={() => act({ action: "table", page: page.page, tableId: table.id, approve: true })}>표를 검색에 반영</Button><Button variant="ghost" disabled={busy} onClick={() => act({ action: "table", page: page.page, tableId: table.id, approve: false })}>이 표 제외</Button></div></div>)}
      <div className="kb-figure-heading"><div><h4>그림과 관련 문장 {page.figures.length > 0 && <span>· {page.figures.length}개</span>}</h4><p className="kb-hint">확인된 그림은 해당 문장을 인용하는 스토리보드에 추천됩니다.</p></div>
        {!page.analyzed && <Button variant="outline" disabled={busy || !state?.ai.available} onClick={() => act({ action: "analyze", page: page.page })}><Sparkles size={15} />{busy ? "처리 중…" : `이 페이지 연결 분석 · 최대 $${state?.ai.perPageCeilingUSD?.toFixed(4) ?? "—"}`}</Button>}
      </div>
      {!page.analyzed && <div className="kb-analysis-note">{state?.ai.available ? <details><summary>AI 분석 안내 · GPT-5.4 mini</summary><p>이 페이지 이미지와 문장을 OpenAI로 전송합니다. 호출 전 ${state.ai.reservationUSD?.toFixed(4)}를 예약하고 미사용분은 반환합니다. 기존 사용 한도를 적용하며 저장된 분석은 다시 호출하지 않습니다.</p></details> : <p>{state?.ai.error || "모델 연결을 확인해 주세요."}</p>}</div>}
      <div className="knowledge-figure-grid">{page.figures.map(figure => <article className={`knowledge-figure-card${figure.id === initialFigureId ? " knowledge-source-target" : ""}`} ref={figure.id === initialFigureId ? targetRef : undefined} key={figure.id}>
        <img loading="lazy" alt={figure.title} src={`/api/knowledge/figure?id=${encodeURIComponent(documentId)}&page=${page.page}&figure=${encodeURIComponent(figure.id)}`} /><h4>{figure.title}</h4>
        {page.links.filter(link => link.figureId === figure.id).map(link => <div className="knowledge-figure-link" key={link.id}><span className={`kb-status ${link.status === "verified" ? "success" : link.status === "pending" ? "warning" : ""}`}>{link.status === "verified" ? "추천 가능" : link.status === "pending" ? "연결 확인 필요" : "추천 제외"}</span><blockquote>{link.quote}</blockquote><p className="kb-hint">{link.reason}</p><div className="kb-inline-actions">
          {link.status !== "verified" && <Button variant={link.status === "pending" ? "default" : "outline"} disabled={busy} onClick={() => act({ action: "link", page: page.page, linkId: link.id, approve: true })}>연결 승인</Button>}
          {link.status !== "rejected" && <Button variant="ghost" disabled={busy} onClick={() => act({ action: "link", page: page.page, linkId: link.id, approve: false })}>추천에서 제외</Button>}
        </div></div>)}{!page.links.some(link => link.figureId === figure.id) && <p className="kb-hint">확인된 관련 문장이 없어 자동 추천하지 않습니다.</p>}
      </article>)}</div>
      {!page.figures.length && <p className="kb-empty-inline">{page.analyzed ? "연결할 독립적인 그림을 찾지 못했습니다." : "아직 연결 분석을 하지 않았습니다. 필요한 페이지에서만 분석을 실행하세요."}</p>}
    </div>)}
    <details className="kb-maintenance"><summary>표가 원본과 다르게 보이나요?</summary><p>원본에서 표 구조를 다시 읽습니다. 새로 등록할 필요가 없으며 AI 비용은 발생하지 않습니다.</p><Button variant="outline" disabled={busy} onClick={() => act({ action: "prepare" })}><RotateCw size={14} />표 구조 다시 읽기 · 무료</Button></details>
  </section>;
}
