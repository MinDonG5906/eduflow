import { test } from "node:test";
import assert from "node:assert/strict";
import { csv, defaults, generateDemo, markdown, referenceInputSchema } from "./storyboard";
import { generationTask } from "./generation-contract";
import { retrieveReferences } from "./reference-retrieval";
import { runGeneration, type GenerationAdapter } from "./server/generation-service";
import { readDraft, serializeDraft } from "./studio-state";

const manuscript = `고소작업 안전 교육\n높은 곳에서 작업할 때 추락 위험을 먼저 확인합니다. 작업 계획을 세우고 작업발판과 난간의 상태를 확인합니다. 작업자는 현장의 위험성 평가를 바탕으로 보호구와 작업 방법을 점검합니다. 작업을 마친 뒤에는 작업 구역을 정리하고 안전 상태를 다시 확인합니다.`;

test("reconciliation selects relevant dated official evidence and excludes unrelated or unsupported claims", () => {
  const height = retrieveReferences(manuscript);
  assert.ok(height.some((source) => source.id === "official:fall-prevention"));
  assert.ok(height.every((source) => !source.id.includes("confined") && !source.id.includes("hot-work")));
  assert.equal(JSON.stringify(height).includes("머리 강도"), false);
  assert.deepEqual(retrieveReferences("탄소중립과 전기 사용을 설명합니다."), []);
});

test("user evidence is validated and relevant chunks are retrieved", () => {
  assert.equal(referenceInputSchema.safeParse({ title: "내부 기준", url: "javascript:alert(1)", text: "작업발판 점검 기준에 대한 내부 문서입니다." }).success, false);
  const source = { title: "현장 안전 기준", url: "https://example.org/safety", text: "고소작업을 하기 전에 작업발판과 안전난간의 상태를 확인합니다. 작업 계획을 세우고 위험요인을 기록합니다." };
  const found = retrieveReferences(manuscript, [source]);
  assert.ok(found.some((reference) => reference.id === "user:1:1" && reference.title === source.title));
});

test("storyboard keeps its three phases and resolves only retrieved source ids", async () => {
  const input = { manuscript, settings: { ...defaults, count: 3 as const } };
  const task = generationTask(input);
  assert.ok(task.supplementalSources.some((source) => source.id === "official:fall-controls"));
  assert.ok(JSON.stringify(task.responseSchema).includes("referenceIds"));
  const demo = generateDemo(manuscript, input.settings);
  const output = { title: demo.title, summary: demo.summary, objectives: demo.objectives,
    scenes: demo.scenes.map(({ id, review, reviewReason, edited, generation, references, ...scene }, index) => ({
      sceneNo: index + 1, ...scene,
      phase: (["intro", "body", "outro"] as const)[index],
      referenceIds: index === 1 ? ["official:fall-controls", "invented:source"] : [],
    })),
  };
  const adapter: GenerationAdapter = { mode: "ai", model: "test", promptVersion: "test-reference", generate: async () => output };
  const board = await runGeneration(input, adapter);
  assert.deepEqual(board.scenes.map((scene) => scene.phase), ["intro", "body", "outro"]);
  assert.deepEqual(board.scenes[1].references?.map((reference) => reference.id), ["official:fall-controls"]);
  assert.ok(board.generation?.warnings.some((warning) => warning.includes("확인되지 않은 보강 자료")));
  assert.ok(markdown(board).includes("### 보강 자료 근거"));
  assert.ok(csv(board).includes("official:fall-controls"));
  assert.deepEqual(readDraft(serializeDraft({ ...input, board, referenceSources: [{ title: "현장 기준", text: "고소작업에서 작업발판과 난간 상태를 먼저 확인합니다." }] }))?.board, board);
});
