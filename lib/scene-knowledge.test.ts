import assert from "node:assert/strict";
import test from "node:test";
import { defaults, newScene, boardSchema } from "./storyboard";
import type { RetrievedReference } from "./knowledge";
import { searchSceneKnowledge } from "./server/scene-knowledge";
import { runGeneration, type GenerationAdapter } from "./server/generation-service";
import { verifySceneEvidence } from "./server/generation-grounding";
import { rankCandidates, teachingIntent } from "./grounding";
import type { searchHybridKnowledge } from "./server/knowledge-hybrid-search";

const response = "사고 직후 작업을 중지합니다. 전원을 차단합니다. 응급조치를 실시합니다.";
const prevention = "중량물 사고 예방을 위해 작업 전 작업계획서를 작성하고 작업 순서를 점검합니다.";
const ref = (excerpt: string): RetrievedReference => ({ id: crypto.randomUUID(), documentId: crypto.randomUUID(),
  title: "안전 자료", origin: "internal", url: "", published: "", revision: "", excerpt });
const makeScene = (text = response) => ({ ...newScene(), title: "대응 순서", narration: text, subtitle: text, evidence: text });

test("short captions retain accident phase from the quoted source and Korean action conjugations", () => {
  const caption = "전원을 차단합니다.";
  const bad = ref("작업 전 전원을 차단합니다.");
  assert.deepEqual(rankCandidates(caption, [bad], 2, "사고 발견 즉시 기계의 전원을 차단합니다."), []);
  assert.ok(teachingIntent("사고 즉시 작업을 멈춥니다.").actions.includes("stop"));
  assert.ok(teachingIntent("재해 사실을 먼저 알립니다.").actions.includes("report"));
  const contextual = { ...ref(caption), context: { documentTitle: "안전", sectionTitle: "작업 전 점검", tableHeaders: [] } };
  assert.deepEqual(rankCandidates(caption, [contextual], 2, "사고 직후 전원 차단"), []);
});

test("known special conditions cannot become generic machine-accident evidence even with matching actions", async () => {
  const heat = ref("온열질환 증상을 판단하기 어려운 경우에는 즉시 119에 신고 후 응급조치를 수행합니다.");
  const claim = "119에 신고하고 응급조치를 실시합니다.";
  const machineScene = { ...makeScene(claim), evidence: "끼임·절단 기계사고 발생 시 사고를 신고하고 응급조치를 시행한다." };
  let calls = 0;
  const [result] = await verifySceneEvidence([machineScene], [heat], async () => { calls++; return { verdicts: [] }; }, new AbortController().signal);
  assert.equal(calls, 0); assert.equal(result.grounding?.status, "no_match");
  assert.equal(rankCandidates(claim, [heat], 2, "온열질환 증상이 나타난 작업자에게 조치한다.").length, 1);
  assert.deepEqual(rankCandidates(claim, [heat]), [], "unspecified conditions are not permission to generalize a conditional rule");
});

test("finished scenes search separately and rerank beyond the old six-result pool", async () => {
  const good = ref(response), bad = ref(prevention), other = ref("밀폐공간 작업 전 환기설비를 점검합니다.");
  const queries: string[] = [];
  const search: typeof searchHybridKnowledge = async (query, topic, directory, signal, client, limit) => {
    queries.push(query);
    assert.equal(topic, ""); assert.equal(limit, 24);
    return query.includes("밀폐공간") ? [other] : [...Array.from({ length: 10 }, () => ref(prevention)), good, bad];
  };
  const results = await searchSceneKnowledge([makeScene(), makeScene(other.excerpt)], new AbortController().signal, search);
  assert.equal(queries.length, 2);
  assert.deepEqual(results.map(result => result.references.map(source => source.id)), [[good.id], [other.id]]);
  assert.ok(!queries[0].includes("밀폐공간"));
});

test("identical scene queries share retrieval; one hung search cannot erase completed results", async () => {
  const good = ref(response); let calls = 0;
  const scenes = [makeScene(), makeScene(), makeScene("다른 작업의 환기설비를 점검합니다.")];
  const results = await searchSceneKnowledge(scenes, new AbortController().signal, async query => {
    calls++;
    if (!query.includes("사고 직후")) return new Promise(() => {});
    return [good];
  }, 20);
  assert.equal(calls, 2);
  assert.deepEqual(results.map(result => result.status), ["retrieved", "retrieved", "unavailable"]);
  assert.equal(results[0].references[0].id, good.id);
});

test("scene search cancellation aborts instead of returning a source-only success", async () => {
  const controller = new AbortController();
  const pending = searchSceneKnowledge([makeScene()], controller.signal, async () => {
    controller.abort(); return [];
  });
  await assert.rejects(pending);
});

test("verification cannot borrow another scene's candidates or hide a failed retrieval", async () => {
  const good = ref(response);
  const results = await verifySceneEvidence([makeScene(), makeScene()], [good], async request => {
    assert.deepEqual(request.pairs.map(pair => pair.sceneIndex), [0]);
    return { verdicts: [] };
  }, new AbortController().signal, [
    { references: [good], status: "retrieved" }, { references: [], status: "unavailable" },
  ]);
  assert.equal(results[1].grounding?.status, "unavailable");
  assert.deepEqual(results[1].references, []);
});

test("generation retrieves after the draft and preserves more than six scene sources in saved boards", async () => {
  const count = 8;
  const sources = Array.from({ length: count }, () => ref(response));
  let generated = false, searched = false, calls = 0;
  const adapter: GenerationAdapter = { mode: "ai", model: "mock", promptVersion: "test", generate: async (_, context) => {
    calls++;
    if (context.verification) {
      assert.ok(generated && searched);
      return { verdicts: context.verification.pairs.map(pair => ({ pairId: pair.id,

        matches: pair.claims.filter(claim => claim.field === "narration").map(claim => ({ claimId: claim.id,
          verdict: "supported", quote: pair.reference.excerpt, reason: "동일한 대응 행동을 설명합니다.", value: "corroboration", applicability: "direct", transfer: null })),
      })) };
    }
    assert.deepEqual(context.task.supplementalSources, []);
    assert.equal(searched, false);
    generated = true;
    return { title: "사고 대응", summary: "대응 절차 교육", objectives: ["대응 절차 확인"],
      scenes: Array.from({ length: count }, (_, i) => ({ sceneNo: i + 1, title: `대응 ${i + 1}`, purpose: "대응 순서",
        visual: "현장 화면", assets: "대응 절차", narration: response, subtitle: "작업을 중지합니다.\n전원을 차단합니다.",
        evidence: response, sourceId: "sentence:1-3", duration: 23, referenceIds: [], visualReferenceIds: [] })) };
  } };
  const board = await runGeneration({ manuscript: response, settings: { ...defaults, count } }, adapter, {
    retrieveSceneKnowledge: async scenes => {
      assert.ok(generated); searched = true;
      return scenes.map((_, i) => ({ status: "retrieved", references: [sources[i]] }));
    },
  });
  assert.equal(calls, 2);
  assert.equal(board.generation?.knowledgeSources?.length, count);
  assert.equal(board.generation?.knowledge?.retrievedCount, count);
  board.scenes.forEach((scene, i) => assert.deepEqual(scene.references?.map(r => r.id), [sources[i].id]));
  assert.equal(boardSchema.safeParse(board).success, true);
});
