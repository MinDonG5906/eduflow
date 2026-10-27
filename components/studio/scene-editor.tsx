import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
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
import { sourceFormat } from "@/lib/pdf-source";
import { fieldLabels, type Scene } from "@/lib/storyboard";
import { normalizeDuration } from "@/lib/studio-state";

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
  onChange,
  onMove,
  onDelete,
  onRegenerate,
  canRegenerate,
}: {
  scene: Scene;
  index: number;
  sceneCount: number;
  onChange: <K extends keyof Scene>(key: K, value: Scene[K]) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
  onRegenerate: () => void;
  canRegenerate: boolean;
}) {
  return (
    <section className="scene-editor panel">
      <div className="scene-editor-head">
        <div>
          <span className="scene-number">
            SCENE {String(index + 1).padStart(2, "0")}
          </span>
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
                {key === "evidence" && (
                  <span className="source-tag">{scene.sourceId}</span>
                )}
              </label>
              {key === "evidence" && scene.pdfSource && <small>원본 {sourceFormat(scene.pdfSource.name)}: {scene.pdfSource.name}</small>}
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
