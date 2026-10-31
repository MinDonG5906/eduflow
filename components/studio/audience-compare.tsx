"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EASY_SENTENCE_MAX_CHARS } from "@/lib/audience-rules";
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
  manuscript,
  busy,
  onApply,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: ComparisonVersion[];
  manuscript: string;
  busy: boolean;
  onApply: (board: Board) => void;
  onRetry: (audience: Audience) => void;
}) {
  // Narration is clamped to a few lines so a whole comparison fits on one screen.
  const [fullNarration, setFullNarration] = useState(false);
  const sceneRows = Math.max(0, ...versions.map((version) => version.board?.scenes.length ?? 0));
  const metrics = versions.map((version) => version.board ? versionMetrics(version.board, manuscript) : null);
  const metricRows: [string, (value: NonNullable<(typeof metrics)[number]>) => string][] = [
    ["전체 시간", (value) => time(value.totalSeconds)],
    ["나레이션 문장 평균", (value) => `${value.sentenceChars}자`],
    [`${EASY_SENTENCE_MAX_CHARS}자 넘는 문장`, (value) => `${value.longSentences}개`],
    ["원고를 그대로 읽은 문장", (value) => `${value.verbatimPercent}%`],
    ["자막 평균", (value) => `${value.subtitleChars}자`],
    ["검토 안내", (value) => `${value.warnings}건`],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="compare-dialog">
        <DialogHeader>
          <DialogTitle>대상별 버전 비교</DialogTitle>
          <DialogDescription>
            같은 원고·설정에서 대상만 바꾼 결과예요. 표에서 차이를 보고 편집할 버전을 고르세요.
          </DialogDescription>
        </DialogHeader>
        <div className="compare-scroll">
          {/* One table so the audience header stays on top while the scene rows scroll. */}
          <table className={`compare-table ${fullNarration ? "full" : ""}`}>
            <thead>
              <tr>
                <th scope="col">항목</th>
                {versions.map((version) => (
                  <th scope="col" key={version.audience}>
                    <span className="compare-audience">
                      {version.audience}
                      {version.board
                        ? <Button size="sm" disabled={busy} onClick={() => onApply(version.board!)}>이 버전으로 편집하기</Button>
                        : <Button variant="outline" size="sm" disabled={busy} onClick={() => onRetry(version.audience)}>
                          <RotateCcw size={14} /> 다시 만들기
                        </Button>}
                    </span>
                    {version.board ? <>
                      <small>{version.board.title}</small>
                      <details>
                        <summary>학습 목표 {version.board.objectives.length}개</summary>
                        <ul className="compare-objectives">
                          {version.board.objectives.map((objective) => <li key={objective}>{objective}</li>)}
                        </ul>
                      </details>
                    </> : <p className="connection-error" role="alert">{version.error?.message ?? "생성하지 못했습니다."}</p>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metricRows.map(([label, show]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {metrics.map((value, index) => <td key={versions[index].audience}>{value ? show(value) : "—"}</td>)}
                </tr>
              ))}
              <tr className="compare-divider">
                <th scope="row">장면</th>
                <td colSpan={versions.length}>
                  자막과 나레이션 앞부분
                  <Button variant="ghost" size="sm" aria-pressed={fullNarration} onClick={() => setFullNarration((full) => !full)}>
                    {fullNarration ? "나레이션 줄여 보기" : "나레이션 전체 보기"}
                  </Button>
                </td>
              </tr>
              {Array.from({ length: sceneRows }, (_, row) => (
                <tr key={row} className="compare-scene">
                  <th scope="row">{row + 1}</th>
                  {versions.map((version) => {
                    const scene = version.board?.scenes[row];
                    return (
                      <td key={version.audience} title={scene?.title}>
                        {scene && <p><span className="compare-subtitle">{scene.subtitle}</span>{scene.narration}</p>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="connection-note">비교 결과는 이 화면에만 보관돼요. 새로고침하면 사라지니, 쓸 버전을 골라 편집으로 옮겨 주세요.</p>
      </DialogContent>
    </Dialog>
  );
}
