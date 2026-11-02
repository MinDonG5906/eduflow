import assert from "node:assert/strict";
import test from "node:test";
import { newScene, defaults, boardSchema, markdown, type Scene } from "./storyboard";
import { evidenceConflict, evidenceLabel, type EvidenceLink } from "./grounding";
import { verifySceneEvidence, type EvidenceVerificationRequest } from "./server/generation-grounding";
import { stageSupplements, commitSupplements } from "./server/generation-supplements";
import { acceptTransferredEvidence, evidenceKey, evidenceReviewText } from "./evidence-review";
import { editScene } from "./board-edit";
import { readDraft, serializeDraft } from "./studio-state";
import { sceneImageInput, defaultImageSettings } from "./scene-image";
import type { RetrievedReference } from "./knowledge";

const source = "지게차 이동 경로에 보행자가 접근하지 않도록 구역을 구분합니다.";
const proposal = "이동 경로와 보행자 대기 장소를 구분하는 방안을 검토합니다.";
const quote = "화물차 이동 경로와 보행자 대기 장소를 구분합니다.";
const ref: RetrievedReference = { id: "transfer:1", documentId: "c0253a76-b550-451c-a04b-d8ebe9b99b4f", title: "화물차 하역 작업 교육자료",
  excerpt: quote, origin: "official", published: "2015", revision: "", url: "", page: 21,
  context: { documentTitle: "화물차 하역 작업 교육자료", sectionTitle: "화물차 작업", tableHeaders: [], surroundingText: quote } };
const transfer = { sourceScope: "화물차 이동 작업", targetScope: "지게차 이동 작업", principle: "차량 이동 경로와 보행자 대기 장소 구분",
  conditions: "지게차 동선과 현장 보행자 대기 공간을 확인한 뒤 적용합니다." };
function scene(): Scene { return { ...newScene(), title: "지게차 이동 경로", evidence: source, narration: source, subtitle: "보행자 접근을 통제합니다." }; }
function judge(request: EvidenceVerificationRequest, applicability = "transfer", sentence = proposal) {
  return { verdicts: request.pairs.map(pair => ({ pairId: pair.id, matches: pair.claims.filter(claim => claim.sentence === sentence).map(claim => ({
    claimId: claim.id, verdict: "supported", quote: pair.reference.excerpt, reason: "보행자와 차량 동선을 구분하는 공통 원칙을 참고합니다.",
    value: "explanation", applicability, transfer: applicability === "transfer" ? transfer : null,
  })) })) };
}
async function stagedResult() {
  const original = scene();
  const { staged, additions } = stageSupplements([original], [[{ field: "narration", text: proposal, referenceId: ref.id }]], () => ref);
  const verified = await verifySceneEvidence(staged, [ref], async request => judge(request), AbortSignal.timeout(1000));
  return commitSupplements([original], verified, additions)[0];
}
const boardFor = (s: Scene) => ({ title: "지게차 교육", summary: "동선 구분", objectives: ["동선 확인"], mode: "ai" as const, settings: defaults, scenes: [s] });

test("reported trailer examples reject phase and inspected-object substitutions, including alleged transfers", async () => {
  for (const [claim, excerpt, reason] of [
    ["운반 전 적재 상태를 다시 확인해야 합니다.", "하역 전에 운송 동안 화물이 움직이지 않았는지 확인하며", "timing"],
    ["적재 상태를 먼저 확인합니다.", "적재 전에 현장 바닥 및 데크(Deck)를 점검하여 안전한지 확인", "object"],
  ]) {
    const reference = { ...ref, excerpt };
    assert.equal(evidenceConflict(claim, excerpt, reference, "지게차"), reason);
    for (const applicability of ["direct", "transfer"]) {
      const [result] = await verifySceneEvidence([{ ...scene(), narration: claim, subtitle: excerpt }], [reference], async request => judge(request, applicability, claim), AbortSignal.timeout(1000));
      assert.equal(result.grounding?.links.length, 0);
      assert.ok(result.grounding?.decisions?.some(decision => decision.status === "rejected"));
    }
  }
});

