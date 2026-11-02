import { useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useCompositionAssets } from "@/hooks/use-composition-assets";
import { Image as ImageIcon, Layers3, Captions, MessageSquareText } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { Scene, VisualPlacement } from "@/lib/storyboard";
import { clampVisualPlacement, compositionLayouts, compositionOverlaySvg, compositionPlaceholderSvg, compositionSubtitle, compositionStickers, compositionVisuals, defaultVisualPlacements, resizeVisualPlacement, sceneVisualPlacements, type CompositionLayout } from "@/lib/scene-composition";

// Remembered per browser tab so moving between scenes keeps the same inspector tab.
const TAB_KEY = "eduflow-composition-tab";
const tabs = [{ id: "subtitle", label: "자막", icon: Captions }, { id: "narration", label: "나레이션", icon: MessageSquareText }, { id: "visuals", label: "시각자료", icon: Layers3 }, { id: "image", label: "이미지 생성", icon: ImageIcon }];
function initialTab() {
  try { const saved = sessionStorage.getItem(TAB_KEY); if (tabs.some(item => item.id === saved)) return saved!; } catch {}
  return "subtitle";
}

export function SceneComposition({ scene, preview, busy, onChange, onSubtitleSettingsChange, onTextChange, generationSettings, actions }: {
  onTextChange: (field: "subtitle" | "narration" | "assets", value: string) => void; generationSettings: ReactNode;
  // Rendered inside the inspector so a sticky action bar never covers the preview.
  actions?: ReactNode;
  scene: Scene; preview?: string; busy: boolean; onChange: (placements: VisualPlacement[]) => void; onSubtitleSettingsChange: (settings: NonNullable<Scene["subtitleSettings"]>) => void;
}) {
  const id = useId();
  const [tab, setTabState] = useState(initialTab);
  const setTab = (next: string) => { setTabState(next); try { sessionStorage.setItem(TAB_KEY, next); } catch {} };
  const [firstCaption, ...followingCaptions] = scene.subtitle.replace(/\r/g, "").split("\n");
  const secondCaption = followingCaptions.join("\n");
  const visuals = compositionVisuals(scene), placements = sceneVisualPlacements(scene);
  const [selection, setSelected] = useState(visuals[0]?.id ?? "");
  const selected = visuals.some(item => item.id === selection) ? selection : visuals[0]?.id ?? "";
  const [draft, setDraft] = useState<VisualPlacement[] | null>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; startX: number; startY: number; width: number; height: number; original: VisualPlacement[]; current: VisualPlacement[] } | null>(null);
  const active = placements.find(item => item.visualId === selected);
  const shown = { ...scene, visualPlacements: draft ?? placements };
  const sources = useCompositionAssets(shown);
  const subtitle = compositionSubtitle(shown);
  const startDrag = (event: PointerEvent<HTMLButtonElement>, id: string, mode: "move" | "resize") => {
    if (event.button !== 0) return;
    setSelected(id); event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    drag.current = { id, mode, startX: event.clientX, startY: event.clientY, width: bounds.width, height: bounds.height, original: placements, current: placements };
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const moving = drag.current; if (!moving) return;
    const dx = (event.clientX - moving.startX) / moving.width * 100, dy = (event.clientY - moving.startY) / moving.height * 100;
    moving.current = moving.original.map(item => item.visualId !== moving.id ? item : moving.mode === "resize"
      ? resizeVisualPlacement(item, item.width + dx, item.height + dy) : clampVisualPlacement({ ...item, x: item.x + dx, y: item.y + dy }));
    setDraft(moving.current);
  };
  const finishDrag = () => { const moving = drag.current; if (moving) onChange(moving.current); drag.current = null; setDraft(null); };
  const cancelDrag = () => { drag.current = null; setDraft(null); };
  return <div className="scene-composition-workspace">
    <div className="composition-stage">
      <div className="composition-stage-heading"><span>미리보기</span><span>{scene.image?.sourceType === "generated" ? "AI 이미지 · " : ""}16:9</span></div>
    <div className={`scene-composition-frame ${preview ? "has-image" : ""} ${compositionStickers(shown).length ? "has-stickers" : ""} ${subtitle ? "has-subtitle" : ""}`}>
      {preview ? <img className="composition-background" src={preview} alt={`${scene.title} ${scene.image?.sourceType === "generated" ? "AI 생성 스토리보드" : "참고 이미지"}`} />
        : <img className="composition-background" alt={`${scene.title} 제목 미리보기`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(compositionPlaceholderSvg(scene))}`} />}
      <img className="composition-overlay" aria-hidden="true" alt="" draggable={false} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(compositionOverlaySvg(shown, sources.assets))}`} />
      {compositionStickers(shown).map(sticker => <button key={sticker.visualId} type="button" disabled={busy}
        className={`composition-sticker-target ${selected === sticker.visualId ? "selected" : ""}`}
        style={{ left: `${sticker.x}%`, top: `${sticker.y}%`, width: `${sticker.width}%`, height: `${sticker.height}%` }}
        aria-label={`${sticker.label} ${sticker.kind} 위치 이동`} aria-pressed={selected === sticker.visualId}
        onClick={() => setSelected(sticker.visualId)}
        onKeyDown={event => {
          const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
          if (!delta) return; event.preventDefault(); setSelected(sticker.visualId);
          const step = event.shiftKey ? 5 : 1;
          onChange(placements.map(item => item.visualId === sticker.visualId ? clampVisualPlacement({ ...item, x: item.x + delta[0] * step, y: item.y + delta[1] * step }) : item));
        }}
        onPointerDown={event => startDrag(event, sticker.visualId, "move")} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={cancelDrag} />)}
      {compositionStickers(shown).filter(sticker => sticker.visualId === selected).map(sticker => <button key={`resize-${sticker.visualId}`} type="button" className="composition-resize-handle" disabled={busy}
        aria-label={`${sticker.label} ${sticker.kind} 크기 조절`} style={{ left: `${sticker.x + sticker.width}%`, top: `${sticker.y + sticker.height}%` }}
        onKeyDown={event => {
          const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
          if (!delta) return; event.preventDefault(); const step = event.shiftKey ? 5 : 1;
          onChange(placements.map(item => item.visualId === sticker.visualId ? resizeVisualPlacement(item, item.width + delta[0] * step, item.height + delta[1] * step) : item));
        }}
        onPointerDown={event => startDrag(event, sticker.visualId, "resize")} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={cancelDrag} />)}
    </div>
    </div>
    {scene.image && !preview && <p role="status" className="image-notice">배경 이미지를 불러오는 중입니다. 계속 표시되지 않으면 다시 첨부해 주세요.</p>}
    <div className="composition-inspector">
      <div className="composition-tabs" role="tablist" aria-label="스토리보드 편집 설정">
        {tabs.map((item, index) => <button type="button" role="tab" key={item.id} id={`${id}-${item.id}`} aria-controls={`${id}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next === null) return; event.preventDefault(); setTab(tabs[next].id);
          (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
        }}><item.icon size={15} />{item.label}{item.id === "visuals" && visuals.length > 0 && <span>{visuals.length}</span>}</button>)}
      </div>
      <div className="composition-inspector-body" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
        {tab === "image" && generationSettings}
        {tab === "visuals" && <div className="composition-visual-settings">
          <label className="composition-text-field">시각자료 제안{scene.edited.includes("assets") && <small>수정됨</small>}
            <Textarea aria-label="시각자료 제안" value={scene.assets} rows={3} disabled={busy} placeholder="이 장면에 사용할 사진·표·그래픽을 적어 주세요." onChange={event => onTextChange("assets", event.target.value)} />
          </label>
          {visuals.length > 0 ? <div className="composition-controls">
          <div className="composition-control-row">
            <label>추천 시각자료<select aria-label="배치할 추천 시각자료" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
              {visuals.map((visual, i) => <option key={visual.id} value={visual.id}>{i + 1} · {visual.kind === "table" ? "표" : "그림"} · {visual.title}</option>)}
            </select></label>
            <label className="studio-toggle"><span>자료 표시</span><input type="checkbox" role="switch" aria-label="선택 자료 스토리보드에 표시" checked={Boolean(active)} disabled={busy} onChange={event => onChange(event.target.checked
              ? [...placements, defaultVisualPlacements(scene).find(item => item.visualId === selected)!] : placements.filter(item => item.visualId !== selected))} /></label>
          </div>
          <div className="composition-toolbar">
            <label>전체 자료 배치<select aria-label="자료 빠른 배치" value="" disabled={busy} onChange={event => onChange(defaultVisualPlacements(scene, event.target.value as CompositionLayout))}>
              <option value="" disabled>배치 선택</option>{Object.entries(compositionLayouts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onChange(defaultVisualPlacements(scene))}>추천 배치</Button>
          </div>
        </div> : <div className="composition-no-assets"><Layers3 size={24} /><strong>연결된 추천 자료가 없습니다</strong><span>장면에 추천된 사진·표가 생기면 여기에 표시됩니다.</span></div>}
        </div>}
        {tab === "narration" && <label className="composition-text-field">나레이션{scene.edited.includes("narration") && <small>수정됨</small>}<Textarea aria-label="나레이션" value={scene.narration} rows={6} disabled={busy} placeholder="이 장면에서 전달할 나레이션을 작성하세요." onChange={event => onTextChange("narration", event.target.value)} /></label>}
        {tab === "subtitle" && <div className="composition-subtitle-controls">
          <div className="composition-control-row">
            <label>자막 위치<select aria-label="스토리보드 자막 위치" value={scene.subtitleSettings?.position ?? "auto"} disabled={busy || scene.subtitleSettings?.enabled === false} onChange={event => onSubtitleSettingsChange({ enabled: scene.subtitleSettings?.enabled !== false, position: event.target.value as "auto" | "top" | "bottom" })}>
              <option value="auto">자동 배치</option><option value="bottom">화면 아래</option><option value="top">화면 위</option>
            </select></label>
            <label className="studio-toggle"><span>자막 표시</span><input type="checkbox" role="switch" aria-label="스토리보드 자막 표시" checked={scene.subtitleSettings?.enabled !== false} disabled={busy} onChange={event => onSubtitleSettingsChange({ enabled: event.target.checked, position: scene.subtitleSettings?.position ?? "auto" })} /></label>
          </div>
          <label>자막 1<Textarea aria-label="자막 1" rows={1} value={firstCaption} disabled={busy} placeholder="장면의 핵심 내용" onChange={event => onTextChange("subtitle", `${event.target.value.replace(/\n/g, " ")}\n${secondCaption}`)} /></label>
          <label>자막 2<Textarea aria-label="자막 2" rows={1} value={secondCaption} disabled={busy} placeholder="이어지는 설명이나 행동 안내" onChange={event => onTextChange("subtitle", `${firstCaption}\n${event.target.value}`)} /></label>
          {subtitle?.truncated && <p role="status" className="image-notice">자막이 길어 미리보기에서 일부를 줄였습니다. PDF 자막 항목에는 전체 문장이 유지됩니다.</p>}
        </div>}
      </div>
      {actions}
    </div>
    {sources.missing.length > 0 && <p role="status" className="image-notice">추천 사진 일부를 불러오지 못했습니다. 아래 시각자료 추천에서 원본을 확인해 주세요.</p>}
  </div>;
}
