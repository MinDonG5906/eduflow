import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPARISON_STOP_CODES, MAX_COMPARED_AUDIENCES, comparisonSettings, versionMetrics } from "./audience-compare";
import { defaults, generateDemo, sample } from "./storyboard";

test("each compared audience keeps every other setting, without duplicates and up to the limit", () => {
  const base = { ...defaults, minutes: 2, keywords: ["안전모"], tone: "공식적" as const };
  const settings = comparisonSettings(base, ["외국인 근로자", "산업현장 근무자", "외국인 근로자", "현장 방문자 · 일반인", "현장 방문자 · 기업 관계자"]);
  assert.equal(settings.length, MAX_COMPARED_AUDIENCES);
  assert.deepEqual(settings.map((item) => item.audience), ["외국인 근로자", "산업현장 근무자", "현장 방문자 · 일반인"]);
  assert.ok(settings.every((item) => item.minutes === 2 && item.tone === "공식적" && item.keywords[0] === "안전모"));
});

test("version metrics count narration sentences and subtitles in letters only", () => {
  const board = generateDemo(sample, defaults);
  board.scenes = board.scenes.slice(0, 2).map((scene, index) => ({
    ...scene,
    duration: 20 + index * 10,
    narration: index ? "안전모를 씁니다. 턱끈을 조입니다!" : "작업 전에 발판을 확인하세요.",
    subtitle: index ? "턱끈 조이기" : "발판 확인, 꼭!",
  }));
  // Sentences: 작업전에발판을확인하세요 (12), 안전모를씁니다 (7), 턱끈을조입니다 (7) → 8.67 → 9
  assert.deepEqual(versionMetrics(board), { totalSeconds: 50, sentenceChars: 9, subtitleChars: 5, warnings: 0 });
});

test("a comparison run stops on limits and connection problems but not on a single bad draft", () => {
  for (const code of ["RATE_LIMITED", "BUDGET_EXCEEDED", "AI_NOT_CONFIGURED", "AI_ACCESS_DENIED"]) assert.ok(COMPARISON_STOP_CODES.has(code), code);
  for (const code of ["INVALID_OUTPUT", "TIMEOUT", "PROVIDER_UNAVAILABLE"]) assert.ok(!COMPARISON_STOP_CODES.has(code), code);
});
