import { generationResponseSchema, type GenerationInput } from "./generation-contract";
import { targetSceneCount, type Board } from "./storyboard";
import { TERM_CORRECTION_NOTICE_PREFIX } from "./term-corrections";

// Human scoring items from docs/06_AI_EVAL.md. "case" items are scored once per
// storyboard, "scene" items per scene, and "round" items once per evaluation round.
export const RUBRIC = [
  { id: "fidelity", label: "1. 핵심 내용 누락·왜곡", scope: "case" },
  { id: "flow", label: "2. 장면 구분·교육 흐름", scope: "case" },
  { id: "audience", label: "3. 대상·난이도 적합성", scope: "case" },
  { id: "visual", label: "4. 화면 설명 제작 가능성", scope: "scene" },
  { id: "narration", label: "5. 나레이션 자연스러움", scope: "scene" },
  { id: "subtitle", label: "6. 자막 길이·가독성·의미 일치", scope: "scene" },
  { id: "evidence", label: "7. 원문 근거 정확성", scope: "scene" },
  { id: "timing", label: "8. 목표 시간 적합성", scope: "case" },
  { id: "recovery", label: "9. 실패 시 보존", scope: "round" },
] as const;

export const DURATION_TOLERANCE = 0.1;
export const MAX_SUBTITLE_CHARS = 40;
export const NARRATION_CHARS_PER_SECOND = { min: 3, max: 8 } as const;

// fail: blocks the official "required items 100%" criterion. warn: a human must look.
// info: reference only, never a pass/fail decision.
export type CheckLevel = "pass" | "fail" | "warn" | "info";
export type EvalCheck = { id: string; label: string; level: CheckLevel; detail: string; scenes?: number[] };
export type EvalReport = {
  passed: boolean;
  checks: EvalCheck[];
  stats?: { scenes: number; totalSeconds: number; targetSeconds: number };
};

const compact = (value: string) => value.replace(/\s/g, "");
const visibleLength = (value: string) => [...value.replace(/\s+/g, " ").trim()].length;

