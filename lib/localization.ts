import { z } from "zod";
import { localizationTargets, type LocalizationTarget } from "./languages";
import type { Board, Scene } from "./storyboard";

// Translations of the Korean master's viewer-facing text. Evidence, purpose and
// production notes stay Korean: the planner reviews them, viewers never see them.
export const LOCALIZATION_CONTRACT = "eduflow-localization-v1" as const;
export const MAX_LOCALIZED_SCENES = 30;

export type MasterText = Pick<Scene, "title" | "narration" | "subtitle">;
// FNV-1a over the master text, so client and server agree without async crypto.
export function masterHash({ title, narration, subtitle }: MasterText) {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify([title, narration, subtitle])) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const textFields = { title: z.string().max(400), narration: z.string().max(30000), subtitle: z.string().max(3000) };
export const localizedSceneSchema = z.object({
  ...textFields,
  // The translation read back into Korean, for planners who cannot read the target language.
  backTranslation: z.object(textFields),
  basedOn: z.string().regex(/^[0-9a-f]{8}$/),
  warnings: z.array(z.string().max(300)).max(10),
});
export type LocalizedScene = z.infer<typeof localizedSceneSchema>;
export const localizationSchema = z.object({
  contractVersion: z.literal(LOCALIZATION_CONTRACT),
  model: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(100),
  createdAt: z.string().datetime(),
  title: z.string().max(400),
  scenes: z.record(z.string(), localizedSceneSchema),
});
export type Localization = z.infer<typeof localizationSchema>;
export const localizationsSchema = z.partialRecord(z.enum(localizationTargets), localizationSchema);

export const localizationRequestSchema = z.strictObject({
  language: z.enum(localizationTargets),
  audience: z.string().max(100),
  title: z.string().trim().min(1).max(160),
  scenes: z.array(z.strictObject({
    id: z.string().uuid(), title: z.string().max(160), narration: z.string().max(24000), subtitle: z.string().max(2000),
  })).min(1).max(MAX_LOCALIZED_SCENES),
});
export type LocalizationRequest = z.infer<typeof localizationRequestSchema>;
export const localizationResponseSchema = z.object({ language: z.enum(localizationTargets), localization: localizationSchema });

export function localizationRequest(board: Board, language: LocalizationTarget, sceneIds?: string[]): LocalizationRequest {
  return {
    language, audience: board.settings.audience, title: board.title,
    scenes: board.scenes.filter(scene => !sceneIds || sceneIds.includes(scene.id))
      .map(({ id, title, narration, subtitle }) => ({ id, title, narration, subtitle })),
  };
}

// Scenes may be translated in batches; a newer batch replaces only its own scenes.
export function applyLocalization(board: Board, language: LocalizationTarget, result: Localization): Board {
  const previous = board.localizations?.[language];
  return { ...board, localizations: { ...board.localizations,
    [language]: { ...result, scenes: { ...previous?.scenes, ...result.scenes } } } };
}

export type LocalizationState = "missing" | "stale" | "ready";
export function localizationState(board: Board, language: LocalizationTarget, scene: Scene): LocalizationState {
  const localized = board.localizations?.[language]?.scenes[scene.id];
  if (!localized) return "missing";
  return localized.basedOn === masterHash(scene) ? "ready" : "stale";
}
