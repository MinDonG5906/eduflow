import { KnowledgeSource } from "@/components/knowledge-source";
import { SceneEvidenceLinks } from "@/components/scene-evidence-links";
import type { Scene } from "@/lib/storyboard";

export function SceneKnowledgeCard({ scene, reference, onAccept }: {
  scene: Scene; reference: NonNullable<Scene["references"]>[number]; onAccept?: (key: string) => void;
}) {
  const uses = [scene.references?.some(item => item.id === reference.id) && "나레이션·자막 참고",
    scene.visualReferences?.some(item => item.id === reference.id) && "시각자료 참고"].filter(Boolean);
  return <article className="scene-source-card scene-knowledge-card">
    <header className="scene-source-card-heading">
      <div><span className="scene-source-badge is-knowledge">지식베이스</span><h4>{reference.title}</h4>
        <div className="knowledge-source-tags">
          <span className="knowledge-page-tag">{reference.page ? `원본 ${reference.page}페이지` : "등록 본문"}</span>
          <span>{reference.origin === "official" ? "공식 자료" : reference.origin === "internal" ? "내부 자료" : "제공 자료"}</span>
          {uses.map(use => <span key={String(use)}>{use}</span>)}
          {/구판/.test(`${reference.published} ${reference.revision}`) && <span className="knowledge-edition-note">구판 · 현행 기준 확인</span>}
        </div>
        {(reference.published || reference.revision) && <details className="knowledge-source-info">
          <summary>자료 정보</summary>
          <dl>{reference.published && <><dt>발행 정보</dt><dd>{reference.published}</dd></>}
            {reference.revision && <><dt>출처·판본</dt><dd>{reference.revision}</dd></>}</dl>
        </details>}
      </div>
      <KnowledgeSource references={[reference]} context={reference.title} />
    </header>
    <details className="scene-source-excerpt" key={`${scene.id}:${reference.id}`}>
      <summary><span className="when-collapsed">원문 펼치기</span><span className="when-expanded">원문 접기</span></summary>
      {reference.context && <p className="scene-source-meta scene-evidence-context">{[reference.context.sectionTitle,
        reference.context.tableHeaders.length ? `표 머리글: ${reference.context.tableHeaders.join(" · ")}` : ""].filter(Boolean).join(" / ")}</p>}
      <blockquote className="scene-source-quote">{reference.excerpt}</blockquote>
    </details>
    <SceneEvidenceLinks scene={scene} referenceId={reference.id} onAccept={onAccept} />
  </article>;
}
