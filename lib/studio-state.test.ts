import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, generateDemo, sample } from "./storyboard";
import { captureGeneration, normalizeDuration, readDraft, retryConflict, serializeDraft } from "./studio-state";

test("fractional scene duration becomes an integer and survives a saved-draft round trip", () => {
  const board = generateDemo(sample, defaults);
  board.scenes[0].duration = normalizeDuration("1.5");
  const draft = { manuscript: sample, settings: defaults, board };
  const restored = readDraft(serializeDraft(draft));
  assert.equal(restored.board?.scenes[0].duration, 2);
  assert.deepEqual(restored, draft);
  for (const value of ["", "0", "-1", "NaN", "Infinity"]) assert.equal(normalizeDuration(value), 1);
  assert.equal(normalizeDuration("601"), 600);
});

test("invalid edits cannot replace a valid serialized draft", () => {
  const board = generateDemo(sample, defaults);
  let saved = serializeDraft({ manuscript: sample, settings: defaults, board });
  const original = saved;
  board.scenes[0].duration = 1.5;
  assert.throws(() => { saved = serializeDraft({ manuscript: sample, settings: defaults, board }); });
  assert.equal(saved, original);
  assert.equal(readDraft(saved).board?.scenes[0].duration, 30);
});

test("retry retains its original scene, manuscript, settings and direction after other edits", () => {
  const settings = structuredClone(defaults);
  const board = generateDemo(sample, settings);
  const original = structuredClone(board.scenes[0]);
  const job = captureGeneration({ manuscript: sample, settings, scene: board.scenes[0], direction: "핵심어 강조" }, board);
  settings.keywords.push("이후에 추가한 키워드");
  board.scenes[1].narration = "다른 장면의 수정은 유지되어야 합니다.";
  board.scenes.reverse();
  assert.equal(retryConflict(job, board), null);
  assert.deepEqual(job.input.scene, original);
  assert.deepEqual(job.input.settings.keywords, []);
  assert.equal(job.input.manuscript, sample);
  assert.equal(job.input.direction, "핵심어 강조");
  const result = generateDemo(job.input.manuscript, job.input.settings, job.input.scene, job.input.direction);
  const next = { ...board, scenes: board.scenes.map((scene) => scene.id === job.input.scene?.id ? result.scenes[0] : scene) };
  assert.equal(next.scenes.find((scene) => scene.id === original.id)?.id, original.id);
  assert.equal(next.scenes[4].narration, "다른 장면의 수정은 유지되어야 합니다.");
});

test("retry refuses to overwrite a target edited or deleted after the failed request", () => {
  const board = generateDemo(sample, defaults);
  const job = captureGeneration({ manuscript: sample, settings: defaults, scene: board.scenes[0] }, board);
  board.scenes[0].narration = "실패 후 사용자가 직접 고친 내용";
  assert.ok(retryConflict(job, board)?.includes("수정"));
  assert.equal(job.input.scene?.narration, job.previousBoard?.scenes[0].narration);
  board.scenes.shift();
  assert.ok(retryConflict(job, board)?.includes("삭제"));
  assert.ok(retryConflict(job, null)?.includes("삭제"));
});

test("whole-board retry refuses to discard edits made after failure", () => {
  const board = generateDemo(sample, defaults);
  const job = captureGeneration({ manuscript: sample, settings: defaults }, board);
  assert.equal(retryConflict(job, board), null);
  board.summary = "직접 수정한 요약";
  assert.ok(retryConflict(job, board)?.includes("수정"));
});
