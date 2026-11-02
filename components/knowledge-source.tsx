"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { knowledgeLocationUrl, type KnowledgeLocation } from "@/lib/knowledge";
import { findSourceMatches } from "@/lib/source-location";
import type { Scene } from "@/lib/storyboard";

type Reference = NonNullable<Scene["references"]>[number];

export function KnowledgeSource({ references, label = "대조하기", context = "자료" }: { references: Reference[]; label?: string; context?: string }) {
  const sources = references.filter((reference): reference is Reference & { documentId: string } => Boolean(reference.documentId));
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(sources[0]?.id);
  const [location, setLocation] = useState<KnowledgeLocation | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const selected = sources.find(reference => reference.id === selectedId) ?? sources[0];
  const id = selected?.documentId, page = selected?.page;
  const matches = useMemo(() => {
    if (!location || !selected) return [];
    const text = location.passages.map(passage => passage.text).join("\n\n");
    const ranges = findSourceMatches(text, selected.excerpt).filter(match => match.kind === "full");
    let offset = 0;
    return location.passages.map(passage => {
      const range = ranges.find(range => range.start < offset + passage.text.length && range.end > offset);
      const match = range ? { start: Math.max(0, range.start - offset), end: Math.min(passage.text.length, range.end - offset) } : undefined;
      offset += passage.text.length + 2;
      return { ...passage, match };
    });
  }, [location, selected?.excerpt]);

  useEffect(() => {
    if (!open || !id) return;
    const controller = new AbortController();
    setLocation(null); setError("");
    const params = new URLSearchParams({ id });
    if (page) params.set("page", String(page));
    void fetch(`/api/knowledge/location?${params}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "자료를 열지 못했습니다.");
        if (!controller.signal.aborted) setLocation(data);
      }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "자료를 열지 못했습니다."); });
    return () => controller.abort();
  }, [open, id, page, attempt]);

  useEffect(() => {
    if (open && location) viewport.current?.querySelector<HTMLElement>("[data-knowledge-hit]")?.scrollIntoView({ block: "nearest" });
  }, [open, location, selected?.id]);

  if (!sources.length) return null;
  const hasMatch = matches.some(passage => passage.match);
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={label === "대조하기" ? `${context} 대조하기` : label}><BookOpen size={14} />{label}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="source-dialog knowledge-source-dialog">
      <DialogHeader><DialogTitle>자료 근거 대조</DialogTitle><DialogDescription>장면에 연결된 인용문을 등록 자료의 원본과 비교하세요.</DialogDescription></DialogHeader>
      {sources.length > 1 && <label className="source-page-select">확인할 근거 자료<select value={selected.id} onChange={event => setSelectedId(event.target.value)}>{sources.map(reference => <option key={reference.id} value={reference.id}>{reference.title}{reference.page ? ` · 원본 ${reference.page}페이지` : " · 등록 본문"}</option>)}</select></label>}
      <div className="knowledge-source-heading"><strong>{selected.title}</strong><small>{selected.page ? `원본 ${selected.page}페이지` : "등록 본문"} · {selected.published || "발행일 미기재"}{selected.revision ? ` · ${selected.revision}` : ""}</small></div>
      <blockquote className="source-evidence-quote">{selected.excerpt}</blockquote>
      {error ? <p role="alert" className="source-message">{error}<Button variant="ghost" size="sm" onClick={() => setAttempt(value => value + 1)}>다시 불러오기</Button></p> : !location ? <p role="status">자료 위치를 불러오는 중…</p> : <>
        {!location.document.active && <p className="source-message">현재 검색에서 제외된 자료입니다. 생성 당시 저장한 근거를 표시합니다.</p>}
        <div className="source-match-status" role="status"><strong>{hasMatch ? "등록 자료에서 근거 구절을 찾았습니다." : "현재 등록 자료에서 동일한 구절을 찾지 못했습니다."}</strong>{!hasMatch && <small>자료가 수정되었을 수 있습니다. 위에 저장된 생성 당시 인용문과 비교해 주세요.</small>}</div>
        <div className="knowledge-source-links"><a href={knowledgeLocationUrl({ ...selected, figureId: selected.visuals?.[0]?.kind === "table" ? undefined : selected.visuals?.[0]?.figureId })} target="_blank" rel="noopener noreferrer">지식베이스에서 자료 열기<ArrowUpRight size={14} /></a>
          {location.filePage && <a href={`/api/knowledge/file?id=${encodeURIComponent(id)}#page=${location.filePage}`} target="_blank" rel="noopener noreferrer">등록 원본 페이지 열기<ArrowUpRight size={14} /></a>}
        </div>
        <div className={location.filePage ? "source-reader" : "source-reader is-manuscript"}>
          {location.filePage && <div className="source-page-image"><img loading="lazy" alt={`${selected.title} 원본 ${selected.page}페이지`} src={`/api/knowledge/page?id=${encodeURIComponent(id)}&page=${location.filePage}`} /></div>}
          <div className="source-transcript"><h3>지식베이스 근거 구절</h3><div className="source-passages" ref={viewport} tabIndex={0} aria-label="지식베이스 근거 구절 목록">
            {matches.map((passage, index) => <p key={passage.id} data-knowledge-hit={Boolean(passage.match) || undefined} className={`source-passage${passage.match ? " is-hit" : ""}`}><span>{index + 1}</span><span>{passage.match ? <>{passage.text.slice(0, passage.match.start)}<mark>{passage.text.slice(passage.match.start, passage.match.end)}</mark>{passage.text.slice(passage.match.end)}</> : passage.text}</span></p>)}
            {!matches.length && <p>현재 확인할 수 있는 구절이 없습니다.</p>}
          </div></div>
        </div>
      </>}
    </DialogContent></Dialog>
  </>;
}
