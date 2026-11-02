import assert from "node:assert/strict";
import test from "node:test";
import { newScene, defaults, plainText, type Scene } from "./storyboard";
import { decisionInUse, decisionKey, evidenceReviewText, undoEvidenceDecision, useEvidenceDecision, useEvidenceDecisions } from "./evidence-review";
import { defaultImageSettings, sceneImageInput } from "./scene-image";
import { readDraft, serializeDraft } from "./studio-state";

function fixture(field: "narration" | "subtitle" | "visual" | "assets", status: "deferred" | "rejected"): Scene {
  return { ...newScene(), [field]: "기존 작업 내용입니다.", grounding: { status: "review_required", links: [], decisions: [{
    referenceId: "ref:1", field, sentence: "이 문장을 사용합니다.", quote: "", reason: "원문에서 직접 확인되지 않음",
    status, sourceTitle: "참고 자료", page: 8,
  }] } };
}

test("manual use applies each field once and preserves the unsuccessful verdict through save and export", () => {
  for (const field of ["narration", "subtitle", "visual", "assets"] as const) {
    for (const status of ["deferred", "rejected"] as const) {
      const original = fixture(field, status);
      const key = decisionKey(original.grounding!.decisions![0]);
      const result = useEvidenceDecision(original, key);
      assert.equal(result[field], "기존 작업 내용입니다.\n이 문장을 사용합니다.");
      assert.equal(original[field], "기존 작업 내용입니다.");
      assert.equal(result.grounding!.status, "stale");
      assert.equal(result.grounding!.links.length, 0);
      assert.equal(result.grounding!.decisions![0].status, status);
      assert.equal(useEvidenceDecision(result, key), result);
      const board = { title: "교육", summary: "", objectives: ["내용 확인"], mode: "ai" as const, settings: defaults, scenes: [result] };
      const restored = readDraft(serializeDraft({ manuscript: "", settings: defaults, board })).board!.scenes[0];
      assert.ok(decisionInUse(restored, restored.grounding!.decisions![0]));
      assert.match(evidenceReviewText(restored), /사용자 선택으로 사용 중 · AI 근거 검증 미통과/);
      assert.match(evidenceReviewText(restored), /원문에서 직접 확인되지 않음/);
      assert.match(plainText({ ...board, scenes: [restored] }), /사용자 선택으로 사용 중 · AI 근거 검증 미통과/);
    }
  }
});

test("existing text is selected without duplication; changed text may be applied again", () => {
  const original = fixture("narration", "deferred");
  original.narration = "이 문장을 사용합니다.";
  const key = decisionKey(original.grounding!.decisions![0]);
  const used = useEvidenceDecision(original, key);
  assert.equal(used.narration, original.narration);
  assert.equal(used.grounding!.status, "review_required");
  const edited = { ...used, narration: "수정한 내용입니다." };
  assert.equal(decisionInUse(edited, edited.grounding!.decisions![0]), false);
  assert.match(evidenceReviewText(edited), /이전 사용자 선택 · 본문 변경됨/);
  assert.equal(useEvidenceDecision(edited, key).narration, "수정한 내용입니다.\n이 문장을 사용합니다.");
  assert.equal(useEvidenceDecision(original, "unknown"), original);
});

test("batch selection uses displayed order, ignores unselected items, and feeds updated content to image generation", () => {
  const original = fixture("narration", "deferred");
  const base = original.grounding!.decisions![0];
  original.visual = "기존 화면입니다.";
  original.grounding!.decisions = [base,
    { ...base, field: "visual", sentence: "작업자가 안내판을 확인하는 장면입니다." },
    { ...base, field: "narration", sentence: "두 번째 추가 문장입니다." },
    { ...base, field: "assets", sentence: "선택하지 않은 제안입니다." },
    { ...base, referenceId: "duplicate-source" },
  ];
  const selected = original.grounding!.decisions.filter(item => item.field !== "assets").map(decisionKey).reverse();
  const result = useEvidenceDecisions(original, [...selected, selected[0], "unknown"]);
  assert.equal(result.narration, "기존 작업 내용입니다.\n이 문장을 사용합니다.\n두 번째 추가 문장입니다.");
  assert.equal(result.visual, "기존 화면입니다.\n작업자가 안내판을 확인하는 장면입니다.");
  assert.equal(result.assets, original.assets);
  assert.equal(result.grounding!.decisions![3].used, undefined);
  assert.equal(result.grounding!.links.length, 0);
  const input = sceneImageInput(result, defaults, defaultImageSettings);
  assert.equal(input.scene.visual, result.visual);
  assert.equal(input.scene.narration, result.narration);
  assert.equal(useEvidenceDecisions(result, selected), result);
});

