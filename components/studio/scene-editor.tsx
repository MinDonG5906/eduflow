import { sceneMemo } from "@/lib/scene-memo";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
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
import { SceneEvidenceStatus, SceneEvidenceDecisions } from "@/components/scene-evidence-links";
import { SceneKnowledgeCard } from "./scene-knowledge-card";
import type { PdfSource } from "@/lib/pdf-source";
import { type Scene } from "@/lib/storyboard";
import { normalizeDuration } from "@/lib/studio-state";
import type { Settings } from "@/lib/storyboard";
import { sceneImageInput, sceneImageRequestSchema, type ImageSettings } from "@/lib/scene-image";
import { decisionKey, useEvidenceDecisions } from "@/lib/evidence-review";
import { SceneImagePanel, type SceneImageControl, type SceneImageGenerationState } from "./scene-image-panel";
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
  onChange, onAcceptEvidence, onUseDecision, onUndoDecision, onUseDecisions,
  onMove,
  onDelete,
  onRegenerate,
  canRegenerate, settings, imageSettings, onImageSettingsChange, onOpenConnection,
}: {
  scene: Scene;
  index: number;
  sceneCount: number;
  manuscript: string;
  sourceFile: Blob | null;
  source?: PdfSource;
  onAcceptEvidence?: (key: string) => void;
  onUseDecision?: (key: string) => void;
  onUndoDecision?: (key: string) => void;
  onUseDecisions?: (keys: string[]) => void;
  onChange: <K extends keyof Scene>(key: K, value: Scene[K]) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
  settings: Settings;
  imageSettings: ImageSettings;
  onImageSettingsChange: (settings: ImageSettings) => void;
  onOpenConnection: () => void;
}) {
  const imageControl = useRef<SceneImageControl>(null);
  const [imageGeneration, setImageGeneration] = useState<SceneImageGenerationState>({ busy: false, canGenerate: false, message: "", error: "" });
  const [batchError, setBatchError] = useState("");
  function regenerateWithDecisions(keys: string[]) {
    if (!keys.length || !onUseDecisions || !imageControl.current?.canGenerate) return;
    const updated = useEvidenceDecisions(scene, keys);
    const input = sceneImageInput(updated, settings, imageSettings);
    const omitted = updated.grounding?.decisions?.some(item => keys.includes(decisionKey(item)) && item.field === "narration" && !input.scene.narration.includes(item.sentence));
    if (omitted || !sceneImageRequestSchema.safeParse(input).success) {
      setBatchError("선택한 내용을 모두 담기에는 장면 내용이 너무 깁니다. 화면 설명·나레이션·시각자료 제안을 줄인 뒤 다시 시도해 주세요.");
      return;
    }
    setBatchError("");
    // Commit all selected text before reading the panel's updated generation input.
    flushSync(() => onUseDecisions(keys));
    void imageControl.current?.generate();
  }
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
        <Input className="scene-title-input" aria-label="장면 제목" value={scene.title} onChange={event => onChange("title", event.target.value)} />
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
      <SceneImagePanel scene={scene} settings={settings} imageSettings={imageSettings} onSettingsChange={onImageSettingsChange} onChange={image => onChange("image", image)} onPlacementsChange={placements => onChange("visualPlacements", placements)} onSubtitleSettingsChange={subtitleSettings => onChange("subtitleSettings", subtitleSettings)} onTextChange={onChange} onOpenConnection={onOpenConnection} generationRef={imageControl} onGenerationStateChange={setImageGeneration} />
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
          {knowledgeReferences.map(reference => <SceneKnowledgeCard key={reference.id} scene={scene} reference={reference} onAccept={onAcceptEvidence} />)}
          <SceneEvidenceDecisions scene={scene} onUse={onUseDecision} onUndo={onUndoDecision} onRegenerate={onUseDecisions ? regenerateWithDecisions : undefined} generation={{ ...imageGeneration, error: batchError || imageGeneration.error }} />
          {(!knowledgeReferences.length || !!scene.grounding?.failures?.length) && <SceneEvidenceStatus scene={scene} />}
        </div>
      </SceneSection>
      <VisualRecommendations scene={scene} references={knowledgeReferences} onChange={placements => onChange("visualPlacements", placements)} busy={imageGeneration.busy} />
      <SceneSection title="검토 메모" icon={AlertCircle} className="scene-review-section"
        description="메모를 자유롭게 작성하세요.">
        <Textarea aria-label="검토 메모" value={sceneMemo(scene)} onChange={event => onChange("memo", event.target.value)} rows={2} />
      </SceneSection>
      <div className="scene-editor-footer">
        <Button
          variant="outline"
          disabled={!canRegenerate}
          onClick={onRegenerate}
        >
          <RotateCcw size={15} /> 이 장면 재생성
        </Button>
      </div>
    </section>
  );
}
