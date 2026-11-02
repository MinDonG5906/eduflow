import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, generateDemo, newScene, sample } from "./storyboard";
import { editScene, insertSceneAfter, moveScene, removeScene, replaceScene } from "./board-edit";
import { exportFilename } from "./download";

test("editing a field changes only the target scene and records the edited field once", () => {
  const board = generateDemo(sample, defaults);
  const snapshot = JSON.stringify(board);
  const once = editScene(board, 1, "narration", "새 나레이션");
  const twice = editScene(once, 1, "narration", "다시 수정");
  assert.equal(twice.scenes[1].narration, "다시 수정");
  assert.deepEqual(twice.scenes[1].edited, ["narration"]);
  assert.deepEqual(twice.scenes[0], board.scenes[0]);
  assert.equal(JSON.stringify(board), snapshot);
});

test("a new scene is inserted directly after the selected scene", () => {
  const board = generateDemo(sample, defaults);
  const added = newScene();
  const next = insertSceneAfter(board, 0, added);
  assert.equal(next.scenes.length, board.scenes.length + 1);
  assert.equal(next.scenes[1].id, added.id);
  assert.equal(next.scenes[2].id, board.scenes[1].id);
});

test("scenes swap with a neighbour and refuse to move past either end", () => {
  const board = generateDemo(sample, defaults);
  const down = moveScene(board, 0, 1)!;
  assert.deepEqual(down.scenes.slice(0, 2).map((s) => s.id), [board.scenes[1].id, board.scenes[0].id]);
  assert.equal(moveScene(board, 0, -1), null);
  assert.equal(moveScene(board, board.scenes.length - 1, 1), null);
});

test("the last remaining scene cannot be removed", () => {
  const board = generateDemo(sample, { ...defaults, count: 3 });
  const two = removeScene(board, 1)!;
  assert.deepEqual(two.scenes.map((s) => s.id), [board.scenes[0].id, board.scenes[2].id]);
  const one = removeScene(two, 0)!;
  assert.equal(removeScene(one, 0), null);
});

test("a regenerated scene replaces its target and keeps the original id", () => {
  const board = generateDemo(sample, defaults);
  const target = board.scenes[2];
  const replacement = { ...newScene(), title: "재생성된 장면" };
  const next = replaceScene(board, target.id, replacement);
  assert.equal(next.scenes[2].title, "재생성된 장면");
  assert.equal(next.scenes[2].id, target.id);
  assert.deepEqual(next.scenes[1], board.scenes[1]);
});

test("export filenames replace reserved characters and fall back when empty", () => {
  assert.equal(exportFilename(' 안전/교육:1*?"<>| ', "md"), "안전_교육_1______.md");
  assert.equal(exportFilename("   ", "pdf"), "스토리보드.pdf");
});

test("user memo starts blank and survives editing, storage and regeneration without automatic notices", async () => {
  const { sceneMemo } = await import("./scene-memo");
  const { readDraft, serializeDraft } = await import("./studio-state");
  const { markdown } = await import("./storyboard");
  let board = generateDemo(sample, defaults);
  assert.equal(sceneMemo(board.scenes[0]), "");
  assert.equal(sceneMemo(newScene()), "");
  board = editScene(board, 0, "memo", "발표 전에 현장 사진 추가");
  const restored = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board })).board!;
  const regenerated = replaceScene(restored, restored.scenes[0].id, newScene());
  assert.equal(sceneMemo(regenerated.scenes[0]), "발표 전에 현장 사진 추가");
  assert.match(markdown(regenerated), /발표 전에 현장 사진 추가/);
  assert.doesNotMatch(markdown(regenerated), /직접 추가한 장면입니다|원문 발췌 기반 데모입니다/);
  const legacy = editScene(board, 1, "reviewReason", "기존에 직접 쓴 메모");
  const migrated = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board: legacy })).board!;
  assert.equal(sceneMemo(migrated.scenes[1]), "기존에 직접 쓴 메모");
  const cleared = editScene(migrated, 1, "memo", "");
  assert.equal(sceneMemo(cleared.scenes[1]), "");
});
