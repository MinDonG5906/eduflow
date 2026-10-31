import { useEffect, useRef, useState } from "react";
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
  Image as ImageIcon,
  ImagePlus,
  Layers3,
  MessageSquareText,
  MonitorPlay,
  PencilLine,
  Quote,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EvidenceSource } from "@/components/evidence-source";
import { KnowledgeSource } from "@/components/knowledge-source";
import type { PdfSource } from "@/lib/pdf-source";
import { fieldLabels, type Scene } from "@/lib/storyboard";
import { normalizeDuration } from "@/lib/studio-state";
import { deleteSceneImage, loadSceneImage, saveSceneImage } from "@/lib/scene-image-storage";
import { VisualRecommendations } from "./visual-recommendations";
import { SceneSection } from "./scene-section";
import { sourceLocationLabel } from "@/lib/source-location";

// Production fields stay editable; source material is grouped below them.
const textFields = [
  "visual",
  "assets",
  "narration",
  "subtitle",
] as const;
const fieldIcons = {
  visual: MonitorPlay,
  assets: Layers3,
  narration: MessageSquareText,
  subtitle: FileText,
} as const;
const phaseLabels = { intro: "도입부", body: "정보전달부", outro: "마무리" } as const;

function SceneReferenceImage({
  scene,
  onChange,
}: {
  scene: Scene;
  onChange: <K extends keyof Scene>(key: K, value: Scene[K]) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    if (scene.image?.id) {
      loadSceneImage(scene.image.id)
        .then((blob) => {
          if (!active) return;
          if (blob) {
            objectUrl = URL.createObjectURL(blob);
            setPreviewUrl(objectUrl);
          } else {
            setPreviewUrl(null);
          }
        })
        .catch(() => {
          if (active) setPreviewUrl(null);
        });
    } else {
      setPreviewUrl(null);
    }

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [scene.image?.id]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = ["image/png", "image/jpeg", "image/jpg"];
    if (!validTypes.includes(file.type)) {
      alert("PNG 또는 JPG 이미지만 첨부할 수 있습니다.");
      return;
    }

    const imageId = `img-${scene.id}-${Date.now()}`;
    try {
      await saveSceneImage(imageId, file);
      onChange("image", {
        id: imageId,
        sourceType: "upload",
        sourceText: scene.image?.sourceText || file.name,
        name: file.name,
        mimeType: file.type,
      });
    } catch (err) {
      console.error("Failed to save image:", err);
      alert("이미지를 브라우저에 저장하지 못했습니다.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async () => {
    if (scene.image?.id) {
      try {
        await deleteSceneImage(scene.image.id);
      } catch (err) {
        console.warn("Failed to delete image from indexedDB:", err);
      }
    }
    onChange("image", undefined);
  };

  const handleSourceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!scene.image) return;
    onChange("image", {
      ...scene.image,
      sourceText: e.target.value,
    });
  };

  return <SceneSection title="참고 이미지" icon={ImageIcon}
    description="첨부한 이미지는 PDF 스토리보드의 화면 영역에 사용됩니다."
    action={<><Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
      {scene.image ? <Upload size={14} /> : <ImagePlus size={14} />}{scene.image ? "이미지 교체" : "이미지 추가"}
    </Button>{scene.image && <Button variant="ghost" size="sm" onClick={handleDelete} aria-label="참고 이미지 삭제"><Trash2 size={14} />삭제</Button>}</>}>
    <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/jpg" hidden onChange={handleFileChange} />
    {scene.image ? <div className="scene-image-content">
      {previewUrl ? <img className="scene-attached-image" src={previewUrl} alt={scene.image.name || "참고 이미지"} />
        : <p className="scene-section-empty">이 브라우저에서 이미지를 찾을 수 없습니다. 이미지를 다시 첨부해 주세요.</p>}
      <label className="scene-image-source">이미지 출처
        <Input value={scene.image.sourceText} onChange={handleSourceChange} placeholder="문서명, 페이지 또는 URL" />
      </label>
    </div> : <p className="scene-section-empty">제작에 사용할 PNG·JPG 이미지를 첨부하세요.</p>}
  </SceneSection>;
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
      <div className="scene-basics">
        <div className="scene-field">
          <label htmlFor="scene-purpose">
            <GraduationCap size={15} /> 장면 목적{" "}
            {scene.edited.includes("purpose") && <small>수정됨</small>}
          </label>
          <Textarea
            id="scene-purpose"
            aria-label="장면 목적"
            value={scene.purpose}
            onChange={(e) => onChange("purpose", e.target.value)}
          />
        </div>
        <div className="scene-field">
          <label htmlFor="duration">
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
      <SceneReferenceImage scene={scene} onChange={onChange} />
      <SceneSection title="원문 근거" icon={Quote}
        action={<EvidenceSource key={scene.id} scene={scene} manuscript={manuscript} file={sourceFile} source={source} />}
        description={<><span className="scene-source-location">{sourceLocationLabel(scene.sourceId, scene.pdfSource?.name)}</span>
          {scene.pdfSource && <span className="scene-source-name">{scene.pdfSource.name}</span>}</>}>
        <Textarea aria-label="원문 근거" value={scene.evidence} onChange={event => onChange("evidence", event.target.value)} rows={3} />
        {scene.edited.includes("evidence") && <small className="scene-edited-note">직접 수정한 근거입니다.</small>}
      </SceneSection>
      {Boolean(scene.references?.length) && <SceneSection title="보강 자료 근거" icon={BookOpen}
        description="나레이션과 자막에 참고한 지식베이스 자료입니다.">
        <div className="scene-source-list">{scene.references!.map(reference => <article className="scene-source-card" key={reference.id}>
          <header className="scene-source-card-heading"><div><h4>{reference.title}</h4>
            <p className="scene-source-meta">{reference.page ? `${reference.page}페이지 · ` : ""}{reference.origin === "official" ? "공식 자료" : reference.origin === "internal" ? "내부 자료" : "제공 자료"}{reference.published ? ` · ${reference.published}` : ""}</p></div>
            <KnowledgeSource references={[reference]} context={reference.title} />
          </header>
          <blockquote className="scene-source-quote">{reference.excerpt}</blockquote>
        </article>)}</div>
      </SceneSection>}
      <VisualRecommendations key={scene.id} visuals={scene.visuals ?? []} references={knowledgeReferences} />
      <SceneSection title="검토 메모" icon={AlertCircle} className="scene-review-section"
        description="확인이 필요한 내용이나 수정할 점을 정리하세요.">
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
