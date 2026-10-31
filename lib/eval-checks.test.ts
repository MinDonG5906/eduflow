import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, generateDemo, sample } from "./storyboard";
import type { GenerationInput } from "./generation-contract";
import { runGeneration, type GenerationAdapter } from "./server/generation-service";
import { checkBoard, RUBRIC, scoringSheet, type EvalReport } from "./eval-checks";

const input: GenerationInput = { manuscript: sample, settings: defaults };
type Generated = { title: string; summary: string; objectives: string[]; scenes: Record<string, unknown>[] };
function output(request: GenerationInput): Generated {
  const board = generateDemo(request.manuscript, request.settings, request.scene, request.direction);
  return {
    title: board.title, summary: board.summary, objectives: board.objectives,
    scenes: board.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, index) => ({ sceneNo: index + 1, ...scene })),
  };
}
function adapter(edit: (generated: Generated) => void = () => {}, mode: GenerationAdapter["mode"] = "demo"): GenerationAdapter {
  return { mode, model: "test-model", promptVersion: "test-v1", generate: async (request) => { const generated = output(request); edit(generated); return generated; } };
}
const check = (report: EvalReport, id: string) => report.checks.find((item) => item.id === id)!;

test("an extractive demo board passes every required check with exact duration and verbatim citations", async () => {
  const report = checkBoard(await runGeneration(input, adapter()), input);
  assert.equal(report.passed, true);
  assert.deepEqual(report.stats, { scenes: 6, totalSeconds: 180, targetSeconds: 180 });
  for (const id of ["schema", "scene-count", "duration", "citations"]) assert.equal(check(report, id).level, "pass", id);
});

test("missing required content and wrong scene counts fail the required-items criterion", async () => {
  const board = await runGeneration(input, adapter());
  const missing = structuredClone(board) as Record<string, unknown>;
  delete missing.summary;
  const schema = checkBoard(missing, input);
  assert.equal(schema.passed, false);
  assert.match(check(schema, "schema").detail, /summary/);

  const short = { ...board, scenes: board.scenes.slice(0, 5) };
  const count = checkBoard(short, input);
  assert.equal(count.passed, false);
  assert.equal(check(count, "scene-count").level, "fail");
  assert.equal(check(count, "scene-count").detail, "요청 6개, 생성 5개");
});

test("citations are re-checked against the manuscript even when the server reported nothing", async () => {
  const board = await runGeneration(input, adapter());
  assert.equal(board.generation?.warnings.length, 0);
  board.scenes[1].evidence = "원고에 없는 문장입니다.";
  board.scenes[3].evidence = "";
  const report = checkBoard(board, input);
  assert.equal(report.passed, true);
  assert.deepEqual(check(report, "citations").scenes, [2, 4]);
  assert.equal(check(report, "citations").level, "warn");
});

test("only citation warnings mark scenes as citation problems", async () => {
  const board = await runGeneration(input, adapter((generated) => {
    generated.scenes[1].referenceIds = ["knowledge:missing"];
    generated.scenes[2].phase = "outro";
  }, "ai"));
  assert.ok(board.generation?.warnings.some((warning) => warning.startsWith("2번 장면: 확인되지 않은")));
  assert.equal(check(checkBoard(board, input), "citations").level, "pass");
});

test("duration drift beyond 10%, long subtitles and narration pace are flagged without failing", async () => {
  const board = await runGeneration(input, adapter((generated) => {
    generated.scenes[0].duration = 60;
    for (const scene of generated.scenes) scene.subtitle = "짧은 자막";
    generated.scenes[2].subtitle = "가".repeat(41);
    generated.scenes[4].narration = "짧음";
  }));
  const report = checkBoard(board, input);
  assert.equal(report.passed, true);
  assert.equal(check(report, "duration").level, "warn");
  assert.match(check(report, "duration").detail, /합계 210초 \/ 목표 180초 \(\+16\.7%\)/);
  assert.deepEqual(check(report, "subtitle-length").scenes, [3]);
  assert.equal(check(report, "narration-pace").level, "info");
  assert.ok(check(report, "narration-pace").scenes!.includes(5));

  const english = { ...input, settings: { ...defaults, language: "영어" as const } };
  assert.equal(check(checkBoard(await runGeneration(english, adapter()), english), "narration-pace").detail, "한국어 출력에만 적용합니다.");
});

test("automatic term corrections are listed for reviewers", async () => {
  const board = await runGeneration(input, adapter((generated) => { generated.scenes[0].narration += " 껴임 사고를 막습니다."; }, "ai"));
  const corrections = check(checkBoard(board, input), "term-corrections");
  assert.equal(corrections.level, "info");
  assert.match(corrections.detail, /껴임/);
});

test("scoring sheet has a case row, one row per scene, marked non-applicable cells and safe cells", async () => {
  const board = await runGeneration(input, adapter());
  board.scenes[0].title = "=HYPERLINK(\"x\")";
  const sheet = scoringSheet([{ id: "case-1", title: "탄소중립", board }, { id: "case-2", title: "실패", error: "BUDGET_EXCEEDED" }]);
  assert.ok(sheet.startsWith("﻿"));
  const rows = sheet.slice(1).trimEnd().split("\r\n");
  assert.equal(rows.length, 1 + 1 + 6 + 1);
  const header = rows[0].split(",");
  assert.equal(header.length, 6 + RUBRIC.filter((item) => item.scope !== "round").length + 2);
  assert.ok(!sheet.includes(RUBRIC.find((item) => item.scope === "round")!.label));
  // Case rows leave case items blank; scene rows leave scene items blank.
  const na = '"해당 없음"';
  assert.ok(rows[1].includes('"전체"') && rows[1].includes(`"","","",${na},${na},${na},${na},""`));
  assert.ok(rows[2].includes(`${na},${na},${na},"","","","",${na}`));
  assert.ok(rows[2].includes("\"'=HYPERLINK(\"\"x\"\")\""));
  assert.ok(rows[8].endsWith('"생성 실패: BUDGET_EXCEEDED"'));
});
