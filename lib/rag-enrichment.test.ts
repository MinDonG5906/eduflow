import assert from "node:assert/strict";
import test from "node:test";
import { defaults, newScene, boardSchema } from "./storyboard";
import { rankCandidates, evidenceConflict } from "./grounding";
import { generationTask } from "./generation-contract";
import { runGeneration, type GenerationAdapter } from "./server/generation-service";
import { verifySceneEvidence, verificationPrompt } from "./server/generation-grounding";
import { stageSupplements, commitSupplements } from "./server/generation-supplements";
import type { RetrievedReference } from "./knowledge";

const ref = (excerpt: string): RetrievedReference => ({ id: crypto.randomUUID(), documentId: crypto.randomUUID(),
  title: "밀폐공간 작업안전 교안", excerpt, origin: "official", url: "", published: "2022", revision: "" });
const source = "밀폐공간에 들어가기 전에 내부를 골고루 측정합니다.";
const scene = () => ({ ...newScene(), title: "밀폐공간 측정", narration: source, subtitle: "밀폐공간 내부를 측정합니다.",
  evidence: source, visual: "측정 장면", assets: "측정기" });
const explanation = "밀폐공간은 위치에 따라 공기농도에 차이가 있으므로 여러 장소에서 측정합니다.";

test("real prevention regression: relevant paragraph survives unrelated hazards elsewhere on the page", () => {
  const good = ref("유해가스 측정 시에는 면적 및 깊이를 고려하여 밀폐공간 내부를 골고루 측정한다.\n\n추락을 방지하고 공기호흡기를 착용한다.");
  const irrelevant = ref("차량계 건설기계를 사용하는 작업장소의 지형과 지반상태를 확인한다.");
  assert.equal(rankCandidates(source, [irrelevant, good], 1)[0]?.reference.id, good.id);
  // Do not strip a special condition off the actual supporting sentence.
  const conditional = ref("온열질환 발생 시 즉시 작업을 중지합니다.");
  assert.ok(evidenceConflict("즉시 작업을 중지합니다.", "즉시 작업을 중지합니다.", conditional, "기계사고 대응"));
});

test("timing, power isolation and polarity remain required while equivalent prevention wording is allowed", () => {
  const cases: [string, string, boolean][] = [
    ["밀폐공간 작업 전과 작업 중에는 환기합니다.", "밀폐공간 작업 전 내부를 최소 30분 이상 환기하였는가?", false],
    ["밀폐공간 작업 전과 작업 중에는 환기합니다.", "밀폐공간에서 작업을 시작하기 전과 작업 중에 환기하여야 한다.", true],
    ["불시동작을 예방하는 조치를 실시합니다.", "컨베이어가 작동하지 않도록 조치를 강구한다.", true],
    ["전원을 차단합니다.", "컨베이어의 운전을 정지시킨다.", false],
    ["작업을 중지합니다.", "운전을 정지합니다.", true],
    ["작업 중지", "운전 정지", true],
    ["전원을 차단하지 않습니다.", "전원을 차단합니다.", false],
    ["환기팬을 5분 가동합니다.", "환기팬을 3분 가동합니다.", false],
  ];
  for (const [claim, quote, allowed] of cases) assert.equal(evidenceConflict(claim, quote, ref(quote)) === null, allowed, claim);
  const chemical = "유해가스가 발생하는 화학물질 취급 시 환기합니다.";
  assert.equal(evidenceConflict("밀폐공간에서 환기합니다.", chemical, ref(chemical)), "scope");
});

test("judge schema has one decision per sentence and rejects conflicting additions independently", async () => {
  const reference = ref(explanation);
  const input = { ...scene(), narration: explanation, subtitle: explanation };
  const [result] = await verifySceneEvidence([input], [reference], async request => {
    const prompt = verificationPrompt(request);
    const task = JSON.parse(prompt.taskText);
    assert.equal(task.pairs[0].situation, undefined, "heuristic guesses must not bias the semantic judge");
    assert.equal(JSON.stringify(prompt.responseSchema).includes('"useful"'), false);
    return { verdicts: request.pairs.map(pair => ({ pairId: pair.id, matches: pair.claims.map(claim => ({
      claimId: claim.id, verdict: claim.field === "narration" ? "supported" : "conflict",
      quote: explanation, reason: "문장별 대조", value: "explanation", applicability: "direct", transfer: null,
    })) })) };
  }, new AbortController().signal);
  assert.equal(result.grounding?.status, "verified");
  assert.equal(result.grounding?.links.length, 1);
  assert.equal(result.grounding?.diagnostics?.conflicts, 1, "text-only evidence does not require visual or asset verdicts");
});