test("transferred supplements remain separate until accepted, preserving provenance through save and export", async () => {
  const result = await stagedResult();
  assert.equal(result.narration, source);
  assert.equal(result.grounding?.status, "review_required");
  assert.equal(result.grounding?.suggestions?.length, 1);
  assert.equal(sceneImageInput(result, defaults, defaultImageSettings).scene.references.length, 0, "unaccepted proposals cannot leak into image generation");
  const key = evidenceKey(result.grounding!.suggestions![0]);
  const accepted = acceptTransferredEvidence(result, key);
  assert.equal(accepted.narration, `${source}\n${proposal}`);
  assert.equal(accepted.grounding?.suggestions?.length, 0);
  const link = accepted.grounding!.links[0];
  assert.equal(link.review, "accepted");
  assert.equal(accepted.narration.slice(link.start, link.end), proposal);
  assert.equal(link.applicability, "transfer", "human confirmation must not promote an analogy to direct evidence");
  assert.deepEqual(acceptTransferredEvidence(accepted, key), accepted, "double click cannot duplicate content");
  const board = boardFor(accepted);
  assert.ok(boardSchema.safeParse(board).success);
  const restored = readDraft(serializeDraft({ manuscript: source, settings: defaults, board })).board!;
  assert.deepEqual(restored.scenes[0].grounding, accepted.grounding);
  for (const text of [markdown(restored), evidenceReviewText(accepted)]) {
    assert.match(text, /타 자료에서 활용 · 작업자 확인/); assert.match(text, /화물차 이동 작업/); assert.match(text, /원본 21페이지/);
  }
  assert.match(markdown(boardFor(result)), /본문 미반영/);
  const edited = editScene(boardFor(result), 0, "evidence", "다른 작업 원문").scenes[0];
  assert.deepEqual(acceptTransferredEvidence(edited, key), edited, "edited scope invalidates pending acceptance");
  assert.match(evidenceReviewText(edited), /재검증 필요/);
});

test("a direct verdict for a different device is held, and incomplete transfer claims never become direct evidence", async () => {
  for (const mode of ["direct", "missing", "empty", "deferred"] as const) {
    const [result] = await verifySceneEvidence([{ ...scene(), narration: proposal }], [ref], async request => {
      const data = judge(request, mode === "direct" ? "direct" : "transfer");
      for (const verdict of data.verdicts) for (const match of verdict.matches) {
        if (mode === "missing") match.transfer = null;
        if (mode === "empty") match.transfer = { ...transfer, conditions: "" };
        if (mode === "deferred") { match.verdict = "deferred"; match.applicability = "undecided"; match.transfer = null; }
      }
      return data;
    }, AbortSignal.timeout(1000));
    assert.equal(result.grounding?.links.length, 0, mode);
    assert.notEqual(result.grounding?.status, "verified", mode);
  }
});

test("existing source-based sentences remain intact when only their citation is transferred", async () => {
  const original = { ...scene(), narration: proposal };
  const [result] = await verifySceneEvidence([original], [ref], async request => judge(request), AbortSignal.timeout(1000));
  assert.equal(result.narration, proposal);
  const accepted = acceptTransferredEvidence(result, evidenceKey(result.grounding!.links[0]));
  assert.equal(accepted.narration, proposal);
  assert.equal(accepted.grounding?.links[0].applicability, "transfer");
});

test("legacy positive decisions never acquire the new direct classification by default", () => {
  const legacy: EvidenceLink = { referenceId: ref.id, field: "narration", sentence: source, start: 0, end: source.length,
    quote, reason: "이전 판정", value: "corroboration" };
  assert.match(evidenceLabel(legacy), /미분류/);
  assert.doesNotMatch(evidenceLabel(legacy), /직접 근거|AI 대조 통과/);
});

test("full generation keeps transferred proposals out of the body within the existing two-call budget", async () => {
  const { runGeneration } = await import("./server/generation-service");
  let calls = 0;
  const input = { manuscript: source, settings: defaults, scene: scene() };
  const board = await runGeneration(input, { mode: "ai", model: "fixture", promptVersion: "test", generate: async (_, context) => {
    calls++;
    if (context.verification) return judge(context.verification);
    return { title: "지게차 교육", summary: "동선 확인", objectives: ["동선 구분"], scenes: [{ sceneNo: 1,
      title: input.scene.title, purpose: "동선 구분", visual: "지게차와 보행자 동선 표시", assets: "동선 표시",
      narration: source, subtitle: input.scene.subtitle, duration: 30, evidence: source, sourceId: "sentence:1-1",
      referenceIds: [], visualReferenceIds: [], supplements: [{ field: "narration", text: proposal, referenceId: "rag:1" }],
    }] };
  } }, { references: [ref] });
  assert.equal(calls, 2);
  assert.equal(board.scenes[0].narration, source);
  assert.equal(board.scenes[0].grounding?.suggestions?.[0].applicability, "transfer");
  assert.equal(board.scenes[0].references?.[0].id, ref.id);
});

test("PDF export retains pending/accepted classification, source scope and conditions", async () => {
  const { exportStoryboardPdf } = await import("./server/pdf-export");
  const { PDFParse } = await import("pdf-parse");
  const pending = await stagedResult();
  const accepted = acceptTransferredEvidence(pending, evidenceKey(pending.grounding!.suggestions![0]));
  const board = { ...boardFor(pending), scenes: [pending, { ...accepted, id: "accepted" }] };
  const parser = new PDFParse({ data: await exportStoryboardPdf({ board }) });
  try {
    const text = (await parser.getText()).text.replace(/\s+/g, " ");
    assert.match(text, /타 자료에서 활용 · 적용 검토 필요/);
    assert.match(text, /타 자료에서 활용 · 작업자 확인/);
    assert.match(text, /본문 미반영/);
    assert.match(text, /원래 적용 대상: 화물차 이동 작업/);
    assert.match(text, /확인할 조건: 지게차 동선/);
  } finally { await parser.destroy(); }
});
