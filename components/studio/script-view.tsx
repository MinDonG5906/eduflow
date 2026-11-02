import { Check, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Scene } from "@/lib/storyboard";

const phaseLabels = { intro: "도입부", body: "정보전달부", outro: "마무리" } as const;

function ScriptRow({ scene, index, onEdit, onOpen }: {
  scene: Scene; index: number; onEdit: <K extends keyof Scene>(index: number, key: K, value: Scene[K]) => void; onOpen: (index: number) => void;
}) {
  const n = index + 1;
  const [firstCaption, ...followingCaptions] = scene.subtitle.replace(/\r/g, "").split("\n");
  const secondCaption = followingCaptions.join("\n");
  return <article className="script-row">
    <div className="script-row-meta">
      <div className="script-row-head">
        <span className="scene-number">SCENE {String(n).padStart(2, "0")}</span>
        {scene.phase && <em className="scene-phase">{phaseLabels[scene.phase]}</em>}
        <span className={`status-tag ${scene.review ? "" : "done"}`}>{scene.review ? "검토 필요" : "검토 완료"}</span>
      </div>
      <strong className="script-row-title">{scene.title || "제목 없는 장면"}</strong>
      <span className="script-row-duration">{scene.duration}초</span>
      <div className="script-row-actions">
        <Button variant="outline" size="sm" onClick={() => onOpen(index)}><Pencil size={13} /> 이 장면 편집</Button>
        <Button variant="outline" size="sm" aria-pressed={!scene.review} onClick={() => onEdit(index, "review", !scene.review)}>
          {scene.review ? <><Check size={13} /> 검토 완료로 표시</> : <><RotateCcw size={13} /> 검토 필요로 표시</>}
        </Button>
      </div>
    </div>
    <div className="script-row-fields">
      <label>나레이션<Textarea aria-label={`${n}번 장면 나레이션`} rows={3} value={scene.narration} onChange={event => onEdit(index, "narration", event.target.value)} /></label>
      <label>자막 1<Textarea aria-label={`${n}번 장면 자막 1`} rows={1} value={firstCaption} onChange={event => onEdit(index, "subtitle", `${event.target.value.replace(/\n/g, " ")}\n${secondCaption}`)} /></label>
      <label>자막 2<Textarea aria-label={`${n}번 장면 자막 2`} rows={1} value={secondCaption} onChange={event => onEdit(index, "subtitle", `${firstCaption}\n${event.target.value}`)} /></label>
    </div>
  </article>;
}

export function ScriptView({ scenes, onEdit, onOpen }: {
  scenes: Scene[]; onEdit: <K extends keyof Scene>(index: number, key: K, value: Scene[K]) => void; onOpen: (index: number) => void;
}) {
  return <section className="script-view" aria-label="전체 대본">
    {scenes.map((scene, i) => <ScriptRow key={scene.id} scene={scene} index={i} onEdit={onEdit} onOpen={onOpen} />)}
  </section>;
}
