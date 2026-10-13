import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, generateDemo, sample } from "./storyboard";
import { captureGeneration, normalizeDuration, readDraft, retryConflict, serializeDraft,
  DRAFT_STORAGE_KEY, RETIRED_EXAMPLE_BACKUP_KEY, restoreBrowserDraft } from "./studio-state";

function oldExampleDraft() {
  const board = generateDemo(sample, { ...defaults, count: 12 });
  board.title = "훈민정음, 백성을 위한 새로운 문자";
  const titles = ["한자의 장벽", "말하고 싶어도 쓰기 어려운 현실", "세종의 문제의식", "새 문자 창제의 시작",
    "완성과 반포", "소리의 원리를 담은 문자", "하늘·땅·사람의 모음", "조합과 확장성",
    "백성의 기록 수단이 되다", "지식의 확산", "새 문자에서 공공 자산으로", "오늘의 한글과 기록유산"];
  board.scenes.forEach((scene, i) => { scene.title = titles[i]; });
  return { manuscript: "현재 작성 중인 산업안전 원고", settings: defaults, board,
    document: { name: "현재-안전교육.pdf", kind: "pdf" as const, text: "", query: "제조업 사고 예방 교육", pages: 154, selectedPages: [2, 3], fileId: crypto.randomUUID() } };
}
function draftStorage(raw: string) {
  const values = new Map([[DRAFT_STORAGE_KEY, raw]]);
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("retired example result is backed up and removed while current PDF, request, manuscript and settings survive reopening", () => {
  const draft = oldExampleDraft(), original = serializeDraft(draft), storage = draftStorage(original);
  const result = restoreBrowserDraft(original, storage);
  assert.equal(result.removedExample, true);
  assert.deepEqual(result.draft, { ...draft, board: null });
  assert.equal(storage.getItem(RETIRED_EXAMPLE_BACKUP_KEY), original);
  const saved = storage.getItem(DRAFT_STORAGE_KEY)!;
  assert.equal(readDraft(saved).board, null);
  assert.deepEqual(restoreBrowserDraft(saved, storage), { draft: result.draft, removedExample: false });
  // Completing the one-time cleanup never deletes a newly created board, even on the same subject.
  storage.setItem(DRAFT_STORAGE_KEY, original);
  assert.deepEqual(restoreBrowserDraft(original, storage), { draft, removedExample: false });
  assert.equal(storage.getItem(RETIRED_EXAMPLE_BACKUP_KEY), original);
});

test("normal, newly created and partially matching boards are preserved by legacy cleanup", () => {
  const drafts = [
    { manuscript: sample, settings: defaults, board: generateDemo(sample, defaults) },
    oldExampleDraft(),
  ];
  drafts[1].board.scenes[0].title = "사용자가 새로 작성한 훈민정음 교육";
  for (const draft of drafts) {
    const raw = serializeDraft(draft), storage = draftStorage(raw);
    assert.deepEqual(restoreBrowserDraft(raw, storage), { draft, removedExample: false });
    assert.equal(storage.getItem(DRAFT_STORAGE_KEY), raw);
    assert.equal(storage.getItem(RETIRED_EXAMPLE_BACKUP_KEY), null);
  }
});

test("legacy cleanup cannot erase saved work if backup or replacement storage fails", () => {
  const raw = serializeDraft(oldExampleDraft());
  for (const failedKey of [RETIRED_EXAMPLE_BACKUP_KEY, DRAFT_STORAGE_KEY]) {
    const storage = draftStorage(raw), write = storage.setItem;
    storage.setItem = (key, value) => { if (key === failedKey) throw new Error("storage quota"); write(key, value); };
    assert.throws(() => restoreBrowserDraft(raw, storage), /storage quota/);
    assert.equal(storage.getItem(DRAFT_STORAGE_KEY), raw);
  }
  const storage = draftStorage("broken saved data");
  assert.throws(() => restoreBrowserDraft("broken saved data", storage));
  assert.equal(storage.values.size, 1);
});

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
