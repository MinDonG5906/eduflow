import type { GenerationErrorCode } from "./generation-contract";
import { audienceOptions, type Board, type Settings } from "./storyboard";

export type Audience = (typeof audienceOptions)[number];
export type ComparisonVersion = {
  audience: Audience;
  board?: Board;
  error?: { code: GenerationErrorCode | "NETWORK"; message: string };
};

// Each version is one full generation request, and the server allows one at a time.
export const MAX_COMPARED_AUDIENCES = 3;

// After these the next audience would fail the same way, so a comparison run stops.
export const COMPARISON_STOP_CODES = new Set<string>([
  "RATE_LIMITED", "BUDGET_EXCEEDED", "BUDGET_UNAVAILABLE", "AI_DISABLED", "AI_NOT_CONFIGURED",
  "AI_ACCESS_DENIED", "AI_AUTH_FAILED",
]);

/** Settings for each compared audience: everything but the audience stays as the user set it. */
export function comparisonSettings(base: Settings, audiences: readonly Audience[]): Settings[] {
  return [...new Set(audiences)].slice(0, MAX_COMPARED_AUDIENCES).map((audience) => ({ ...base, audience }));
}

const letters = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, "");
const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

/** Plain numbers that make the audience adaptation visible side by side, without another AI call. */
export function versionMetrics(board: Board) {
  const sentences = board.scenes.flatMap((scene) =>
    scene.narration.split(/(?<=[.!?。])\s+|\n+/).map(letters).filter(Boolean));
  return {
    totalSeconds: board.scenes.reduce((sum, scene) => sum + scene.duration, 0),
    sentenceChars: average(sentences.map((sentence) => [...sentence].length)),
    subtitleChars: average(board.scenes.map((scene) => [...letters(scene.subtitle)].length)),
    warnings: board.generation?.warnings.length ?? 0,
  };
}