test("undo survives saving, restores only the inserted sentence and permits reuse", () => {
  for (const field of ["narration", "subtitle", "visual", "assets"] as const) {
    const original = fixture(field, "deferred");
    const key = decisionKey(original.grounding!.decisions![0]);
    const used = useEvidenceDecision(original, key);
    const board = { title: "교육", summary: "", objectives: ["내용 확인"], mode: "ai" as const, settings: defaults, scenes: [used] };
    const restored = readDraft(serializeDraft({ manuscript: "", settings: defaults, board })).board!.scenes[0];
    const undone = undoEvidenceDecision(restored, key);
    assert.equal(undone[field], original[field]);
    assert.equal(undone.grounding!.decisions![0].used, false);
    assert.equal(undone.grounding!.decisions![0].application, undefined);
    assert.equal(undone.grounding!.decisions![0].status, "deferred");
    assert.equal(undone.grounding!.links.length, 0);
    assert.doesNotMatch(evidenceReviewText(undone), /사용자 선택으로 사용 중/);
    assert.equal(undoEvidenceDecision(undone, key), undone);
    assert.equal(useEvidenceDecision(undone, key)[field], used[field]);
  }
});

test("undo preserves pre-existing text, legacy applied records and manual edits", () => {
  const base = fixture("visual", "deferred");
  const key = decisionKey(base.grounding!.decisions![0]);
  const sentence = base.grounding!.decisions![0].sentence;
  const originalText = { ...base, visual: sentence };
  assert.equal(undoEvidenceDecision(useEvidenceDecision(originalText, key), key).visual, sentence);
  const used = useEvidenceDecision(base,key);
  const edited = { ...used, visual: `${used.visual}\n직접 수정한 내용입니다.` };
  assert.equal(undoEvidenceDecision(edited,key).visual,edited.visual);
  const legacy = { ...used, grounding: { ...used.grounding!, decisions: used.grounding!.decisions!.map(item => ({ ...item, application: undefined })) } };
  assert.equal(undoEvidenceDecision(legacy,key).visual,legacy.visual);
  assert.equal(undoEvidenceDecision(base,"missing"),base);
});

test("batch-applied sentences can be undone in either order, including initially empty fields", () => {
  for (const initial of ["", "기존 내용"]) for (const order of [[0,1],[1,0]]) {
    const base=fixture("visual","deferred"); base.visual=initial;
    base.grounding!.decisions!.push({ ...base.grounding!.decisions![0], referenceId:"ref:2", sentence:"두 번째 문장입니다." });
    const keys=base.grounding!.decisions!.map(decisionKey);
    let current=useEvidenceDecisions(base,keys);
    current=undoEvidenceDecision(current,keys[order[0]]);
    assert.equal(current.visual, [initial,base.grounding!.decisions![order[1]].sentence].filter(Boolean).join("\n"));
    current=undoEvidenceDecision(current,keys[order[1]]);
    assert.equal(current.visual,initial);
  }
});

test("a shared inserted sentence remains until the last selected source is undone", () => {
  const base=fixture("narration","deferred");
  base.grounding!.decisions!.push({ ...base.grounding!.decisions![0], referenceId:"another-source" });
  const keys=base.grounding!.decisions!.map(decisionKey);
  const used=useEvidenceDecisions(base,keys);
  const first=undoEvidenceDecision(used,keys[0]);
  assert.equal(first.narration,used.narration);
  assert.ok(decisionInUse(first,first.grounding!.decisions![1]));
  const last=undoEvidenceDecision(first,keys[1]);
  assert.equal(last.narration,base.narration);
  assert.equal(last.image,used.image);
});
