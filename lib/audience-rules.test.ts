import { test } from "node:test";
import assert from "node:assert/strict";
import { EASY_SENTENCE_MAX_CHARS, longSentenceScenes, narrationSentences, verbatimNarrationPercent } from "./audience-rules";
import { PROMPT_TEMPLATE, generationTask } from "./generation-contract";
import { runGeneration, type GenerationAdapter } from "./server/generation-service";
import { defaults, generateDemo, sample } from "./storyboard";

test("narration sentences are split on sentence ends and counted in letters", () => {
  assert.deepEqual(narrationSentences("발판을 확인하세요. 구멍은 덮으세요!\n표시를 붙이세요"), ["발판을확인하세요", "구멍은덮으세요", "표시를붙이세요"]);
  const long = "작업을 시작하기 전에 작업 발판과 사다리의 상태를 먼저 확인합니다.";
  assert.deepEqual(longSentenceScenes([{ narration: "짧게 씁니다." }, { narration: `짧습니다. ${long}` }]), [2]);
  assert.ok([...narrationSentences(long)[0]].length > EASY_SENTENCE_MAX_CHARS);
});

test("verbatim share counts only sentences of eight letters or more found in the manuscript", () => {
  const manuscript = "작업을 시작하기 전에 발판을 확인합니다. 안전대를 겁니다.";
  const scenes = [{ narration: "작업을 시작하기 전에 발판을 확인합니다. 안전대를 겁니다. 고리를 옮겨 거세요." }];
  // The second sentence is in the manuscript but too short to count as copying.
  assert.equal(verbatimNarrationPercent(scenes, manuscript), 33);
  assert.equal(verbatimNarrationPercent([], manuscript), 0);
});

test("each audience gets its own writing rules, visitor types add to the common visitor rule, and narration is always rewritten", () => {
  const task = (audience: typeof defaults.audience) => generationTask({ manuscript: sample, settings: { ...defaults, audience } });
  assert.match(task("외국인 근로자").audienceGuidance, /25자 이하/);
  const contractor = task("현장 방문자 · 외부 하청업체").audienceGuidance;
  assert.ok(contractor.startsWith(PROMPT_TEMPLATE.audienceGuidance.visitor) && contractor.includes("작업 전에 확인할 사항"));
  assert.notEqual(task("현장 방문자 · 일반인").audienceGuidance, contractor);
  assert.equal(task("산업현장 근무자").audienceGuidance, PROMPT_TEMPLATE.audienceGuidance.worker);
  const scene = { ...generateDemo(sample, defaults).scenes[0], id: crypto.randomUUID() };
  for (const instruction of [task("외국인 근로자").instruction, generationTask({ manuscript: sample, settings: defaults, scene }).instruction])
    assert.ok(instruction.includes(PROMPT_TEMPLATE.narrationRewrite));
});

test("foreign-worker narration with long sentences gets one review warning without another AI call", async () => {
  const run = async (audience: typeof defaults.audience) => {
    let calls = 0;
    const settings = { ...defaults, audience };
    const adapter: GenerationAdapter = { mode: "ai", model: "test", promptVersion: "test", generate: async (request) => {
      calls++;
      const board = generateDemo(request.manuscript, request.settings);
      return { title: board.title, summary: board.summary, objectives: board.objectives,
        scenes: board.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, index) => ({
          sceneNo: index + 1, ...scene,
          narration: index === 1 ? "작업을 시작하기 전에 작업 발판과 사다리의 상태를 먼저 확인합니다." : "발판을 확인하세요." })) };
    } };
    const board = await runGeneration({ manuscript: sample, settings }, adapter);
    return { calls, notes: board.generation?.warnings.filter((warning) => warning.includes("외국인 근로자용")) ?? [] };
  };
  const foreign = await run("외국인 근로자");
  assert.equal(foreign.calls, 1);
  assert.equal(foreign.notes.length, 1);
  assert.match(foreign.notes[0], /\(2번 장면\)/);
  assert.equal((await run("산업현장 근무자")).notes.length, 0);
});
