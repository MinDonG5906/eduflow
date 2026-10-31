// Measurable parts of the audience writing rules, shared by the server warning, the
// version comparison and tests. The prompt wording lives in PROMPT_TEMPLATE.

// Foreign-worker narration: one action per sentence, about 20 letters, at most this many.
export const EASY_SENTENCE_MAX_CHARS = 25;
// Shorter fragments ("확인합니다.") match the manuscript by chance, not by copying it.
const MIN_VERBATIM_CHARS = 8;

export const letters = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, "");

/** Narration split into sentences, counted in letters and digits only. */
export function narrationSentences(narration: string) {
  return narration.split(/(?<=[.!?。])\s+|\n+/).map(letters).filter(Boolean);
}

/** Scene numbers (1-based) whose narration has a sentence longer than the limit. */
export function longSentenceScenes(scenes: { narration: string }[], limit = EASY_SENTENCE_MAX_CHARS) {
  return scenes.flatMap((scene, index) =>
    narrationSentences(scene.narration).some((sentence) => [...sentence].length > limit) ? [index + 1] : []);
}

/** Share (0–100) of narration sentences read word for word from the manuscript. */
export function verbatimNarrationPercent(scenes: { narration: string }[], manuscript: string) {
  const source = letters(manuscript);
  const sentences = scenes.flatMap((scene) => narrationSentences(scene.narration));
  if (!sentences.length) return 0;
  const copied = sentences.filter((sentence) => sentence.length >= MIN_VERBATIM_CHARS && source.includes(sentence)).length;
  return Math.round((copied / sentences.length) * 100);
}
