import { AlertTriangle, Check, Languages, Pencil, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TranslationProgress } from "@/hooks/use-localization";
import { viewerLanguage, type LocalizationTarget, type ViewerLanguage } from "@/lib/languages";
import { localizationState, pendingScenes, type LocalizedScene, type MasterText } from "@/lib/localization";
import type { Board, Scene } from "@/lib/storyboard";
import type { GeneratorStatus } from "./types";

const phaseLabels = { intro: "도입부", body: "정보전달부", outro: "마무리" } as const;
const stateLabels = { missing: "번역 없음", stale: "원본 수정됨" } as const;

// The subtitle is one string with its two lines separated by "\n".
function captions(subtitle: string) {
  const [first, ...rest] = subtitle.replace(/\r/g, "").split("\n");
  return [first, rest.join("\n")] as const;
}
function CaptionFields({ label, subtitle, onChange }: { label: string; subtitle: string; onChange: (subtitle: string) => void }) {
  const [first, second] = captions(subtitle);
  return <>
    <label>자막 1<Textarea aria-label={`${label} 자막 1`} rows={1} value={first} onChange={event => onChange(`${event.target.value.replace(/\n/g, " ")}\n${second}`)} /></label>
    <label>자막 2<Textarea aria-label={`${label} 자막 2`} rows={1} value={second} onChange={event => onChange(`${first}\n${event.target.value}`)} /></label>
  </>;
}

type Translation = {
  language: LocalizationTarget;
  board: Board;
  progress: TranslationProgress;
  error: string;
  generator: GeneratorStatus;
  onTranslate: (scenes: Scene[]) => void;
  onCancel: () => void;
  onEditScene: (scene: Scene, patch: Partial<MasterText>) => void;
  onEditTitle: (title: string) => void;
  onOpenConnection: () => void;
};

function ScriptRow({ scene, index, onEdit, onOpen, translation }: {
  scene: Scene; index: number; onEdit: <K extends keyof Scene>(index: number, key: K, value: Scene[K]) => void; onOpen: (index: number) => void;
  translation?: Translation & { localized?: LocalizedScene; canTranslate: boolean };
}) {
  const n = index + 1;
  const state = translation && localizationState(translation.board, translation.language, scene);
  const languageLabel = translation && viewerLanguage(translation.language).label;
  return <article className={`script-row ${translation ? "is-translation" : ""}`}>
    <div className="script-row-meta">
      <div className="script-row-head">
        <span className="scene-number">SCENE {String(n).padStart(2, "0")}</span>
        {scene.phase && <em className="scene-phase">{phaseLabels[scene.phase]}</em>}
        {state && state !== "ready"
          ? <span className="status-tag">{stateLabels[state]}</span>
          : !translation && <span className={`status-tag ${scene.review ? "" : "done"}`}>{scene.review ? "검토 필요" : "검토 완료"}</span>}
      </div>
      <strong className="script-row-title">{scene.title || "제목 없는 장면"}</strong>
      <span className="script-row-duration">{scene.duration}초</span>
      <div className="script-row-actions">
        <Button variant="outline" size="sm" onClick={() => onOpen(index)}><Pencil size={13} /> 이 장면 편집</Button>
        {translation
          ? <Button variant="outline" size="sm" disabled={!translation.canTranslate} onClick={() => translation.onTranslate([scene])}>
              <RotateCcw size={13} /> {state === "missing" ? "번역" : "다시 번역"}
            </Button>
          : <Button variant="outline" size="sm" aria-pressed={!scene.review} onClick={() => onEdit(index, "review", !scene.review)}>
              {scene.review ? <><Check size={13} /> 검토 완료로 표시</> : <><RotateCcw size={13} /> 검토 필요로 표시</>}
            </Button>}
      </div>
    </div>
    {translation ? <>
      <div className="script-row-master" aria-label={`${n}번 장면 한국어 원본`}>
        <span className="script-column-label">한국어 원본</span>
        <p className="script-master-text">{scene.narration}</p>
        <p className="script-master-text is-caption">{scene.subtitle}</p>
      </div>
      <div className="script-row-fields translated-text" lang={translation.language}>
        <span className="script-column-label">{languageLabel}</span>
        {translation.localized ? <>
          <label>제목<Input aria-label={`${n}번 장면 ${languageLabel} 제목`} value={translation.localized.title} onChange={event => translation.onEditScene(scene, { title: event.target.value })} /></label>
          <label>나레이션<Textarea aria-label={`${n}번 장면 ${languageLabel} 나레이션`} rows={3} value={translation.localized.narration} onChange={event => translation.onEditScene(scene, { narration: event.target.value })} /></label>
          <CaptionFields label={`${n}번 장면 ${languageLabel}`} subtitle={translation.localized.subtitle} onChange={subtitle => translation.onEditScene(scene, { subtitle })} />
          {translation.localized.warnings.length > 0 && <ul className="script-warnings" role="status">
            {translation.localized.warnings.map(warning => <li key={warning}><AlertTriangle size={12} />{warning}</li>)}
          </ul>}
          {translation.language !== "ko-easy" && (translation.localized.backTranslation.narration || translation.localized.backTranslation.subtitle) && <details className="script-back-translation" lang="ko">
            <summary>역번역</summary>
            {translation.localized.backTranslation.narration && <p>{translation.localized.backTranslation.narration}</p>}
            {translation.localized.backTranslation.subtitle && <p className="is-caption">{translation.localized.backTranslation.subtitle}</p>}
          </details>}
        </> : <p className="script-empty">—</p>}
      </div>
    </> : <div className="script-row-fields">
      <label>나레이션<Textarea aria-label={`${n}번 장면 나레이션`} rows={3} value={scene.narration} onChange={event => onEdit(index, "narration", event.target.value)} /></label>
      <CaptionFields label={`${n}번 장면`} subtitle={scene.subtitle} onChange={subtitle => onEdit(index, "subtitle", subtitle)} />
    </div>}
  </article>;
}

