import { useState } from "react";
import { Images } from "lucide-react";
import { recommendationImageUrl, type VisualRecommendation } from "@/lib/knowledge-structure";
import { KnowledgeSource } from "@/components/knowledge-source";
import { Button } from "@/components/ui/button";
import type { Scene } from "@/lib/storyboard";
import { KnowledgeTablePreview } from "@/components/knowledge-table-preview";
import { SceneSection } from "./scene-section";
import { compositionVisuals, sceneVisualPlacements, setVisualUsage } from "@/lib/scene-composition";

function FigurePreview({ visual }: { visual: VisualRecommendation }) {
  const [missing, setMissing] = useState(false);
  return missing ? <p className="visual-unavailable">이 PC에서 원본 그림을 찾을 수 없습니다. 자료의 보관 상태를 확인해 주세요.</p>
    : <img loading="lazy" src={recommendationImageUrl(visual)} alt={visual.title} onError={() => setMissing(true)} />;
}

export function VisualRecommendations({ scene, references, onChange, busy = false }: {
  scene: Scene; references: NonNullable<Scene["references"]>; onChange: (placements: NonNullable<Scene["visualPlacements"]>) => void; busy?: boolean;
}) {
  const visuals = compositionVisuals(scene);
  const active = new Set(sceneVisualPlacements(scene).map(item => item.visualId));
  return <SceneSection title="참고 시각자료 추천" icon={Images} description="장면 제작에 참고할 표·그림입니다. 필요한 자료를 원본과 대조하세요.">
    {!visuals.length ? <p className="scene-section-empty">이 장면에 연결된 추천 자료가 없습니다.</p>
      : <div className="scene-source-list">{visuals.map((visual, index) => {
        const enabled = active.has(visual.id);
        const reference = references.find(reference => reference.documentId === visual.documentId && reference.visuals?.some(item => item.id === visual.id))
          ?? references.find(reference => reference.documentId === visual.documentId && reference.page === visual.page);
        const source = { ...(reference ?? { id: visual.id, title: visual.title, url: "", published: "", revision: "", origin: "user" as const }),
          documentId: visual.documentId, page: visual.page, excerpt: visual.quote, visuals: [visual] };
        return <article className={`scene-source-card visual-recommendation-card${enabled ? "" : " is-visual-disabled"}`} key={visual.id}>
          <header className="scene-source-card-heading"><div><span className="composition-source-number">추천 시각자료 {index + 1}{!enabled && " · 사용 안함"}</span><h4>{visual.title}</h4>
            <p className="scene-source-meta">{visual.kind === "table" ? "표" : "그림"} · {visual.page}페이지{reference ? ` · ${reference.title}` : ""}</p></div>
            <div className="visual-recommendation-actions"><KnowledgeSource references={[source]} context={visual.title} />
              <Button variant={enabled ? "outline" : "default"} size="sm" disabled={busy} aria-label={`${visual.title} ${enabled ? "사용 안함" : "다시 사용"}`}
                onClick={() => onChange(setVisualUsage(scene, visual.id, !enabled))}>{enabled ? "사용 안함" : "다시 사용"}</Button>
            </div>
          </header>
          {enabled && <div className="scene-visual-content">{visual.kind === "table" && visual.table ? <KnowledgeTablePreview table={visual.table} /> : <FigurePreview visual={visual} />}</div>}
          {enabled && visual.association === "caption" && <p className="scene-source-meta">원문의 그림 설명을 기준으로 추천했습니다. 실제 그림은 원본과 대조해 주세요.</p>}
        </article>;
      })}</div>}
  </SceneSection>;
}
