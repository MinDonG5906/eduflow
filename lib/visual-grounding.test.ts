import assert from "node:assert/strict";
import test from "node:test";
import { captionFigureCandidates, makeKnowledgeStructure, tableRecommendationsForBlocks, type KnowledgeTable } from "./knowledge-structure";
import { newScene, defaults } from "./storyboard";
import { rankSceneVisuals } from "./scene-visual-candidates";
import { searchSceneKnowledge } from "./server/scene-knowledge";
import { verifySceneEvidence, verificationPrompt } from "./server/generation-grounding";
import { readDraft, serializeDraft } from "./studio-state";
import type { RetrievedReference } from "./knowledge";
import { runGeneration } from "./server/generation-service";

const narration = "밀폐공간 작업 전과 작업 중에는 환기합니다.";
const figureCaption = "밀폐공간 환기장치 모습";
const table: KnowledgeTable = { id: "t1", rows: 2, cols: 2, cells: [
  { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "구분" }, { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: "밀폐공간 급기 가이드" },
  { row: 2, col: 1, rowSpan: 1, colSpan: 1, text: "형태" }, { row: 2, col: 2, rowSpan: 1, colSpan: 1, text: "원통형" },
] };
function fixtures() {
  const documentId = crypto.randomUUID();
  const structure = makeKnowledgeStructure(54, 2, figureCaption, true, [table]);
  structure.analyzed = true;
  structure.figures = [{ id: "p54-f1", title: "환기장치 모습", bounds: [0.2, 0.2, 0.7, 0.7] }];
  const figure = captionFigureCandidates(documentId, structure)[0];
  const tab = tableRecommendationsForBlocks(documentId, structure, [structure.blocks.find(b => b.tableId)!.id])[0];
  const ref = (excerpt: string, visuals: RetrievedReference["visuals"] = []): RetrievedReference => ({
    id: `knowledge:${crypto.randomUUID()}`, documentId, title: "밀폐공간 교안", excerpt, visuals, page: 54,
    origin: "internal", url: "", published: "", revision: "",
  });
  const references = [ref(narration), ref(`${narration}\n${narration}`), ref(figure.quote, [figure]), ref(tab.quote, [tab])];
  const scene = { ...newScene(), title: "밀폐공간 환기", narration, subtitle: narration, evidence: narration,
    visual: "밀폐공간 환기장치 모습과 급기 가이드 표를 보여줍니다.", assets: "환기장치 그림과 급기 가이드 표" };
  return { structure, documentId, figure, tab, references, scene };
}

test("caption candidates use existing same-page blocks and crops without manufacturing verified links", () => {
  const { structure, documentId, figure } = fixtures();
  const before = JSON.stringify(structure);
  assert.equal(figure.association, "caption");
  assert.equal(figure.confidence, 0);
  assert.equal(figure.page, 54); assert.equal(figure.filePage, 2);
  assert.deepEqual(figure.bounds, structure.figures[0].bounds);
  assert.ok(structure.blocks.some(b => b.id === figure.blockId && b.text.includes(figure.quote)));
  assert.equal(captionFigureCandidates(documentId, structure).length, 1);
  assert.equal(JSON.stringify(structure), before);
  assert.deepEqual(structure.links, []);
  assert.deepEqual(captionFigureCandidates(documentId, { ...structure, searchable: false }), []);
  assert.deepEqual(captionFigureCandidates(documentId, { ...structure, analyzed: false }), []);
  assert.deepEqual(captionFigureCandidates(documentId, { ...structure, figures: [{ ...structure.figures[0], title: "없는 소화기 설명" }] }), []);
  for (const status of ["pending", "rejected"] as const) assert.deepEqual(captionFigureCandidates(documentId, { ...structure,
    links: [{ id: "decision", figureId: figure.figureId, blockId: figure.blockId, quote: figure.quote, reason: "검토 중",
      relationship: "uncertain", confidence: 0.5, status, model: "prior" }] }), []);
});

test("text shortlist cannot evict a relevant figure and table; different hazard remains excluded", async () => {
  const { scene, references } = fixtures();
  const [result] = await searchSceneKnowledge([scene], new AbortController().signal, async () => references);
  assert.deepEqual(result.references.map(ref => ref.id).sort(), references.slice(0, 2).map(ref => ref.id).sort());
  assert.deepEqual(result.visualReferences?.map(ref => ref.visuals![0].kind ?? "figure"), ["figure", "table"]);
  const heat = { ...references[2], excerpt: "온열질환 발생 시 냉방장치를 이용합니다.", visuals: [{ ...references[2].visuals![0],
    title: "온열질환 냉방장치", quote: "온열질환 발생 시 냉방장치를 이용합니다." }] };
  assert.deepEqual(rankSceneVisuals(scene, [heat]), []);
});