function TranslationBar({ translation }: { translation: Translation }) {
  const { board, language, progress, generator } = translation;
  const label = viewerLanguage(language).label;
  const pending = pendingScenes(board, language);
  const localization = board.localizations?.[language];
  const ready = generator?.mode === "ai" && generator.available;
  return <div className="translation-bar">
    {localization && <label className="translation-title">{label} 제목
      <Input lang={language} aria-label={`${label} 콘텐츠 제목`} value={localization.title} onChange={event => translation.onEditTitle(event.target.value)} />
    </label>}
    <div className="translation-actions">
      <span className="translation-count">{label} {board.scenes.length - pending.length}/{board.scenes.length}</span>
      {progress ? <>
        <span role="status">번역 중 {progress.done}/{progress.total}</span>
        <Button variant="outline" size="sm" onClick={translation.onCancel}><X size={13} /> 취소</Button>
      </> : ready ? pending.length > 0 && <Button size="sm" onClick={() => translation.onTranslate(pending)}>
        <Languages size={14} /> {pending.length}개 장면 번역
      </Button> : <>
        <span>번역은 AI 연결이 필요합니다.</span>
        <Button variant="outline" size="sm" onClick={translation.onOpenConnection}>AI 연결하기</Button>
      </>}
    </div>
    {ready && generator.vendor && <small className="translation-note">번역할 때 제목·나레이션·자막을 {generator.vendor}에 보냅니다.</small>}
    {translation.error && <p role="alert" className="connection-error">{translation.error}</p>}
  </div>;
}

export function ScriptView({ scenes, onEdit, onOpen, language = "ko", translation }: {
  scenes: Scene[]; onEdit: <K extends keyof Scene>(index: number, key: K, value: Scene[K]) => void; onOpen: (index: number) => void;
  language?: ViewerLanguage; translation?: Omit<Translation, "language">;
}) {
  const active = language !== "ko" && translation ? { ...translation, language } : undefined;
  const canTranslate = Boolean(active && !active.progress && active.generator?.mode === "ai" && active.generator.available);
  return <section className="script-view" aria-label="전체 대본">
    {active && <TranslationBar translation={active} />}
    {scenes.map((scene, i) => <ScriptRow key={scene.id} scene={scene} index={i} onEdit={onEdit} onOpen={onOpen}
      translation={active && { ...active, localized: active.board.localizations?.[active.language]?.scenes[scene.id], canTranslate }} />)}
  </section>;
}