export function checkBoard(raw: unknown, input: GenerationInput): EvalReport {
  const parsed = generationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(전체)"))].slice(0, 5);
    return { passed: false, checks: [{ id: "schema", label: "형식·필수 항목", level: "fail", detail: `필수 항목이 없거나 형식이 맞지 않습니다: ${paths.join(", ")}` }] };
  }
  const board: Board = parsed.data;
  const checks: EvalCheck[] = [{ id: "schema", label: "형식·필수 항목", level: "pass", detail: "모든 필수 항목이 채워져 있습니다." }];

  const expected = input.scene ? 1 : targetSceneCount(input.settings);
  checks.push(board.scenes.length === expected
    ? { id: "scene-count", label: "장면 수", level: "pass", detail: `${expected}개` }
    : { id: "scene-count", label: "장면 수", level: "fail", detail: `요청 ${expected}개, 생성 ${board.scenes.length}개` });

  const totalSeconds = board.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const targetSeconds = input.settings.minutes * 60;
  const drift = Math.abs(totalSeconds - targetSeconds) / targetSeconds;
  checks.push({
    id: "duration", label: "목표 시간", level: input.scene || drift <= DURATION_TOLERANCE ? "pass" : "warn",
    detail: `합계 ${totalSeconds}초 / 목표 ${targetSeconds}초 (${totalSeconds >= targetSeconds ? "+" : "-"}${(drift * 100).toFixed(1)}%)`,
  });

  // Server warnings use "N번 장면: ...".
  const flagged = new Set<number>();
  for (const warning of board.generation?.warnings ?? []) {
    const match = /^(\d+)번 장면:/.exec(warning);
    if (match) flagged.add(Number(match[1]));
  }
  // Re-check text citations independently so a server regression cannot hide them.
  if (!board.pdfSource) {
    const source = compact(input.manuscript);
    board.scenes.forEach((scene, index) => {
      if (!compact(scene.evidence) || !source.includes(compact(scene.evidence))) flagged.add(index + 1);
    });
  }
  const citationScenes = [...flagged].sort((a, b) => a - b);
  checks.push(citationScenes.length
    ? { id: "citations", label: "원문 근거", level: "warn", detail: `${citationScenes.join(", ")}번 장면의 근거가 원문과 일치하지 않거나 비어 있습니다.`, scenes: citationScenes }
    : { id: "citations", label: "원문 근거", level: "pass", detail: board.pdfSource ? "선택 자료의 근거 식별자가 유효합니다. 내용은 원본과 대조해 주세요." : "모든 근거가 원문에 있습니다." });

  const longSubtitles = board.scenes.flatMap((scene, index) => scene.subtitle.split(/\r?\n/).some(line => visibleLength(line) > MAX_SUBTITLE_CHARS) ? [index + 1] : []);
  checks.push(longSubtitles.length
    ? { id: "subtitle-length", label: "자막 길이", level: "warn", detail: `${longSubtitles.join(", ")}번 장면 자막의 한 줄이 ${MAX_SUBTITLE_CHARS}자를 넘습니다.`, scenes: longSubtitles }
    : { id: "subtitle-length", label: "자막 길이", level: "pass", detail: `모든 자막이 한 줄당 ${MAX_SUBTITLE_CHARS}자 이하입니다.` });

  if (input.settings.language === "한국어") {
    const offPace = board.scenes.flatMap((scene, index) => {
      const pace = compact(scene.narration).length / scene.duration;
      return pace < NARRATION_CHARS_PER_SECOND.min || pace > NARRATION_CHARS_PER_SECOND.max ? [index + 1] : [];
    });
    checks.push(offPace.length
      ? { id: "narration-pace", label: "나레이션 속도", level: "info", detail: `${offPace.join(", ")}번 장면이 초당 ${NARRATION_CHARS_PER_SECOND.min}~${NARRATION_CHARS_PER_SECOND.max}자(공백 제외)를 벗어납니다.`, scenes: offPace }
      : { id: "narration-pace", label: "나레이션 속도", level: "pass", detail: `모든 장면이 초당 ${NARRATION_CHARS_PER_SECOND.min}~${NARRATION_CHARS_PER_SECOND.max}자입니다.` });
  } else {
    checks.push({ id: "narration-pace", label: "나레이션 속도", level: "info", detail: "한국어 출력에만 적용합니다." });
  }

  const corrections = (board.generation?.warnings ?? []).filter((warning) => warning.startsWith(TERM_CORRECTION_NOTICE_PREFIX));
  checks.push(corrections.length
    ? { id: "term-corrections", label: "용어 교정", level: "info", detail: corrections.join(" ") }
    : { id: "term-corrections", label: "용어 교정", level: "pass", detail: "자동 교정 없음" });

  return { passed: !checks.some((check) => check.level === "fail"), checks, stats: { scenes: board.scenes.length, totalSeconds, targetSeconds } };
}

const cell = (value: unknown) => {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};

export type ScoringCase = { id: string; title: string; board?: Board; error?: string };

const NOT_APPLICABLE = "해당 없음";

/** Blank sheet for one rater: a "전체" row per case, then one row per scene. */
export function scoringSheet(cases: ScoringCase[]): string {
  const items = RUBRIC.filter((item) => item.scope !== "round");
  const header = ["평가자", "케이스", "케이스 제목", "장면", "장면 제목", "자막", ...items.map((item) => item.label), "중대 왜곡 건수", "메모"];
  const rows: unknown[][] = [];
  for (const entry of cases) {
    rows.push(["", entry.id, entry.title, "전체", entry.board?.title ?? "", "",
      ...items.map((item) => (entry.error || item.scope !== "case" ? NOT_APPLICABLE : "")), entry.error ? NOT_APPLICABLE : "", entry.error ? `생성 실패: ${entry.error}` : ""]);
    entry.board?.scenes.forEach((scene, index) => {
      rows.push(["", entry.id, entry.title, index + 1, scene.title, scene.subtitle,
        ...items.map((item) => (item.scope === "scene" ? "" : NOT_APPLICABLE)), "", ""]);
    });
  }
  return "﻿" + [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
