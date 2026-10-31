import { z } from "zod";
import { sceneSchema, sceneReferenceSchema, settingsSchema, type Scene, type Board, type Settings } from "./storyboard";

export const imageStyles = { sketch: "흑백 콘티", illustration: "컬러 일러스트", realistic: "사실적인 장면" } as const;
export type ImageSettings = NonNullable<Board["imageSettings"]>;
export const defaultImageSettings: ImageSettings = { style: "sketch", direction: "" };
const reference = sceneReferenceSchema.pick({ id: true, title: true, excerpt: true, page: true, documentId: true });
export const sceneImageRequestSchema = z.object({
  scene: sceneSchema.pick({ id: true, title: true, purpose: true, visual: true, assets: true, narration: true, evidence: true, sourceId: true, pdfSource: true })
    .extend({ id: z.string().min(1).max(100), title: z.string().max(160), purpose: z.string().max(1000), visual: z.string().trim().min(1).max(5000),
      assets: z.string().max(3000), narration: z.string().max(4000), evidence: z.string().trim().min(1).max(3000), sourceId: z.string().max(100),
      references: z.array(reference).max(6), visualReferences: z.array(reference).max(6) }),
  audience: settingsSchema.shape.audience,
  imageSettings: z.object({ style: z.enum(["sketch", "illustration", "realistic"]), direction: z.string().max(600) }),
  direction: z.string().max(500),
});
export type SceneImageInput = z.infer<typeof sceneImageRequestSchema>;
export const sceneImageBasis = (input: SceneImageInput) => JSON.stringify(sceneImageRequestSchema.parse({ ...input, direction: "" }));
// Only the selected scene and its linked excerpts leave the browser, never full table snapshots.
export function sceneImageInput(scene: Scene, settings: Settings, imageSettings: ImageSettings, direction = ""): SceneImageInput {
  const refs = (items: Scene["references"]) => (items ?? []).map(({ id, title, excerpt, page, documentId }) => ({ id, title, excerpt, page, documentId }));
  return { scene: { id: scene.id, title: scene.title, purpose: scene.purpose, visual: scene.visual, assets: scene.assets,
    narration: scene.narration.slice(0, 4000), evidence: scene.evidence.slice(0, 3000), sourceId: scene.sourceId, pdfSource: scene.pdfSource,
    references: refs(scene.references), visualReferences: refs(scene.visualReferences) }, audience: settings.audience, imageSettings, direction };
}
export const sceneImageResultSchema = z.object({
  sceneId: z.string(), data: z.string().min(1).max(12000000), mimeType: z.literal("image/png"),
  model: z.string().max(100), prompt: z.string().max(40000), createdAt: z.string().datetime(),
  basedOn: z.string().regex(/^[a-f0-9]{64}$/),
});
export const sceneImageStatusSchema = z.object({ available: z.boolean(), reason: z.string(), model: z.string(),
  vendor: z.enum(["OpenAI", "Google"]).nullable().default(null),
  perImageCeilingUSD: z.number().positive(), reservationUSD: z.number().positive() });
export type SceneImageStatus = z.infer<typeof sceneImageStatusSchema>;
