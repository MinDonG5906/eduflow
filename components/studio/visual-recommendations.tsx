import { useState } from "react";
import { Images } from "lucide-react";
import { recommendationImageUrl, type VisualRecommendation } from "@/lib/knowledge-structure";
import { KnowledgeSource } from "@/components/knowledge-source";
import type { Scene } from "@/lib/storyboard";
import { KnowledgeTablePreview } from "@/components/knowledge-table-preview";
import { SceneSection } from "./scene-section";
import { compositionVisuals } from "@/lib/scene-composition";

function FigurePreview({ visual }: { visual: VisualRecommendation }) {
  const [missing, setMissing] = useState(false);
  return missing ? <p className="visual-unavailable">이 PC에서 원본 그림을 찾을 수 없습니다. 자료의 보관 상태를 확인해 주세요.</p>
    : <img loading="lazy" src={recommendationImageUrl(visual)} alt={visual.title} onError={() => setMissing(true)} />;
}

export function VisualRecommendations({ visuals, references }: { visuals: VisualRecommendation[]; references: NonNullable<Scene["references"]> }) {
  return <SceneSection title="시각자료 추천" icon={Images}>
    {!visuals.length ? <p className="scene-section-empty">이 장면에 연결된 추천 자료가 없습니다.</p>
      : <div className="scene-source-list">{compositionVisuals({ visuals }).map((visual, index) => {
        const reference = references.find(reference => reference.documentId === visual.documentId && reference.visuals?.some(item => item.id === visual.id))
          ?? references.find(reference => reference.documentId === visual.documentId && reference.page === visual.page);
        const source = { ...(reference ?? { id: visual.id, title: visual.title, url: "", published: "", revision: "", origin: "user" as const }),
          documentId: visual.documentId, page: visual.page, excerpt: visual.quote, visuals: [visual] };
        return <article className="scene-source-card" key={visual.id}>
          <header className="scene-source-card-heading"><div><span className="composition-source-number">추천 시각자료 {index + 1}</span><h4>{visual.title}</h4>
            <p className="scene-source-meta">{visual.kind === "table" ? "표" : "그림"} · {visual.page}페이지{reference ? ` · ${reference.title}` : ""}</p></div>
            <KnowledgeSource references={[source]} context={visual.title} />
          </header>
          <div className="scene-visual-content">{visual.kind === "table" && visual.table ? <KnowledgeTablePreview table={visual.table} /> : <FigurePreview visual={visual} />}</div>
        </article>;
      })}</div>}
  </SceneSection>;
}
