import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  Clock3,
  GraduationCap,
  MonitorPlay,
  PencilLine,
  Quote,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EvidenceSource } from "@/components/evidence-source";
import { KnowledgeSource } from "@/components/knowledge-source";
import type { PdfSource } from "@/lib/pdf-source";
import { type Scene } from "@/lib/storyboard";
import { normalizeDuration } from "@/lib/studio-state";
import type { Settings } from "@/lib/storyboard";
import type { ImageSettings } from "@/lib/scene-image";
import { SceneImagePanel } from "./scene-image-panel";
import { VisualRecommendations } from "./visual-recommendations";
import { SceneSection } from "./scene-section";
import { sourceLocationLabel } from "@/lib/source-location";

const phaseLabels = { intro: "도입부", body: "정보전달부", outro: "마무리" } as const;

export function SceneEditor({
  scene,
  index,
  sceneCount,
  manuscript,
  sourceFile,
  source,
  onChange,
  onMove,
  onDelete,
  onRegenerate,
  onNextReview,
  canRegenerate, settings, imageSettings, onImageSettingsChange, onOpenConnection,
}: {
  scene: Scene;
  index: number;
  sceneCount: number;
  manuscript: string;
  sourceFile: Blob | null;
  source?: PdfSource;
  onChange: <K extends keyof Scene>(key: K, value: Scene[K]) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
  onRegenerate: () => void;
  // Absent when no other scene still needs review.
  onNextReview?: () => void;
  canRegenerate: boolean;
  settings: Settings;
  imageSettings: ImageSettings;
  onImageSettingsChange: (settings: ImageSettings) => void;
  onOpenConnection: () => void;
}) {
  const knowledgeReferences = [...new Map([...(scene.references ?? []), ...(scene.visualReferences ?? [])]
    .map(reference => [reference.id, reference])).values()];
  return (
    <section className="scene-editor panel">
      <div className="scene-editor-head">
        <div>
          <span className="scene-number">
            SCENE {String(index + 1).padStart(2, "0")}
          </span>
          {scene.phase && <span className="scene-phase-tag">{phaseLabels[scene.phase]}</span>}
          <span className={`status-tag ${scene.review ? "" : "done"}`}>
            {scene.review ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}{" "}
            {scene.review ? "검토 필요" : "검토 완료"}
          </span>
          {scene.edited.length > 0 && (
            <span className="edited-tag">
              <PencilLine size={11} /> 수정됨
            </span>
          )}
        </div>
        <div className="scene-tools">
          <button
            aria-label="장면 위로 이동"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={16} />
          </button>
          <button
            aria-label="장면 아래로 이동"
            disabled={index === sceneCount - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={16} />
          </button>
          <span />
          <button
            aria-label="장면 삭제"
            disabled={sceneCount === 1}
            onClick={onDelete}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <div className="scene-title-row">
        <Textarea className="scene-title-input" aria-label="장면 제목" rows={1} value={scene.title}
          onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
          onChange={event => onChange("title", event.target.value.replace(/\r?\n/g, " "))} />
        <label className="scene-duration-compact"><Clock3 size={14} aria-hidden="true" /><span className="sr-only">예상 시간</span>
          <Input aria-label="예상 시간" type="number" min={1} max={600} step={1} value={scene.duration} onChange={event => onChange("duration", normalizeDuration(event.target.value))} /><span>초</span>
        </label>
      </div>
      <details className="scene-direction-details">
        <summary>장면 목적·화면 설명</summary>
        <div className="scene-direction-fields">
          <div className="scene-field">
            <label htmlFor="scene-purpose"><GraduationCap size={15} />장면 목적{scene.edited.includes("purpose") && <small>수정됨</small>}</label>
            <Textarea id="scene-purpose" aria-label="장면 목적" value={scene.purpose} rows={2} onChange={event => onChange("purpose", event.target.value)} />
          </div>
          <div className="scene-field">
            <label htmlFor="field-visual"><MonitorPlay size={15} />화면 설명{scene.edited.includes("visual") && <small>수정됨</small>}</label>
            <Textarea id="field-visual" aria-label="화면 설명" value={scene.visual} rows={3} onChange={event => onChange("visual", event.target.value)} />
          </div>
        </div>
      </details>
      <SceneImagePanel scene={scene} settings={settings} imageSettings={imageSettings} onSettingsChange={onImageSettingsChange} onChange={image => onChange("image", image)} onPlacementsChange={placements => onChange("visualPlacements", placements)} onSubtitleSettingsChange={subtitleSettings => onChange("subtitleSettings", subtitleSettings)} onTextChange={onChange} onOpenConnection={onOpenConnection} />
      <SceneSection title="원문 근거" icon={Quote}>
        <div className="scene-source-list">
          <article className="scene-source-card">
            <header className="scene-source-card-heading">
              <div><span className="scene-source-badge">원문</span><h4>{scene.pdfSource?.name ?? source?.name ?? "입력 원고"}</h4>
                <p className="scene-source-meta">{sourceLocationLabel(scene.sourceId, scene.pdfSource?.name ?? source?.name)}</p>
              </div>
              <EvidenceSource key={scene.id} scene={scene} manuscript={manuscript} file={sourceFile} source={source} />
            </header>
            <div className="scene-source-editable">
              <Textarea aria-label="원문 근거" value={scene.evidence} onChange={event => onChange("evidence", event.target.value)} rows={3} />
              {scene.edited.includes("evidence") && <small className="scene-edited-note">직접 수정한 근거입니다.</small>}
            </div>
          </article>
          {knowledgeReferences.map(reference => <article className="scene-source-card" key={reference.id}>
            <header className="scene-source-card-heading">
              <div><span className="scene-source-badge is-knowledge">지식베이스</span><h4>{reference.title}</h4>
                <p className="scene-source-meta">{reference.page ? `원본 ${reference.page}페이지` : "등록 본문"} · {reference.origin === "official" ? "공식 자료" : reference.origin === "internal" ? "내부 자료" : "제공 자료"}{reference.published ? ` · ${reference.published}` : ""}{reference.revision ? ` · ${reference.revision}` : ""}</p>
                <p className="scene-source-meta">{[scene.references?.some(item => item.id === reference.id) && "나레이션·자막 참고", scene.visualReferences?.some(item => item.id === reference.id) && "시각자료 참고"].filter(Boolean).join(" · ")}</p>
              </div>
              <KnowledgeSource references={[reference]} context={reference.title} />
            </header>
            <blockquote className="scene-source-quote">{reference.excerpt}</blockquote>
          </article>)}
          {!knowledgeReferences.length && <p className="scene-section-empty">이 장면에 연결된 지식베이스 근거가 없습니다.</p>}
        </div>
      </SceneSection>
      <VisualRecommendations visuals={scene.visuals ?? []} references={knowledgeReferences} />
      <SceneSection title="검토 메모" icon={AlertCircle} className="scene-review-section">
        <Textarea aria-label="검토 메모" value={scene.reviewReason} onChange={event => onChange("reviewReason", event.target.value)} rows={2} />
      </SceneSection>
      <div className="scene-editor-footer">
        <Button
          variant="outline"
          disabled={!canRegenerate}
          onClick={onRegenerate}
        >
          <RotateCcw size={15} /> 이 장면 재생성
        </Button>
        <div className="scene-review-actions">
          {onNextReview && (
            <Button variant="ghost" onClick={onNextReview}>
              다음 검토 장면 <ArrowRight size={15} />
            </Button>
          )}
          <Button
            variant={scene.review ? "default" : "secondary"}
            onClick={() => onChange("review", !scene.review)}
          >
            <Check size={15} />
            {scene.review ? "검토 완료로 표시" : "검토 필요로 변경"}
          </Button>
        </div>
      </div>
    </section>
  );
}
