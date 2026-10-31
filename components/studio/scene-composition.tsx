import { useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import type { Scene, VisualPlacement } from "@/lib/storyboard";
import { clampImageScale, clampVisualPlacement, compositionLayouts, compositionOverlaySvg, compositionStickers, compositionVisuals, defaultVisualPlacements, resizeVisualPlacement, sceneVisualPlacements, type CompositionLayout } from "@/lib/scene-composition";

export function SceneComposition({ scene, preview, busy, onChange, onImageScaleChange }: {
  scene: Scene; preview?: string; busy: boolean; onChange: (placements: VisualPlacement[]) => void; onImageScaleChange: (scale: number) => void;
}) {
  const visuals = compositionVisuals(scene), placements = sceneVisualPlacements(scene);
  const [selection, setSelected] = useState(visuals[0]?.id ?? "");
  const selected = visuals.some(item => item.id === selection) ? selection : visuals[0]?.id ?? "";
  const [draft, setDraft] = useState<VisualPlacement[] | null>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; startX: number; startY: number; width: number; height: number; original: VisualPlacement[]; current: VisualPlacement[] } | null>(null);
  const [imageDraft, setImageDraft] = useState<number | null>(null);
  const imageDrag = useRef<{ startX: number; startY: number; width: number; height: number; original: number; current: number } | null>(null);
  const imageScale = imageDraft ?? clampImageScale(scene.image?.scalePercent);
  const imageBox = { left: `${(100 - imageScale) / 2}%`, top: `${(100 - imageScale) / 2}%`, width: `${imageScale}%`, height: `${imageScale}%` };
  const active = placements.find(item => item.visualId === selected);
  const shown = { ...scene, visualPlacements: draft ?? placements };
  const update = (patch: Partial<VisualPlacement>) => {
    if (active) onChange(placements.map(item => item.visualId !== selected ? item : patch.width !== undefined || patch.height !== undefined
      ? resizeVisualPlacement(item, patch.width ?? item.width, patch.height ?? item.height) : clampVisualPlacement({ ...item, ...patch })));
  };
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
    {preview && <div className="composition-image-size">
      <label htmlFor={`image-scale-${scene.id}`}>콘티 배경 크기 <strong>{Math.round(imageScale)}%</strong></label>
      <div><input id={`image-scale-${scene.id}`} type="range" aria-label="콘티 배경 크기" min={20} max={100} step={1} value={imageScale} disabled={busy} onChange={event => onImageScaleChange(event.target.valueAsNumber)} />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onImageScaleChange(100)}>화면에 맞춤</Button></div>
      <p>모서리를 끌거나 슬라이더로 조절하세요. 이미지 저장·PDF에도 이 크기로 반영됩니다.</p>
    </div>}
    {visuals.length > 0 && <div className="composition-toolbar">
      <label>자료 배치<select aria-label="자료 빠른 배치" value="" disabled={busy} onChange={event => onChange(defaultVisualPlacements(scene, event.target.value as CompositionLayout))}>
        <option value="" disabled>배치 선택</option>{Object.entries(compositionLayouts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onChange(defaultVisualPlacements(scene))}>추천 배치로</Button>
    </div>}
    <div className={`scene-composition-frame ${preview ? "has-image" : ""} ${compositionStickers(shown).length ? "has-stickers" : ""}`}>
      {preview ? <img className="composition-background" style={imageBox} src={preview} alt={`${scene.title} ${scene.image?.sourceType === "generated" ? "AI 생성 콘티" : "참고 이미지"}`} />
        : <div className="composition-empty">{scene.image ? "이 브라우저에서 배경 이미지를 찾지 못했습니다. 다시 첨부하거나 생성하세요." : visuals.length ? "자료 위치를 먼저 정하고 콘티를 생성하세요." : "이 장면의 화면을 이미지로 확인하세요."}</div>}
      <img className="composition-overlay" aria-hidden="true" alt="" draggable={false} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(compositionOverlaySvg(shown))}`} />
      {preview && <>
        <div className="composition-background-outline" style={imageBox} aria-hidden="true" />
        <button type="button" className="composition-resize-handle background" aria-label="콘티 배경 크기 조절" disabled={busy}
          style={{ left: `${50 + imageScale / 2}%`, top: `${50 + imageScale / 2}%` }}
          onKeyDown={event => {
            const delta = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
            if (delta) { event.preventDefault(); onImageScaleChange(clampImageScale(imageScale + delta * (event.shiftKey ? 5 : 1))); }
          }}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
            imageDrag.current = { startX: event.clientX, startY: event.clientY, width: bounds.width, height: bounds.height, original: imageScale, current: imageScale };
          }}
          onPointerMove={event => {
            const moving = imageDrag.current; if (!moving) return;
            const dx = (event.clientX - moving.startX) / moving.width * 200, dy = (event.clientY - moving.startY) / moving.height * 200;
            moving.current = clampImageScale(moving.original + (Math.abs(dx) > Math.abs(dy) ? dx : dy)); setImageDraft(moving.current);
          }}
          onPointerUp={() => { if (imageDrag.current) onImageScaleChange(imageDrag.current.current); imageDrag.current = null; setImageDraft(null); }}
          onPointerCancel={() => { imageDrag.current = null; setImageDraft(null); }} />
      </>}
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
      {scene.image?.sourceType === "generated" && <span className="scene-image-badge">AI 생성 · 배치 확인용</span>}
    </div>
    {visuals.length > 0 ? <>
      <p className="scene-image-cost">스티커를 끌어서 이동하고 오른쪽 아래 모서리로 크기를 조절하세요. 방향키도 사용할 수 있습니다. 번호는 아래 시각자료 추천과 연결되며, 저장 이미지·PDF에 같은 크기로 반영됩니다. 조정에는 생성 비용이 들지 않습니다.</p>
      <div className="composition-controls">
        <label>추천 시각자료<select aria-label="배치할 추천 시각자료" value={visuals.some(item => item.id === selected) ? selected : visuals[0].id} disabled={busy} onChange={event => setSelected(event.target.value)}>
          {visuals.map((visual, i) => <option key={visual.id} value={visual.id}>{i + 1} · {visual.kind === "table" ? "표" : "그림"} · {visual.title}</option>)}
        </select></label>
        <label className="connection-check"><input type="checkbox" aria-label="선택 자료 콘티에 표시" checked={Boolean(active)} disabled={busy} onChange={event => onChange(event.target.checked
          ? [...placements, defaultVisualPlacements(scene).find(item => item.visualId === selected)!] : placements.filter(item => item.visualId !== selected))} />콘티에 표시</label>
        {active && <details><summary>선택 자료 위치·크기 조정</summary><div className="composition-geometry">
          {([['x', '가로 위치'], ['y', '세로 위치'], ['width', '너비'], ['height', '높이']] as const).map(([key, label]) => <label key={key}>{label} (%)<input type="number" aria-label={`자료 ${label}`} min={key === "x" || key === "y" ? 0 : 10} max={100} step={1} value={Math.round(active[key] * 10) / 10} disabled={busy} onChange={event => update({ [key]: event.target.valueAsNumber })} /></label>)}
        </div></details>}
      </div>
    </> : <p className="scene-image-cost">연결된 추천 자료가 생기면 표·그림의 자리를 스티커로 표시합니다.</p>}
  </div>;
}