test("only verified proposed sentences are committed, with correct offsets after a rejected proposal", async () => {
  const original = scene(), reference = ref(explanation);
  const { staged, additions } = stageSupplements([original], [[
    { field: "narration", text: "밀폐공간은 한 장소만 측정합니다.", referenceId: reference.id },
    { field: "narration", text: explanation, referenceId: reference.id },
  ]], id => id === reference.id ? reference : undefined);
  const verified = await verifySceneEvidence(staged, [reference], async request => ({ verdicts: request.pairs.map(pair => ({
    pairId: pair.id, matches: pair.claims.map(claim => ({ claimId: claim.id,
      verdict: claim.sentence === explanation ? "supported" : "unsupported", quote: explanation,
      reason: "위치별 농도 차이가 측정 이유를 설명합니다.", value: "explanation", applicability: "direct", transfer: null })),
  })) }), new AbortController().signal);
  const [result] = commitSupplements([original], verified, additions);
  assert.equal(result.narration, `${source}\n${explanation}`);
  assert.equal(result.subtitle, original.subtitle);
  assert.equal(result.evidence, original.evidence);
  assert.equal(result.grounding?.diagnostics?.supplementsAdded, 1);
  assert.equal(result.grounding?.diagnostics?.supplementsRemoved, 1);
  for (const link of result.grounding!.links) assert.equal(result[link.field].slice(link.start, link.end), link.sentence);
});

test("generation sees RAG before writing; failed or skipped verification never publishes proposals", async () => {
  for (const outcome of ["verified", "failed", "repair"] as const) {
    const reference = ref(explanation);
    let calls = 0;
    const input = { manuscript: source, settings: defaults, scene: scene() };
    const adapter: GenerationAdapter = { mode: "ai", model: "mock", promptVersion: "test", generate: async (_, context) => {
      calls++;
      assert.equal(context.task.supplementalSources[0].id, reference.id);
      if (context.verification) {
        if (outcome === "failed") throw Error("provider failed");
        return { verdicts: context.verification.pairs.map(pair => ({ pairId: pair.id, matches: pair.claims.map(claim => ({
          claimId: claim.id, verdict: claim.sentence === explanation ? "supported" : "unsupported", quote: explanation,
          reason: "여러 위치를 측정하는 이유를 보충합니다.", value: "explanation", applicability: "direct", transfer: null,
        })) })) };
      }
      if (outcome === "repair" && calls === 1) return {};
      return { title: "밀폐공간", summary: source, objectives: ["측정 방법"], scenes: [{
        sceneNo: 1, title: input.scene.title, purpose: "측정 교육", narration: source, subtitle: input.scene.subtitle,
        visual: "측정 장면", assets: "측정기", duration: 30, evidence: source, sourceId: "sentence:1-1",
        referenceIds: [], visualReferenceIds: [], supplements: [{ field: "narration", text: explanation, referenceId: "rag:1" }],
      }] };
    } };
    const board = await runGeneration(input, adapter, { references: [reference] });
    assert.equal(calls, 2);
    assert.equal(board.scenes[0].narration, outcome === "verified" ? `${source}\n${explanation}` : source);
    assert.equal(boardSchema.safeParse(board).success, true);
    assert.equal("supplements" in board.scenes[0], false, "unverified proposals are never stored in the user draft");
  }
});

test("no sources means no supplement choices and old boards remain readable", () => {
  const task = generationTask({ manuscript: source, settings: defaults });
  const schema = task.responseSchema as any;
  assert.equal(schema.properties.scenes.items.properties.supplements.maxItems, 0);
  assert.equal(boardSchema.safeParse({ title: "기존", summary: "기존", objectives: ["기존 목표"], scenes: [scene()], settings: defaults, mode: "ai" }).success, true);
});
