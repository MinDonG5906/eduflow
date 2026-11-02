import { z } from "zod";
import { localizationTargets, viewerLanguage, type LocalizationTarget } from "./languages";
import type { Board, Scene } from "./storyboard";

// Translations of the Korean master's viewer-facing text. Evidence, purpose and
// production notes stay Korean: the planner reviews them, viewers never see them.
export const LOCALIZATION_CONTRACT = "eduflow-localization-v1" as const;
export const MAX_LOCALIZED_SCENES = 30;

export type MasterText = Pick<Scene, "title" | "narration" | "subtitle">;
// FNV-1a, so client and server agree without async crypto.
function fnv(value: unknown) {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(value)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
export const masterHash = ({ title, narration, subtitle }: MasterText) => fnv([title, narration, subtitle]);
export const titleHash = (title: string) => fnv(title);

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
  // The Korean title the translated title was made from. Absent in early drafts.
  titleBasedOn: z.string().regex(/^[0-9a-f]{8}$/).optional(),
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
// Scenes deleted while a batch was running are dropped. The translated title is
// replaced only when the Korean title changed, so a planner's edit survives re-translation.
export function applyLocalization(board: Board, language: LocalizationTarget, result: Localization): Board {
  const previous = board.localizations?.[language];
  const current = new Set(board.scenes.map(scene => scene.id));
  const scenes = Object.fromEntries(Object.entries({ ...previous?.scenes, ...result.scenes }).filter(([id]) => current.has(id)));
  const keepTitle = previous?.titleBasedOn !== undefined && previous.titleBasedOn === result.titleBasedOn;
  return { ...board, localizations: { ...board.localizations, [language]: { ...result, title: keepTitle ? previous.title : result.title, scenes } } };
}

// A planner's correction keeps the master it was translated from; checks rerun on the new text.
// The back-translation of an edited field no longer describes it, so it is cleared.
export function editLocalizedScene(board: Board, language: LocalizationTarget, scene: Scene, patch: Partial<MasterText>): Board {
  const localization = board.localizations?.[language], localized = localization?.scenes[scene.id];
  if (!localization || !localized) return board;
  const next = { ...localized, ...patch,
    backTranslation: { ...localized.backTranslation, ...Object.fromEntries(Object.keys(patch).map(key => [key, ""])) } };
  next.warnings = localizationWarnings(scene, next, language);
  return { ...board, localizations: { ...board.localizations, [language]: { ...localization, scenes: { ...localization.scenes, [scene.id]: next } } } };
}
export function editLocalizedTitle(board: Board, language: LocalizationTarget, title: string): Board {
  const localization = board.localizations?.[language];
  return localization ? { ...board, localizations: { ...board.localizations, [language]: { ...localization, title } } } : board;
}

// Scenes still to translate: never translated, or the Korean master changed since.
export function pendingScenes(board: Board, language: LocalizationTarget) {
  return board.scenes.filter(scene => localizationState(board, language, scene) !== "ready");
}

// Keeps each request well under the 8,000-token output cap: the reply carries the
// translation and a Korean back-translation, and Sinhala and Khmer take several
// tokens per character. Limits are Korean source characters per request (estimates).
export function translationBatches(scenes: Scene[], language: LocalizationTarget) {
  const limit = language === "si" || language === "km" ? 1200 : language === "zh-Hans" ? 2000 : 3000;
  const batches: string[][] = [];
  let size = 0;
  for (const scene of scenes) {
    const length = scene.title.length + scene.narration.length + scene.subtitle.length;
    const last = batches.at(-1);
    if (last && last.length < 10 && size + length <= limit) { last.push(scene.id); size += length; }
    else { batches.push([scene.id]); size = length; }
  }
  return batches;
}

const scripts: Record<string, RegExp> = {
  Hangul: /\p{Script=Hangul}/u, Latin: /\p{Script=Latin}/u, Han: /\p{Script=Han}/u,
  Sinhala: /\p{Script=Sinhala}/u, Khmer: /\p{Script=Khmer}/u,
};
// Khmer digits are the only native digits these languages commonly use.
const numbers = (value: string) => value.replace(/[០-៩]/g, digit => String(digit.charCodeAt(0) - 0x17e0))
  .match(/\d+(?:[.,]\d+)?/g)?.map(number => number.replace(",", ".")) ?? [];

// Local checks only: no extra AI call. Each warning asks the planner to compare,
// it does not prove the translation is right or wrong.
export function localizationWarnings(master: MasterText, translated: MasterText & { backTranslation: MasterText }, language: LocalizationTarget) {
  const warnings: string[] = [];
  const target = viewerLanguage(language);
  const body = `${translated.narration}\n${translated.subtitle}`;
  // Korean site terms in parentheses are expected; any other Korean left in the text counts against the target.
  const checked = language === "ko-easy" ? body : body.replace(/[(（][^()（）]*\p{Script=Hangul}[^()（）]*[)）]/gu, "");
  const letters = checked.match(/\p{L}/gu) ?? [];
  const sourceHasText = /\p{L}/u.test(`${master.narration}${master.subtitle}`);
  if (sourceHasText && (!letters.length || letters.filter(letter => scripts[target.script].test(letter)).length / letters.length < .6))
    warnings.push(`${target.label} 문자가 적습니다. 다른 언어로 쓰였는지 확인해 주세요.`);
  const available = numbers(`${translated.title}\n${body}`);
  const missing = numbers(`${master.title}\n${master.narration}\n${master.subtitle}`).filter(number => {
    const index = available.indexOf(number);
    if (index < 0) return true;
    available.splice(index, 1);
    return false;
  });
  if (missing.length) warnings.push(`원문의 숫자 ${[...new Set(missing)].join(", ")}이(가) 번역에 없습니다.`);
  const lines = (value: string) => value.trim().split(/\r?\n/).length;
  if (lines(master.subtitle) !== lines(translated.subtitle))
    warnings.push(`자막 줄 수가 원문(${lines(master.subtitle)}줄)과 다릅니다.`);
  if (language !== "ko-easy" && (["narration", "subtitle"] as const).some(field => translated[field].trim() && !translated.backTranslation[field].trim()))
    warnings.push("역번역이 없는 부분이 있어 한국어로 대조할 수 없습니다. 다시 번역하면 확인할 수 있습니다.");
  return warnings;
}

export type LocalizationState = "missing" | "stale" | "ready";
export function localizationState(board: Board, language: LocalizationTarget, scene: Scene): LocalizationState {
  const localized = board.localizations?.[language]?.scenes[scene.id];
  if (!localized) return "missing";
  return localized.basedOn === masterHash(scene) ? "ready" : "stale";
}

