"use client";

import { useState } from "react";
import { AlertCircle, ChevronDown, Clock3, Film, GraduationCap, Layers3 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { formatPdfPages, sourceFormat, sourceUnit } from "@/lib/pdf-source";
import type { Board } from "@/lib/storyboard";
import { TERM_CORRECTION_NOTICE_PREFIX } from "@/lib/term-corrections";
import { KnowledgeSource } from "@/components/knowledge-source";
import { knowledgeUsageLabel } from "@/lib/knowledge";

export function OverviewPanel({
  board,
  onChange,
  total,
  reviewCount,
}: {
  board: Board;
  onChange: (board: Board) => void;
  total: number;
  reviewCount: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="overview-panel panel">
      <div className="overview-top">
        <div className="overview-icon">
          <Film size={22} />
        </div>
        <div className="overview-title">
          <input
            aria-label="콘텐츠 제목"
            value={board.title}
            onChange={(e) => onChange({ ...board, title: e.target.value })}
          />
          <div className="overview-meta">
            <span>
              <Layers3 size={13} />
              {board.scenes.length}개 장면
            </span>
            <span>
              <Clock3 size={13} />
              {Math.floor(total / 60)}분 {total % 60 ? `${total % 60}초` : ""}
            </span>
            <span>
              <GraduationCap size={14} />
              {board.settings.audience}
            </span>
            <span className="review-pill">
              <AlertCircle size={12} /> {reviewCount}개 검토 필요
            </span>
          </div>
        </div>
        <button
          className="overview-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          콘텐츠 개요 <ChevronDown size={16} className={open ? "rotate" : ""} />
        </button>
      </div>
      <p className="scene-knowledge-status">{board.mode === "demo" ? board.scenes.some(scene => scene.generation?.mode === "ai") ? "일부 장면을 AI로 재생성했습니다. 각 장면에서 지식베이스 활용 내역을 확인하세요." : "무료 데모 · 지식베이스를 검색하거나 AI에 전달하지 않습니다." : board.generation?.knowledge ? `전체 생성: ${knowledgeUsageLabel(board.generation.knowledge)}` : "전체 생성 시 지식베이스 검색 기록이 없습니다. 재생성한 장면의 기록은 각 장면에서 확인하세요."}</p>
      {board.generation?.warnings.filter((warning) => warning.startsWith(TERM_CORRECTION_NOTICE_PREFIX)).map((warning) => (
        <p key={warning} className="term-correction-notice" role="status">{warning}</p>
      ))}
      {Boolean(board.generation?.knowledgeSources?.length) && <div className="overview-knowledge-location"><KnowledgeSource references={board.generation!.knowledgeSources!} label="검색한 지식베이스 위치 확인" /></div>}
      {open && (
        <div className="overview-edit">
          <label>
            핵심 요약
            <Textarea
              value={board.summary}
              onChange={(e) => onChange({ ...board, summary: e.target.value })}
            />
          </label>
          <label>
            학습 목표 <small>한 줄에 하나씩 · 최대 5개</small>
            <Textarea
              value={board.objectives.join("\n")}
              onChange={(e) =>
                onChange({
                  ...board,
                  objectives: e.target.value.split("\n").slice(0, 5),
                })
              }
            />
          </label>
          <div className="settings-summary">
            {board.pdfSource && <p>원본 {sourceFormat(board.pdfSource.name)}: {board.pdfSource.name} · {formatPdfPages(board.pdfSource.pages)}{sourceUnit(board.pdfSource.name)}</p>}
            {board.settings.difficulty} · 목표 {board.settings.minutes}분 ·{" "}
            {board.settings.tone} · {board.settings.language}
            {board.settings.keywords.length > 0 &&
              ` · ${board.settings.keywords.join(", ")}`}
            {board.settings.instructions && (
              <p>추가 요청: {board.settings.instructions}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
