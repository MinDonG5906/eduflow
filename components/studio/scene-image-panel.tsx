import { useEffect, useRef, useState } from "react";
import { Download, Image as ImageIcon, LoaderCircle, RotateCcw, Sparkles, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CONNECTION_CHANGED } from "@/hooks/use-generator-status";
import { useSceneImageUrl } from "@/hooks/use-scene-image-url";
import { downloadBlob } from "@/lib/download";
import { imageStyles, sceneImageInput, sceneImageResultSchema, sceneImageStatusSchema, sceneImageBasis, type ImageSettings, type SceneImageStatus } from "@/lib/scene-image";
import { deleteSceneImage, loadSceneImage, saveSceneImage } from "@/lib/scene-image-storage";
import type { Scene, Settings } from "@/lib/storyboard";
import { SceneSection } from "./scene-section";
import { SceneComposition } from "./scene-composition";
import { compositionStickers, compositionSubtitle } from "@/lib/scene-composition";
import { exportSceneComposition } from "@/lib/scene-composition-export";

export function SceneImagePanel({ scene, settings, imageSettings, onSettingsChange, onChange, onPlacementsChange, onSubtitleSettingsChange, onOpenConnection }: {
  scene: Scene; settings: Settings; imageSettings: ImageSettings; onSettingsChange: (settings: ImageSettings) => void;
  onChange: (image: Scene["image"]) => void; onPlacementsChange: (placements: Scene["visualPlacements"]) => void; onOpenConnection: () => void;
  onSubtitleSettingsChange: (settings: NonNullable<Scene["subtitleSettings"]>) => void;
}) {
  const [status, setStatus] = useState<SceneImageStatus | null>(null);
  const [direction, setDirection] = useState("");
  const [useReference, setUseReference] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [basisHash, setBasisHash] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const preview = useSceneImageUrl(scene.image?.id);
  const input = sceneImageInput(scene, settings, imageSettings, direction);
  const snapshot = JSON.stringify(input);
  const latest = useRef({ snapshot, onChange, imageId: scene.image?.id });
  latest.current = { snapshot, onChange, imageId: scene.image?.id };
  useEffect(() => {
    let active = true;
    try {
      const basis = sceneImageBasis(input);
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(basis)).then(bytes => {
        if (active) setBasisHash([...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
      }).catch(() => { if (active) setBasisHash(""); });
    } catch { setBasisHash(""); }
    return () => { active = false; };
  }, [snapshot]);

  useEffect(() => {
    alive.current = true;
    let controller: AbortController | undefined;
    const load = () => {
      controller?.abort(); controller = new AbortController();
      const signal = controller.signal;
      fetch("/api/scene-image", { cache: "no-store", signal }).then(async response => {
        if (!response.ok) throw new Error();
        const status = sceneImageStatusSchema.parse(await response.json());
        if (!signal.aborted) { setStatus(status); setError(""); }
      }).catch(() => { if (!signal.aborted) { setStatus(null); setError("이미지 연결 상태를 확인하지 못했습니다. 모델 연결을 확인해 주세요."); } });
    };
    load(); window.addEventListener(CONNECTION_CHANGED, load);
    return () => { alive.current = false; controller?.abort(); request.current?.abort(); window.removeEventListener(CONNECTION_CHANGED, load); };
  }, []);

  async function generate() {
    if (lock.current || !status?.available) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    const controller = new AbortController(); request.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(125000)]);
    const unchanged = () => !signal.aborted && latest.current.snapshot === snapshot && latest.current.imageId === scene.image?.id;
    let saved: string | undefined;
    try {
      const form = new FormData(); form.set("input", snapshot);
      if (useReference && scene.image) {
        const reference = await loadSceneImage(scene.image.id);
        if (!reference) throw new Error("참고할 이미지를 찾지 못했습니다. 현재 이미지 참고를 끄거나 다시 첨부해 주세요.");
        form.set("reference", reference, "reference.png");
      }
      if (!unchanged()) throw new Error("장면 내용이 변경되었습니다. 변경한 내용을 확인하고 다시 생성해 주세요.");
      const response = await fetch("/api/scene-image", { method: "POST", body: form, signal });
      const raw = await response.json();
      if (!response.ok) throw new Error(typeof raw.error === "string" ? raw.error : "이미지를 생성하지 못했습니다. 기존 이미지는 유지됩니다.");
      const result = sceneImageResultSchema.parse(raw);
      if (result.sceneId !== scene.id || !unchanged()) throw new Error("생성 중 장면 내용이 변경되어 기존 이미지를 유지했습니다. 다시 생성해 주세요.");
      const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: result.mimeType });
      const id = `generated-${crypto.randomUUID()}`;
      await saveSceneImage(id, blob); saved = id;
      if (!unchanged()) throw new Error("장면 내용이 변경되어 기존 이미지를 유지했습니다.");
      latest.current.onChange({ id, sourceType: "generated", sourceText: "AI 생성 콘티 · 원문과 대조 필요", name: `scene-${scene.id}.png`, mimeType: result.mimeType,
        generated: { model: result.model, prompt: result.prompt, createdAt: result.createdAt, basedOn: result.basedOn } });
      saved = undefined;
      setMessage("콘티 이미지를 저장했습니다. 원문과 대조한 뒤 사용하세요.");
    } catch (e) {
      if (!controller.signal.aborted) setError(signal.aborted ? "이미지 생성 시간이 초과되었습니다. 기존 이미지는 유지됩니다." : e instanceof Error ? e.message : "이미지를 저장하지 못했습니다. 기존 이미지는 유지됩니다.");
    } finally {
      if (saved) await deleteSceneImage(saved).catch(() => {});
      if (request.current === controller) { lock.current = false; if (!controller.signal.aborted) setBusy(false); }
    }
  }
  async function attach(file?: File) {
    if (!file || lock.current) return;
    setError(""); setMessage("");
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 8 * 1024 * 1024) { setError("8MB 이하의 PNG·JPG 이미지를 선택해 주세요."); return; }
    try {
      const id = `upload-${crypto.randomUUID()}`;
      await saveSceneImage(id, file);
      if (!alive.current) { await deleteSceneImage(id).catch(() => {}); return; }
      latest.current.onChange({ id, sourceType: "upload", sourceText: file.name.slice(0, 300), name: file.name.slice(0, 200), mimeType: file.type });
    } catch { setError("이미지를 브라우저에 저장하지 못했습니다. 기존 이미지는 유지됩니다."); }
    finally { if (upload.current) upload.current.value = ""; }
  }
  const canGenerate = Boolean(status?.available && scene.visual.trim() && scene.evidence.trim() && !busy);
  return <SceneSection title="콘티 이미지" icon={ImageIcon} description="추천 사진·표와 장면 자막을 콘티에 직접 배치합니다. 조정한 위치·크기는 이미지 저장과 PDF에도 반영됩니다."
    action={<Button size="sm" variant="outline" disabled={busy} onClick={() => upload.current?.click()}><Upload size={14} />이미지 첨부</Button>}>
    <input ref={upload} type="file" accept="image/png,image/jpeg" hidden onChange={event => attach(event.target.files?.[0])} />
    <div className="scene-image-workspace" aria-busy={busy}>
      <div className="scene-image-actions">
        <Button disabled={!canGenerate} onClick={generate}>{busy ? <LoaderCircle className="image-spinner" size={15} /> : scene.image?.sourceType === "generated" ? <RotateCcw size={15} /> : <Sparkles size={15} />}{busy ? "콘티 생성 중…" : scene.image?.sourceType === "generated" ? "이미지 다시 생성" : "콘티 이미지 생성"}</Button>
        {busy && <Button variant="outline" onClick={() => { request.current?.abort(); lock.current = false; setBusy(false); setMessage("이미지 생성을 취소했습니다. 기존 이미지는 유지됩니다."); }}><X size={14} />취소</Button>}
        {(scene.image || compositionStickers(scene).length > 0 || compositionSubtitle(scene)) && <Button variant="outline" disabled={busy || Boolean(scene.image && !preview)} onClick={async () => {
          try {
            const background = scene.image ? await loadSceneImage(scene.image.id) : undefined;
            if (scene.image && !background) throw new Error("콘티 배경을 찾지 못했습니다. 다시 첨부해 주세요.");
            downloadBlob(await exportSceneComposition(scene, background), "storyboard-composition.png");
          } catch { setError("콘티 이미지를 저장하지 못했습니다. 다시 시도해 주세요."); }
        }}><Download size={14} />이미지 저장</Button>}
        {scene.image && <>
          <Button variant="ghost" disabled={busy} onClick={() => { onChange(undefined); setMessage(""); setError(""); }}><Trash2 size={14} />이미지 제거</Button>
        </>}
      </div>
      {status?.available ? <p className="scene-image-cost">한 번에 1장 · 호출당 최대 ${status.perImageCeilingUSD.toFixed(3)} · 공통 하루 $1·월 $5 한도 적용<br />호출 전 ${status.reservationUSD.toFixed(3)}를 임시 확보하며 자동 재시도는 하지 않습니다. 장면 내용·연결 근거{scene.image && useReference ? "·참고 이미지" : ""}가 {status.vendor ?? "연결된 이미지 AI"}로 전송됩니다.</p>
        : <p className="scene-image-cost">{status?.reason || "이미지 연결 상태를 확인하고 있습니다."} <Button variant="outline" size="sm" onClick={onOpenConnection}>모델 연결</Button></p>}
      <SceneComposition scene={scene} preview={preview} busy={busy} onChange={onPlacementsChange} onSubtitleSettingsChange={onSubtitleSettingsChange} />
      <div className="scene-image-settings">
        <label>공통 그림체<select aria-label="공통 그림체" value={imageSettings.style} disabled={busy} onChange={event => onSettingsChange({ ...imageSettings, style: event.target.value as ImageSettings["style"] })}>
          {Object.entries(imageStyles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>공통 인물·배경 설정 <small>모든 장면에 적용</small>
          <Textarea aria-label="공통 인물·배경 설정" value={imageSettings.direction} maxLength={600} rows={2} disabled={busy} placeholder="예: 파란 작업복과 흰 안전모, 같은 공장 배경" onChange={event => onSettingsChange({ ...imageSettings, direction: event.target.value })} />
        </label>
        <label>이 장면 수정 요청
          <Textarea aria-label="이미지 수정 요청" value={direction} maxLength={500} rows={2} disabled={busy} placeholder="예: 작업자의 손동작을 가까이 보여줘" onChange={event => setDirection(event.target.value)} />
        </label>
        {scene.image && <label className="connection-check"><input type="checkbox" checked={useReference} disabled={busy} onChange={event => setUseReference(event.target.checked)} />현재 이미지를 구도·인물 참고로 사용</label>}
      </div>
      {(!scene.visual.trim() || !scene.evidence.trim()) && <p className="scene-image-cost">화면 설명과 원문 근거를 채우면 이미지를 생성할 수 있습니다.</p>}
      {scene.image?.sourceType !== "generated" && scene.image && <label className="scene-image-source">이미지 출처<Input value={scene.image.sourceText} maxLength={300} disabled={busy} onChange={event => onChange({ ...scene.image!, sourceText: event.target.value })} /></label>}
      <details className="scene-image-evidence"><summary>이미지에 참고할 원문·RAG 근거</summary><blockquote>{scene.evidence || "원문 근거를 먼저 확인하세요."}</blockquote>
        {[...(scene.references ?? []), ...(scene.visualReferences ?? [])].filter((ref, i, refs) => refs.findIndex(item => item.id === ref.id) === i).map(ref => <p key={ref.id}><strong>{ref.title}{ref.page ? ` · ${ref.page}페이지` : ""}</strong><br />{ref.excerpt}</p>)}
      </details>
      {message && <p role="status" className="scene-image-cost">{message}</p>}
      {basisHash && scene.image?.generated?.basedOn && basisHash !== scene.image.generated.basedOn && <p role="status" className="scene-image-cost">장면 내용·자료 배치 또는 공통 설정이 바뀌었습니다. 배경 구도가 맞는지 확인하고 필요하면 다시 생성하세요.</p>}
      {error && <p role="alert" className="connection-error">{error}</p>}
    </div>
  </SceneSection>;
}
