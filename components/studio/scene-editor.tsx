import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  CheckCircle2,
  Clock3,
  FileText,
  GraduationCap,
  Layers3,
  MessageSquareText,
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
import { knowledgeUsageLabel } from "@/lib/knowledge";
import type { PdfSource } from "@/lib/pdf-source";
import { fieldLabels, type Scene } from "@/lib/storyboard";
import { normalizeDuration } from "@/lib/studio-state";
import { VisualRecommendations } from "./visual-recommendations";

// Purpose sits beside the preview; the rest are stacked below it.
const textFields = [
  "visual",
  "assets",
  "narration",
  "subtitle",
  "evidence",
  "reviewReason",
] as const;
const fieldIcons = {
  visual: MonitorPlay,
  assets: Layers3,
  narration: MessageSquareText,
  subtitle: FileText,
  evidence: Quote,
  reviewReason: AlertCircle,
} as const;
const phaseLabels = { intro: "도입부", body: "정보전달부", outro: "마무리" } as const;

function ScenePreview({ scene, index }: { scene: Scene; index: number }) {
  return (
    <div className="scene-preview" aria-label="장면 제목과 자막 배치 미리보기">
      <div className="preview-topline">
        <span>EDUFLOW / SCENE {String(index + 1).padStart(2, "0")}</span>
        <MonitorPlay size={14} />
      </div>
      <div className="preview-copy">
        <span className="preview-rule" />
        <strong>{scene.title || "장면 제목을 입력하세요"}</strong>
        <p>{scene.subtitle || "장면의 핵심 자막이 여기에 표시됩니다."}</p>
      </div>
      <div className="preview-bottomline">
        <span>제목·자막 배치 예시</span><span>16:9 · {scene.duration}초</span>
      </div>
    </div>
  );
}

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
  canRegenerate,
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
  canRegenerate: boolean;
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
      <Input
        className="scene-title-input"
        aria-label="장면 제목"
        value={scene.title}
        onChange={(e) => onChange("title", e.target.value)}
      />
      <div className="scene-hero">
        <ScenePreview scene={scene} index={index} />
        <div className="scene-purpose">
          <label>
            <GraduationCap size={15} /> 장면 목적{" "}
            {scene.edited.includes("purpose") && <small>수정됨</small>}
          </label>
          <Textarea
            aria-label="장면 목적"
            value={scene.purpose}
            onChange={(e) => onChange("purpose", e.target.value)}
          />
          <label className="duration-label" htmlFor="duration">
            <Clock3 size={14} /> 예상 시간
          </label>
          <div className="duration-input">
            <Input
              id="duration"
              type="number"
              min={1}
              max={600}
              step={1}
              value={scene.duration}
              onChange={(e) => onChange("duration", normalizeDuration(e.target.value))}
            />
            <span>초</span>
          </div>
        </div>
      </div>
      <div className="scene-fields">
        {textFields.map((key) => {
          const Icon = fieldIcons[key];
          return (
            <div key={key} className={`scene-field field-${key}`}>
              <label htmlFor={`field-${key}`}>
                <Icon size={15} />{" "}
                {fieldLabels[key]}
                {scene.edited.includes(key) && <small>수정됨</small>}
              </label>
              {key === "evidence" && <><EvidenceSource key={scene.id} scene={scene} manuscript={manuscript} file={sourceFile} source={source} /><div className="scene-knowledge-location"><KnowledgeSource key={scene.id} references={knowledgeReferences} />{!knowledgeReferences.length && <small>이 장면에 선택된 지식베이스 근거가 없습니다.</small>}</div></>}
              <Textarea
                id={`field-${key}`}
                value={scene[key]}
                onChange={(e) => onChange(key, e.target.value)}
                rows={key === "narration" ? 4 : 2}
              />
            </div>
          );
        })}
      </div>
      {scene.generation?.mode === "ai" && <p className="scene-knowledge-status">{scene.generation.knowledge ? `${knowledgeUsageLabel(scene.generation.knowledge)} 이 장면: 보강 근거 ${scene.references?.length ?? 0}개 · 시각자료 ${scene.visuals?.length ?? 0}개` : "이 장면에는 지식베이스 검색 기록이 없습니다."}</p>}
      <VisualRecommendations key={scene.id} visuals={scene.visuals ?? []} references={knowledgeReferences} />
      {Boolean(scene.references?.length) && <div className="scene-references">
        <h3><BookOpen size={15} /> 보강 자료 근거</h3>
        <p>나레이션·자막에 활용한 외부 자료입니다. 원문 근거와 구분해 검토해 주세요.</p>
        {scene.references!.map((reference) => <div className="scene-reference" key={reference.id}>
          <strong>{reference.url ? <a href={reference.url} target="_blank" rel="noopener noreferrer">{reference.title}</a> : reference.title}</strong>
          <small>{reference.origin === "official" ? "공식 자료" : reference.origin === "internal" ? "내부 자료" : "사용자 제공 자료"} · {reference.published}{reference.revision ? ` · ${reference.revision}` : ""}{reference.page ? ` · ${reference.page}페이지` : ""}</small>
          <p>{reference.excerpt}</p>
          <KnowledgeSource references={[reference]} />
        </div>)}
      </div>}
      <div className="scene-editor-footer">
        <Button
          variant="outline"
          disabled={!canRegenerate}
          onClick={onRegenerate}
        >
          <RotateCcw size={15} /> 이 장면 재생성
        </Button>
        <Button
          variant={scene.review ? "default" : "secondary"}
          onClick={() => onChange("review", !scene.review)}
        >
          <Check size={15} />
          {scene.review ? "검토 완료로 표시" : "검토 필요로 변경"}
        </Button>
      </div>
    </section>
  );
}
