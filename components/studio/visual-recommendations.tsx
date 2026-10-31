import { useState } from "react";
import { recommendationImageUrl, type VisualRecommendation } from "@/lib/knowledge-structure";
import { KnowledgeSource } from "@/components/knowledge-source";
import type { Scene } from "@/lib/storyboard";

function FigurePreview({ visual }: { visual: VisualRecommendation }) {
  const [missing, setMissing] = useState(false);
  return missing ? <p className="visual-unavailable">이 PC에서 원본 그림을 찾을 수 없습니다. 자료의 보관 상태를 확인해 주세요.</p>
    : <img loading="lazy" src={recommendationImageUrl(visual)} alt={visual.title} onError={() => setMissing(true)} />;
}

export function VisualRecommendations({ visuals, references }: { visuals: VisualRecommendation[]; references: NonNullable<Scene["references"]> }) {
  if (!visuals.length) return <section className="scene-visuals" aria-label="시각자료 추천"><h3>시각자료 추천</h3><p>이 장면에 추가로 추천된 지식베이스 그림이 없습니다. 위의 화면 설명과 시각 자료 제안에서 원문을 바탕으로 한 구성을 확인하세요.</p></section>;
  return <section className="scene-visuals" aria-label="시각자료 추천">
    <h3>시각자료 추천</h3>
    <p>이 장면의 내용과 관련된 지식베이스 원본 그림입니다. 제작 전에 그림과 연결 문장을 함께 확인하세요.</p>
    <div className="scene-visual-grid">{visuals.map(visual => <article className="scene-visual-card" key={visual.id}>
      <FigurePreview visual={visual} />
      <strong>{visual.title}</strong><small>원본 {visual.page}페이지</small>
      <blockquote>{visual.quote}</blockquote><p>{visual.reason}</p>
      <a href={`/api/knowledge/file?id=${encodeURIComponent(visual.documentId)}#page=${visual.filePage}`} target="_blank" rel="noopener noreferrer">원본 페이지 확인</a>
      <KnowledgeSource key={visual.id} references={references.filter(reference => reference.documentId === visual.documentId && reference.visuals?.some(item => item.id === visual.id)).map(reference => ({ ...reference, excerpt: visual.quote, visuals: [visual] }))} />
    </article>)}</div>
  </section>;
}