test("visual relevance is independent from narration and only approved assets survive save/recovery", async () => {
  const { scene, references, figure } = fixtures();
  const knowledge = await searchSceneKnowledge([scene], new AbortController().signal, async () => references);
  const [result] = await verifySceneEvidence([scene], references, async request => {
    assert.equal(request.pairs.filter(pair => pair.mode === "visual").length, 2);
    assert.equal(request.pairs.filter(pair => !pair.mode).length, 2);
    assert.match(verificationPrompt(request).instructions, /글의 사실 증명이 아니라/);
    return { verdicts: request.pairs.map(pair => ({ pairId: pair.id, matches: pair.visualId === figure.id ? pair.claims.map(claim => ({
      claimId: claim.id, verdict: "supported", quote: pair.reference.excerpt, reason: "환기 장비의 모습을 설명합니다.", value: "example", applicability: "direct", transfer: null,
    })) : [] })) };
  }, new AbortController().signal, knowledge);
  assert.equal(result.narration, narration);
  assert.deepEqual(result.references, [], "picture relevance is never a narration citation");
  assert.equal(result.visuals?.length, 1);
  assert.equal(result.visuals?.[0].id, figure.id);
  assert.ok(result.grounding?.links.every(link => link.value === "visual_reference" && link.visualId === figure.id));
  const board = { title: "환기", summary: "환기", objectives: ["환기"], mode: "ai" as const, settings: defaults, scenes: [result] };
  const restored = readDraft(serializeDraft({ manuscript: narration, settings: defaults, board })).board!;
  assert.deepEqual(restored.scenes[0].visuals, result.visuals);
  assert.deepEqual(restored.scenes[0].grounding, result.grounding);
});

test("missing or failed visual judgments do not publish candidate pictures", async () => {
  const { scene, references } = fixtures();
  for (const behavior of ["missing", "timeout"] as const) {
    const [result] = await verifySceneEvidence([scene], references, async request => {
      if (behavior === "timeout") throw new DOMException("deadline", "TimeoutError");
      return { verdicts: request.pairs.filter(pair => !pair.mode).map(pair => ({ pairId: pair.id, matches: [] })) };
    }, new AbortController().signal);
    assert.deepEqual(result.visuals, []);
    assert.equal(result.grounding?.status, "unavailable");
  }
});

test("generation retains separately retrieved caption figures and tables in two provider calls", async () => {
  const { scene, references } = fixtures(); let calls = 0;
  const board = await runGeneration({ manuscript: narration, settings: defaults, scene }, {
    mode: "ai", model: "mock", promptVersion: "test", generate: async (_, context) => {
      calls++;
      if (context.verification) return { verdicts: context.verification.pairs.map(pair => ({ pairId: pair.id,
        matches: pair.mode === "visual" ? pair.claims.map(claim => ({ claimId: claim.id, verdict: "supported",
          quote: pair.reference.excerpt, reason: "환기 장비와 급기 방법의 시각자료입니다.", value: "example", applicability: "direct", transfer: null })) : [],
      })) };
      return { title: scene.title, summary: "환기 교육", objectives: ["환기 방법"], scenes: [{ sceneNo: 1,
        title: scene.title, purpose: "환기 방법", visual: scene.visual, assets: scene.assets, narration, subtitle: scene.subtitle,
        duration: 30, evidence: narration, sourceId: "sentence:1-1", referenceIds: [], visualReferenceIds: [], supplements: [],
      }] };
    },
  }, { retrieveSceneKnowledge: (scenes, signal) => searchSceneKnowledge(scenes, signal, async () => references) });
  assert.equal(calls, 2);
  assert.equal(board.scenes[0].visuals?.length, 2);
  assert.equal(board.scenes[0].references?.length, 0);
  assert.ok(board.scenes[0].visuals?.some(visual => visual.association === "caption"));
  assert.ok(board.scenes[0].visuals?.some(visual => visual.kind === "table"));
});

test("20 scenes keep separate text and visual opportunities in one bounded judge call", async () => {
  const { scene, references } = fixtures(); let calls = 0;
  await verifySceneEvidence(Array.from({ length: 20 }, () => scene), references, async request => {
    calls++;
    assert.equal(request.pairs.length, 40);
    assert.equal(new Set(request.pairs.filter(pair => pair.mode === "visual").map(pair => pair.sceneIndex)).size, 20);
    assert.equal(new Set(request.pairs.filter(pair => !pair.mode).map(pair => pair.sceneIndex)).size, 20);
    assert.ok(request.pairs.filter(pair => pair.mode === "visual").every(pair => pair.claims.length === 1));
    const prompt = JSON.parse(verificationPrompt(request).taskText);
    assert.ok(prompt.references.length < request.pairs.length, "shared evidence is sent once rather than repeated per scene");
    for (const pair of prompt.pairs) {
      assert.ok(prompt.references.some((reference: { id: string }) => reference.id === pair.referenceId));
      assert.ok(prompt.scenes.some((scene: { id: string }) => scene.id === pair.sceneId));
    }
    return { verdicts: request.pairs.map(pair => ({ pairId: pair.id, matches: [] })) };
  }, new AbortController().signal);
  assert.equal(calls, 1);
});
