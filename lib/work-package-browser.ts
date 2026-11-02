import { loadPdf, savePdf, deletePdf } from "./pdf-storage";
import { loadSceneImage, saveSceneImage, deleteSceneImage } from "./scene-image-storage";
import { DRAFT_STORAGE_KEY, readDraft, serializeDraft } from "./studio-state";
import { MAX_WORK_PACKAGE_BYTES, parseWorkPackage, type WorkPackage } from "./work-package";

type WorkStorage = {
  storage: Pick<Storage, "getItem" | "setItem">;
  loadPdf: typeof loadPdf; savePdf: typeof savePdf; deletePdf: typeof deletePdf;
  loadSceneImage: typeof loadSceneImage; saveSceneImage: typeof saveSceneImage; deleteSceneImage: typeof deleteSceneImage;
};
const defaultStorage = (): WorkStorage => ({ storage: localStorage, loadPdf, savePdf, deletePdf, loadSceneImage, saveSceneImage, deleteSceneImage });

const hash = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
async function pack(id: string, blob: Blob, fallback: string): Promise<WorkPackage["images"][number]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { id, type: (blob.type || fallback) as WorkPackage["images"][number]["type"], data: btoa(binary), sha256: await hash(bytes) };
}
export async function exportWorkPackage(store = defaultStorage()) {
  const stored = store.storage.getItem(DRAFT_STORAGE_KEY);
  if (!stored) throw new Error("이 브라우저에 저장된 작업이 없습니다. 작업하던 브라우저와 주소에서 열어 주세요.");
  const draft = readDraft(stored);
  const value: WorkPackage = { format: "eduflow-work", version: 1, createdAt: new Date().toISOString(), draft: serializeDraft(draft), images: [] };
  let bytes = 0;
  for (const id of new Set(draft.board?.scenes.flatMap(scene => scene.image ? [scene.image.id] : []) ?? [])) {
    const blob = await store.loadSceneImage(id);
    if (!blob) throw new Error("저장된 장면 이미지가 없습니다. 해당 장면을 확인해 주세요.");
    bytes += blob.size;
    if (bytes * 1.4 > MAX_WORK_PACKAGE_BYTES) throw new Error("이미지가 너무 큽니다. 이미지 크기를 줄여 주세요.");
    value.images.push(await pack(id, blob, "image/png"));
  }
  if (draft.document?.fileId) {
    const blob = await store.loadPdf(draft.document.fileId);
    if (!blob) throw new Error("저장된 원고 PDF가 없습니다. 원고를 다시 불러와 주세요.");
    bytes += blob.size;
    if (bytes * 1.4 > MAX_WORK_PACKAGE_BYTES) throw new Error("작업 묶음이 너무 큽니다.");
    value.pdf = await pack(draft.document.fileId, blob, "application/pdf");
  }
  if (stored !== store.storage.getItem(DRAFT_STORAGE_KEY)) throw new Error("다른 화면에서 작업이 변경되었습니다. 다시 저장해 주세요.");
  const raw = JSON.stringify(value); parseWorkPackage(raw); return raw;
}
export async function importWorkPackage(raw: string, store = defaultStorage()) {
  const { value, draft } = parseWorkPackage(raw);
  const previous = store.storage.getItem(DRAFT_STORAGE_KEY);
  const created: { id: string; pdf: boolean }[] = [];
  try {
    for (const asset of [...value.images, ...(value.pdf ? [value.pdf] : [])]) {
      const bytes = Uint8Array.from(atob(asset.data), c => c.charCodeAt(0));
      if (await hash(bytes) !== asset.sha256) throw new Error("작업 묶음의 파일이 손상되었습니다.");
      const id = crypto.randomUUID(), isPdf = asset === value.pdf;
      // New IDs prevent a failed import from altering existing image/PDF bytes.
      created.push({ id, pdf: isPdf });
      const blob = new Blob([bytes], { type: asset.type });
      if (isPdf) { await store.savePdf(id, blob); draft.document!.fileId = id; }
      else {
        await store.saveSceneImage(id, blob);
        for (const scene of draft.board?.scenes ?? []) if (scene.image?.id === asset.id) scene.image.id = id;
      }
    }
    if (previous !== store.storage.getItem(DRAFT_STORAGE_KEY)) throw new Error("다른 화면에서 작업이 변경되었습니다. 다시 열어 주세요.");
    if (previous) store.storage.setItem("eduflow-before-work-import", previous);
    store.storage.setItem(DRAFT_STORAGE_KEY, serializeDraft(draft));
  } catch (error) {
    await Promise.allSettled(created.map(item => item.pdf ? store.deletePdf(item.id) : store.deleteSceneImage(item.id)));
    throw error;
  }
}
