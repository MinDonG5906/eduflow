"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PdfPreview } from "@/components/pdf-preview";
import { defaults, manuscriptSource, type Scene } from "@/lib/storyboard";
import { citedPdfPage, selectPdfPages, sourceFormat, sourceUnit, type PdfSource } from "@/lib/pdf-source";
import { findSourceMatches, matchBoxes, sourceIndexSchema, sourceLocationLabel, sourcePassages, type SourcePage } from "@/lib/source-location";

// Successful local indexes are shared across scenes, released with the source Blob.
const indexes = new WeakMap<Blob, { mapping: string; pages: SourcePage[] }>();

function MarkedText({ text, start, end }: { text: string; start?: number; end?: number }) {
  if (start === undefined || end === undefined) return <>{text}</>;
  return <>{text.slice(0, start)}<mark>{text.slice(start, end)}</mark>{text.slice(end)}</>;
}

export function EvidenceSource({ scene, manuscript, file, source }: {
  scene: Scene; manuscript: string; file: Blob | null; source?: PdfSource;
}) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<SourcePage[]>([]);
  const [query, setQuery] = useState(scene.evidence);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [browsedPage, setBrowsedPage] = useState<number | null>(null);
  const [singlePage, setSinglePage] = useState<{ file: Blob; page: number } | null>(null);
  const textViewport = useRef<HTMLDivElement>(null);
  const pdf = Boolean(scene.pdfSource || /^pdf-page:/.test(scene.sourceId));
  const sameSource = scene.pdfSource && source?.name === scene.pdfSource.name;
  const available = pdf ? Boolean(sameSource && file && source?.pages.length) : Boolean(manuscript.trim());
  const hintPage = citedPdfPage(source, scene);
  const label = sourceLocationLabel(scene.sourceId, scene.pdfSource?.name);
  const mapping = JSON.stringify(source?.pages);

  useEffect(() => {
    if (!open) return;
    setQuery(scene.evidence); setActiveMatch(0); setBrowsedPage(null); setSinglePage(null); setError("");
    if (!pdf) {
      const text = manuscriptSource(manuscript).sentences.join("\n");
      setPages([{ page: 1, text, runs: [] }]); setLoading(false); return;
    }
    if (!file || !source || !available) { setPages([]); setLoading(false); setError("원본 파일을 다시 불러와 주세요."); return; }
    const cached = indexes.get(file);
    if (cached?.mapping === mapping) { setPages(cached.pages); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setPages([]);
    const form = new FormData();
    form.set("input", JSON.stringify({ manuscript: "", settings: defaults, pdfSource: source }));
    form.set("pdf", file, "selected-pages.pdf");
    void fetch("/api/documents/source", { method: "POST", body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) })
      .then(async response => {
        if (!response.ok) throw new Error();
        const index = sourceIndexSchema.parse(await response.json());
        if (JSON.stringify(index.pages.map(page => page.page)) !== mapping) throw new Error();
        if (controller.signal.aborted) return;
        indexes.set(file, { mapping, pages: index.pages }); setPages(index.pages);
      }).catch(() => { if (!controller.signal.aborted) setError("원문을 열지 못했습니다. 잠시 후 다시 시도해 주세요."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, scene.id, scene.evidence, manuscript, pdf, file, mapping, available]); // source metadata is represented by mapping/file/available

  const matches = useMemo(() => {
    const found = pages.flatMap(page => findSourceMatches(page.text, query).map(range => ({ page: page.page, ...range })));
    // Prefer the longest verbatim passage across the selection, then the cited
    // page among equally good matches. Repeated short headings are not anchors
    // when a fuller source passage is available elsewhere.
    const longest = Math.max(0, ...found.map(match => match.characters ?? 0));
    return found.filter(match => match.characters === longest).sort((a, b) => Number(b.page === hintPage) - Number(a.page === hintPage));
  }, [pages, query, hintPage]);
  const currentMatch = matches[activeMatch];
  const pageNumber = browsedPage ?? currentMatch?.page ?? hintPage ?? pages[0]?.page;
  const current = pages.find(page => page.page === pageNumber);
  const selectedMatch = currentMatch?.page === pageNumber ? currentMatch : undefined;
  const boxes = useMemo(() => current ? matchBoxes(current, selectedMatch) : [], [current, selectedMatch]);
  const passages = useMemo(() => sourcePassages(current?.text ?? ""), [current]);
  const hitPassages = passages.filter(passage => selectedMatch && passage.start < selectedMatch.end && passage.end > selectedMatch.start);
  const matchLocation = current && hitPassages.length ? `${pdf ? `원본 ${current.page}${sourceUnit(scene.pdfSource?.name ?? "")}` : "현재 원고"} · ${hitPassages[0].number}${hitPassages.length > 1 ? `~${hitPassages.at(-1)!.number}` : ""}번째 ${pdf ? "구절" : "문장"}` : "";

  useEffect(() => {
    if (!open || !pdf || !file || !source || !pageNumber) return;
    let cancelled = false;
    setSinglePage(null);
    const position = source.pages.indexOf(pageNumber);
    if (position === -1) return;
    void file.arrayBuffer().then(data => selectPdfPages(new Uint8Array(data), [position + 1])).then(data => {
      if (!cancelled) setSinglePage({ file: new Blob([new Uint8Array(data)], { type: "application/pdf" }), page: pageNumber });
    }).catch(() => { if (!cancelled) setError("페이지 미리보기를 열지 못했습니다. 아래 원문 텍스트를 확인해 주세요."); });
    return () => { cancelled = true; };
  }, [open, pdf, file, mapping, pageNumber]);

  useEffect(() => {
    const root = textViewport.current;
    const target = root?.querySelector<HTMLElement>("[data-source-hit]");
    if (root && target) root.scrollTop = target.offsetTop - 20;
    else if (root) root.scrollTop = 0;
  }, [current, selectedMatch]);

  function moveMatch(direction: number) {
    setActiveMatch((activeMatch + direction + matches.length) % matches.length); setBrowsedPage(null);
  }

  return <div className="evidence-source">
    <div className="evidence-source-location"><span>{pdf ? "지정 근거: " : ""}{label}</span>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!available}><BookOpen size={14} /> 원문 위치 확인</Button>
    </div>
    {scene.pdfSource && <small className="evidence-filename">{scene.pdfSource.name}</small>}
    {!available && <small>{pdf ? "해당 원본 파일을 불러오면 문장 위치를 확인할 수 있습니다." : "원고를 입력하면 근거 문장을 확인할 수 있습니다."}</small>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="source-dialog">
        <DialogHeader><DialogTitle>원문 위치 확인</DialogTitle>
          <DialogDescription>{scene.pdfSource ? `${scene.pdfSource.name} · 페이지 번호는 표지를 포함한 파일 순서입니다.` : "현재 입력된 원고에서 근거 문장을 찾습니다."}</DialogDescription>
        </DialogHeader>
        <blockquote className="source-evidence-quote">{scene.evidence || "입력된 원문 근거가 없습니다."}</blockquote>
        <label className="source-search"><Search size={16} /><span className="sr-only">원문에서 문장 또는 단어 찾기</span>
          <Input aria-label="원문에서 문장 또는 단어 찾기" value={query} maxLength={20000} onChange={event => { setQuery(event.target.value); setActiveMatch(0); setBrowsedPage(null); }} placeholder="원문의 문장이나 두 글자 이상 단어를 입력하세요" />
        </label>
        <div className="source-match-status" role="status">
          <div><strong>{loading ? "원문에서 문장을 찾고 있습니다…" : matchLocation || (matches.length ? "일치 구절이 다른 페이지에 있습니다." : "일치하는 문장을 찾지 못했습니다.")}</strong>
            {!loading && <small>{matches.length ? `${activeMatch + 1} / ${matches.length}곳 일치${currentMatch?.kind === "fragment" ? " · 근거의 일부 구절만 일치" : currentMatch?.kind === "quote" ? " · 근거에 인용된 구절 일치" : ""}${pdf && currentMatch && currentMatch.page !== hintPage ? ` · 생성 시 지정 근거: ${label}` : ""}` : "근거가 요약된 표현이면 원문에 있는 단어로 검색해 주세요."}</small>}
          </div>
          {matches.length > 1 && <div className="source-match-controls"><Button size="icon-sm" variant="outline" aria-label="이전 일치 문장" onClick={() => moveMatch(-1)}><ArrowLeft size={14} /></Button><Button size="icon-sm" variant="outline" aria-label="다음 일치 문장" onClick={() => moveMatch(1)}><ArrowRight size={14} /></Button></div>}
        </div>
        {error && <p role="alert" className="source-message">{error}</p>}
        {!loading && current && <>
          {pdf && <label className="source-page-select">다른 원문 페이지 보기
            <select aria-label="원문 페이지" value={current.page} onChange={event => setBrowsedPage(Number(event.target.value))}>
              {pages.map(page => <option key={page.page} value={page.page}>원본 {page.page}{sourceUnit(scene.pdfSource?.name ?? "")}</option>)}
            </select>
          </label>}
          <div className={pdf ? "source-reader" : "source-reader is-manuscript"}>
            {pdf && <div className="source-page-image">{singlePage?.page === current.page ? <PdfPreview file={singlePage.file} total={1} originalPages={[current.page]} format={sourceFormat(scene.pdfSource?.name ?? "")} highlightBoxes={boxes} evidenceMode /> : <p>페이지 미리보기 준비 중…</p>}</div>}
            <div className="source-transcript"><h3>{pdf ? "원문 문장·구절" : "원고 문장"}</h3><small>번호는 이 보기에서 구분한 순서입니다.</small>
              <div className="source-passages" ref={textViewport} tabIndex={0} aria-label="원문 문장 목록">
                {passages.length ? passages.map(passage => {
                  const hit = selectedMatch && passage.start < selectedMatch.end && passage.end > selectedMatch.start;
                  return <p key={passage.number} data-source-hit={hit || undefined} className={hit ? "source-passage is-hit" : "source-passage"}><span>{passage.number}</span><span><MarkedText text={passage.text} start={hit ? Math.max(0, selectedMatch.start - passage.start) : undefined} end={hit ? Math.min(passage.text.length, selectedMatch.end - passage.start) : undefined} /></span></p>;
                }) : <p className="source-message">이 페이지는 추출할 수 있는 글자가 없습니다. 원문 이미지를 확인해 주세요.</p>}
              </div>
            </div>
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}
