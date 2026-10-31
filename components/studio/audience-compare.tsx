"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MAX_COMPARED_AUDIENCES, versionMetrics, type Audience, type ComparisonVersion } from "@/lib/audience-compare";
import { audienceOptions, type Board } from "@/lib/storyboard";

const time = (seconds: number) => `${Math.floor(seconds / 60)}분 ${String(seconds % 60).padStart(2, "0")}초`;

export function AudienceSelectDialog({
  open,
  onOpenChange,
  current,
  hasPrevious,
  onStart,
  onShowPrevious,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  hasPrevious: boolean;
  onStart: (audiences: Audience[]) => void;
  onShowPrevious: () => void;
}) {
  const [selected, setSelected] = useState<Audience[]>([]);
  useEffect(() => {
    if (open) setSelected(audienceOptions.filter((audience) => audience === current));
  }, [open, current]);
  const toggle = (audience: Audience) => setSelected((list) =>
    list.includes(audience) ? list.filter((item) => item !== audience)
      : list.length < MAX_COMPARED_AUDIENCES ? [...list, audience] : list);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="connection-dialog">
        <DialogHeader>
          <div className="modal-icon"><Users size={22} /></div>
          <DialogTitle>대상별 버전 비교</DialogTitle>
          <DialogDescription>
            같은 원고와 설정으로 교육 대상만 바꿔 버전을 만들고 나란히 비교해요. 마음에 드는 버전을 골라 편집을 이어 가요.
          </DialogDescription>
        </DialogHeader>
        <div className="provider-list" role="group" aria-label={`비교할 교육 대상 (최대 ${MAX_COMPARED_AUDIENCES}개)`}>
          {audienceOptions.map((audience) => {
            const checked = selected.includes(audience);
            return (
              <label key={audience} className={`provider-option ${checked ? "active" : ""}`}>
                <input type="checkbox" checked={checked} onChange={() => toggle(audience)}
                  disabled={!checked && selected.length >= MAX_COMPARED_AUDIENCES} />
                <span><strong>{audience}</strong>{audience === current && <small>지금 설정된 대상</small>}</span>
              </label>
            );
          })}
        </div>
        <p className="connection-note">
          {selected.length}개 선택 · 최대 {MAX_COMPARED_AUDIENCES}개. 선택한 대상마다 AI 생성 요청을 1회씩, 모두 {selected.length}회 사용해요.
          한 번에 하나씩 차례로 만들어요.
        </p>
        <div className="compare-actions">
          {hasPrevious && <Button variant="ghost" onClick={onShowPrevious}>지난 비교 결과 보기</Button>}
          <Button disabled={selected.length < 2} onClick={() => onStart(selected)}>
            <Users size={16} /> {selected.length < 2 ? "2개 이상 선택해 주세요" : `${selected.length}개 버전 만들기`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ComparisonDialog({
  open,
  onOpenChange,
  versions,
  busy,
  onApply,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: ComparisonVersion[];
  busy: boolean;
  onApply: (board: Board) => void;
  onRetry: (audience: Audience) => void;
}) {
  const sceneRows = Math.max(0, ...versions.map((version) => version.board?.scenes.length ?? 0));
  const columns = { gridTemplateColumns: `repeat(${versions.length}, minmax(260px, 1fr))` };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="compare-dialog sm:max-w-[1200px]">
        <DialogHeader>
          <DialogTitle>대상별 버전 비교</DialogTitle>
          <DialogDescription>
            같은 원고·설정에서 대상만 바꾼 결과예요. 문장 길이와 자막 길이, 장면별 나레이션을 비교해 보고 편집할 버전을 고르세요.
          </DialogDescription>
        </DialogHeader>
        <div className="compare-scroll">
          <div className="compare-grid" style={columns}>
            {versions.map((version) => {
              if (!version.board) return (
                <section key={version.audience} className="compare-head">
                  <strong className="compare-audience">{version.audience}</strong>
                  <p className="connection-error" role="alert">{version.error?.message ?? "생성하지 못했습니다."}</p>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => onRetry(version.audience)}>
                    <RotateCcw size={14} /> 이 대상만 다시 만들기
                  </Button>
                </section>
              );
              const metrics = versionMetrics(version.board);
              return (
                <section key={version.audience} className="compare-head">
                  <strong className="compare-audience">{version.audience}</strong>
                  <h3>{version.board.title}</h3>
                  <dl className="compare-metrics">
                    <div><dt>전체 시간</dt><dd>{time(metrics.totalSeconds)}</dd></div>
                    <div><dt>나레이션 문장 평균</dt><dd>{metrics.sentenceChars}자</dd></div>
                    <div><dt>자막 평균</dt><dd>{metrics.subtitleChars}자</dd></div>
                    <div><dt>검토 안내</dt><dd>{metrics.warnings}건</dd></div>
                  </dl>
                  <ul className="compare-objectives">
                    {version.board.objectives.map((objective) => <li key={objective}>{objective}</li>)}
                  </ul>
                  <Button size="sm" disabled={busy} onClick={() => onApply(version.board!)}>이 버전으로 편집하기</Button>
                </section>
              );
            })}
            {Array.from({ length: sceneRows }, (_, row) => versions.map((version) => {
              const scene = version.board?.scenes[row];
              return (
                <article key={`${version.audience}-${row}`} className="compare-scene">
                  {scene && <>
                    <strong>{row + 1}. {scene.title}</strong>
                    <p>{scene.narration}</p>
                    <span className="compare-subtitle">자막 · {scene.subtitle}</span>
                  </>}
                </article>
              );
            }))}
          </div>
        </div>
        <p className="connection-note">비교 결과는 이 화면에만 보관돼요. 새로고침하면 사라지니, 쓸 버전을 골라 편집으로 옮겨 주세요.</p>
      </DialogContent>
    </Dialog>
  );
}
