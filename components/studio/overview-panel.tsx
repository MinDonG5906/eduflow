"use client";

import { useState } from "react";
import { AlertCircle, ChevronDown, Clock3, Film, GraduationCap, Layers3 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { Board } from "@/lib/storyboard";
import { TERM_CORRECTION_NOTICE_PREFIX } from "@/lib/term-corrections";

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
      {board.generation?.warnings.filter((warning) => warning.startsWith(TERM_CORRECTION_NOTICE_PREFIX)).map((warning) => (
        <p key={warning} className="term-correction-notice" role="status">{warning}</p>
      ))}
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
            {board.pdfSource && <p>원본 PDF: {board.pdfSource.name} · {board.pdfSource.pages.join(", ")}페이지</p>}
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
