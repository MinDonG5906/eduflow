import { z } from "zod";
import { readDraft, serializeDraft, type Draft } from "./studio-state";

export const MAX_WORK_PACKAGE_BYTES = 160 * 1024 * 1024;
const assetSchema = z.object({ id: z.string().min(1).max(200), type: z.enum(["application/pdf", "image/png", "image/jpeg", "image/webp"]),
  data: z.string().min(4).max(MAX_WORK_PACKAGE_BYTES).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const workPackageSchema = z.object({ format: z.literal("eduflow-work"), version: z.literal(1), createdAt: z.string().datetime(),
  draft: z.string().max(8 * 1024 * 1024), images: z.array(assetSchema).max(100), pdf: assetSchema.optional() }).strict();
export type WorkPackage = z.infer<typeof workPackageSchema>;
export function parseWorkPackage(raw: string): { value: WorkPackage; draft: Draft } {
  if (new TextEncoder().encode(raw).length > MAX_WORK_PACKAGE_BYTES) throw new Error("작업 묶음은 160MB까지 열 수 있습니다.");
  const value = workPackageSchema.parse(JSON.parse(raw));
  const draft = readDraft(value.draft);
  const expected = new Set(draft.board?.scenes.flatMap(scene => scene.image ? [scene.image.id] : []) ?? []);
  const actual = new Set(value.images.map(image => image.id));
  if (actual.size !== value.images.length || actual.size !== expected.size || [...expected].some(id => !actual.has(id)) ||
      value.images.some(image => image.type === "application/pdf")) throw new Error("장면 이미지가 누락되었거나 연결 정보가 다릅니다.");
  if (draft.document?.fileId !== value.pdf?.id || value.pdf && value.pdf.type !== "application/pdf")
    throw new Error("원고 PDF와 페이지 연결 정보가 다릅니다.");
  // Ensure restored data can be saved without schema loss or a later failure.
  serializeDraft(draft);
  return { value, draft };
}
