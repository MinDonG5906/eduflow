import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationError } from "./generation-contract";
import { applyLocalization, editLocalizedScene, editLocalizedTitle, localizationRequest, localizationResponseSchema, localizationState, localizationWarnings, masterHash, pendingScenes, translationBatches } from "./localization";
import { defaults, generateDemo, sample } from "./storyboard";
import { readDraft, serializeDraft } from "./studio-state";
import { readAIConfig } from "./server/ai-config";
import { createOpenAIAdapter, OPENAI_MODEL } from "./server/openai-adapter";
import { demoAdapter } from "./server/demo-adapter";
import type { GenerationAdapter } from "./server/generation-service";
import { localizationTask, runLocalization } from "./server/localization-service";
import { createLocalizeHandler } from "./server/localize-handler";
import { providerTask } from "./server/provider-prompt";

const board = generateDemo(sample, defaults);
const coded = (code: string) => (error: unknown) => error instanceof GenerationError && error.code === code;
const config = readAIConfig({
  EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-private-test-key", EDUFLOW_AI_MODEL: OPENAI_MODEL,
  EDUFLOW_AI_INPUT_USD_PER_MILLION: "0.75", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4.50",
  EDUFLOW_AI_REQUEST_BUDGET_USD: "0.10", EDUFLOW_AI_DAY_BUDGET_USD: "0.5", EDUFLOW_AI_MONTH_BUDGET_USD: "2",
});
// A plausible Vietnamese answer for the demo board: one translated scene per master scene.
function translation(request = localizationRequest(board, "vi")) {
  return { title: "Trung hòa carbon từ cuộc sống hằng ngày", scenes: request.scenes.map((scene, i) => ({
    sceneNo: i + 1, title: `Cảnh ${i + 1}`, narration: `Hãy cùng tìm hiểu nội dung chính của cảnh ${i + 1}.`,
    subtitle: scene.subtitle.split("\n").map(() => "Nội dung chính").join("\n"),
    backTranslation: { title: `장면 ${i + 1}`, narration: `${i + 1}번 장면의 핵심 내용을 함께 알아봅시다.`, subtitle: "핵심 내용" },
  })) };
}
const fakeAI = (generate: GenerationAdapter["generate"]): GenerationAdapter => ({ mode: "ai", model: "fake-model", promptVersion: "fake", generate });

test("master hash detects edits to viewer-facing text only", () => {
  const scene = board.scenes[0];
  assert.equal(masterHash(scene), masterHash({ ...scene }));
  assert.notEqual(masterHash(scene), masterHash({ ...scene, subtitle: `${scene.subtitle}!` }));
  const otherEvidence = { ...scene, evidence: "다른 근거" };
  assert.equal(masterHash(scene), masterHash(otherEvidence), "evidence stays Korean and is not translated");
});

test("translation task sends only title, narration and subtitle, numbered for the model", () => {
  const task = localizationTask(localizationRequest(board, "vi"));
  assert.ok(task.instruction.includes("Vietnamese"));
  assert.ok(task.instruction.includes("(안전모)"), "site terms keep the Korean word");
  assert.deepEqual(Object.keys(task.scenes[0]).sort(), ["narration", "sceneNo", "subtitle", "title"]);
  assert.deepEqual(task.scenes.map(scene => scene.sceneNo), board.scenes.map((_, i) => i + 1));
  assert.ok(localizationTask(localizationRequest(board, "ko-easy")).instruction.includes("쉬운 한국어"));
});

test("local checks flag wrong script, missing numbers and changed subtitle lines", () => {
  const master = { title: "추락 방지", narration: "높이 2m 이상에서는 안전대를 걸고, 3명이 함께 확인합니다.", subtitle: "안전대 착용\n2m 이상 작업" };
  const ok = { title: "Phòng chống ngã", narration: "Khi làm việc ở độ cao từ 2m trở lên, hãy móc dây an toàn (안전대). 3 người cùng kiểm tra.",
    subtitle: "Đeo dây an toàn (안전대)\nLàm việc từ 2m trở lên", backTranslation: { title: "추락 방지", narration: "2m 이상 높이에서 일할 때 안전대를 거세요. 3명이 함께 확인합니다.", subtitle: "안전대 착용" } };
  assert.deepEqual(localizationWarnings(master, ok, "vi"), [], "Korean glossary terms in parentheses are expected");
  const bad = { ...ok, narration: "Khi làm việc trên cao, hãy móc dây an toàn.", subtitle: "Đeo dây an toàn", backTranslation: { ...ok.backTranslation, narration: "" } };
  const warnings = localizationWarnings(master, bad, "vi");
  assert.ok(warnings.some(warning => warning.includes("숫자 2, 3")));
  assert.ok(warnings.some(warning => warning.includes("자막 줄 수")));
  assert.ok(warnings.some(warning => warning.includes("역번역")));
  assert.ok(localizationWarnings(master, ok, "km").some(warning => warning.includes("크메르어 문자가 적습니다")));
  const khmer = { ...ok, narration: "នៅកម្ពស់ ២m ឡើងទៅ ត្រូវពាក់ខ្សែក្រវាត់សុវត្ថិភាព (안전대)។ មនុស្ស ៣ នាក់ពិនិត្យជាមួយគ្នា។", subtitle: "ពាក់ខ្សែក្រវាត់សុវត្ថិភាព\nការងារនៅកម្ពស់ ២m" };
  assert.deepEqual(localizationWarnings(master, khmer, "km"), [], "Khmer digits count as the same numbers");
});

test("translations map back to scene ids and record the master they were made from", async () => {
  const request = localizationRequest(board, "vi");
  const result = await runLocalization(request, fakeAI(async (_, context) => {
    assert.ok("kind" in context.task && context.task.kind === "localization");
    return JSON.stringify(translation(request));
  }));
  assert.equal(result.model, "fake-model");
  assert.deepEqual(Object.keys(result.scenes), board.scenes.map(scene => scene.id));
  assert.equal(result.scenes[board.scenes[1].id].title, "Cảnh 2");
  assert.equal(result.scenes[board.scenes[1].id].basedOn, masterHash(board.scenes[1]));

  const localized = applyLocalization(board, "vi", result);
  assert.equal(localizationState(localized, "vi", localized.scenes[0]), "ready");
  assert.equal(localizationState(localized, "si", localized.scenes[0]), "missing");
  const edited = { ...localized, scenes: localized.scenes.map((scene, i) => i === 0 ? { ...scene, narration: `${scene.narration} 추가` } : scene) };
  assert.equal(localizationState(edited, "vi", edited.scenes[0]), "stale");
  assert.equal(localizationState(edited, "vi", edited.scenes[1]), "ready");
  const draft = { manuscript: sample, settings: defaults, board: localized };
  assert.deepEqual(readDraft(serializeDraft(draft)).board?.localizations, localized.localizations, "translations survive saving");
});

test("a later batch replaces only its own scenes", async () => {
  const first = await runLocalization(localizationRequest(board, "vi"), fakeAI(async () => translation()));
  const one = localizationRequest(board, "vi", [board.scenes[2].id]);
  const second = await runLocalization(one, fakeAI(async () => ({ title: "Tiêu đề mới", scenes: [{ ...translation(one).scenes[0], title: "Cảnh mới" }] })));
  const merged = applyLocalization(applyLocalization(board, "vi", first), "vi", second).localizations!.vi!;
  assert.equal(merged.title, "Trung hòa carbon từ cuộc sống hằng ngày", "the Korean title did not change, so its translation is kept");
  assert.equal(merged.scenes[board.scenes[2].id].title, "Cảnh mới");
  assert.equal(merged.scenes[board.scenes[0].id].title, "Cảnh 1");
});

test("incomplete or malformed answers fail without partial results; demo cannot translate", async () => {
  const request = localizationRequest(board, "vi");
  const missingScene = translation(request); missingScene.scenes.pop();
  await assert.rejects(runLocalization(request, fakeAI(async () => missingScene)), coded("INVALID_OUTPUT"));
  const duplicated = translation(request); duplicated.scenes[1].sceneNo = 1;
  await assert.rejects(runLocalization(request, fakeAI(async () => duplicated)), coded("INVALID_OUTPUT"));
  await assert.rejects(runLocalization(request, fakeAI(async () => "not json")), coded("INVALID_OUTPUT"));
  await assert.rejects(runLocalization(request, demoAdapter), coded("LOCALIZATION_AI_REQUIRED"));
});

test("OpenAI receives the translation task without generation-only instructions", async () => {
  const bodies: Record<string, any>[] = [];
  const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const adapter = createOpenAIAdapter(config, { fetch: async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return String(url).endsWith("/input_tokens") ? reply({ object: "response.input_tokens", input_tokens: 900 })
      : reply({ object: "response", id: "resp", status: "completed", output: [{ type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(translation()), annotations: [] }] }] });
  } });
  const result = await runLocalization(localizationRequest(board, "vi"), { ...adapter, generate: (input, context) => adapter.generate(input, { ...context, limits: { maxInputTokens: 16000, maxOutputTokens: 8000, maxProviderCalls: 1 } }) });
  assert.equal(Object.keys(result.scenes).length, board.scenes.length);
  assert.ok(bodies[0].instructions.includes("Vietnamese"));
  assert.ok(!bodies[0].instructions.includes("sourceRequest"));
  assert.equal(bodies[0].text.format.strict, true);
  assert.ok(!JSON.stringify(bodies[0].input).includes("supplementalSources\":[{"));
});

test("Claude and Gemini share the same translation prompt without generation-only instructions", () => {
  const prompt = providerTask({ signal: new AbortController().signal, task: localizationTask(localizationRequest(board, "km")) });
  assert.ok(prompt.instructions.includes("Khmer"));
  assert.ok(!prompt.instructions.includes("sourceRequest"));
  assert.equal(JSON.parse(prompt.taskText).task.scenes.length, board.scenes.length);
});

test("the localize route checks the request, locality and the shared budget", async t => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-localize-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const post = (body: unknown, adapter: GenerationAdapter, origin = "http://127.0.0.1:3000") => createLocalizeHandler(adapter, { budgetDirectory: directory })(
    new Request("http://127.0.0.1:3000/api/localize", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const paid: GenerationAdapter = { mode: "ai", model: OPENAI_MODEL, promptVersion: "fake", billing: { kind: "metered", config },
    countInputTokens: async () => 500, generate: async () => translation() };
  const response = await post(localizationRequest(board, "vi"), paid);
  assert.equal(response.status, 200);
  const parsed = localizationResponseSchema.parse(await response.json());
  assert.equal(parsed.language, "vi");
  assert.equal(Object.keys(parsed.localization.scenes).length, board.scenes.length);

  assert.equal((await post({ ...localizationRequest(board, "vi"), language: "fr" }, paid)).status, 400);
  assert.equal((await post({ ...localizationRequest(board, "vi"), scenes: [] }, paid)).status, 400);
  const demo = await post(localizationRequest(board, "vi"), demoAdapter);
  assert.equal(demo.status, 503); assert.equal((await demo.json()).code, "LOCALIZATION_AI_REQUIRED");
  const remote = await post(localizationRequest(board, "vi"), paid, "https://example.invalid");
  assert.equal(remote.status, 403);
  const tooMany = await post(localizationRequest(board, "vi"), { ...paid, countInputTokens: async () => 999999 });
  assert.equal((await tooMany.json()).code, "TOKEN_LIMIT_EXCEEDED");
});

test("pending scenes, batches and planner edits", async () => {
  const result = await runLocalization(localizationRequest(board, "vi"), fakeAI(async () => translation()));
  const localized = applyLocalization(board, "vi", result);
  assert.equal(pendingScenes(localized, "vi").length, 0);
  assert.equal(pendingScenes(localized, "km").length, board.scenes.length);

  const scene = localized.scenes[0];
  const edited = editLocalizedScene(localized, "vi", scene, { narration: "Không có số nào ở đây." });
  assert.equal(edited.localizations!.vi!.scenes[scene.id].narration, "Không có số nào ở đây.");
  assert.equal(localizationState(edited, "vi", scene), "ready", "a manual correction is not a stale translation");
  assert.deepEqual(editLocalizedScene(localized, "si", scene, { narration: "x" }), localized, "nothing to edit before translating");

  const removed = { ...localized, scenes: localized.scenes.slice(1) };
  assert.ok(!(scene.id in applyLocalization(removed, "vi", result).localizations!.vi!.scenes), "deleted scenes are dropped");

  const long = board.scenes.map(item => ({ ...item, narration: "가".repeat(700) }));
  const sinhala = translationBatches(long, "si"), vietnamese = translationBatches(long, "vi");
  assert.deepEqual(sinhala.flat(), long.map(item => item.id), "every scene once, in order");
  assert.ok(sinhala.length > vietnamese.length, "complex scripts use smaller requests");
  assert.ok(translationBatches(Array.from({ length: 25 }, (_, i) => ({ ...board.scenes[0], id: String(i), narration: "짧음" })), "vi").every(batch => batch.length <= 10));
});

test("review fixes: edited title survives re-translation unless the Korean title changed", async () => {
  const first = await runLocalization(localizationRequest(board, "vi"), fakeAI(async () => translation()));
  const edited = editLocalizedTitle(applyLocalization(board, "vi", first), "vi", "Tiêu đề do người lập kế hoạch sửa");
  const one = localizationRequest(edited, "vi", [board.scenes[0].id]);
  const again = await runLocalization(one, fakeAI(async () => ({ ...translation(one), title: "Tiêu đề mới của mô hình" })));
  assert.equal(applyLocalization(edited, "vi", again).localizations!.vi!.title, "Tiêu đề do người lập kế hoạch sửa");
  const retitled = { ...edited, title: "새 콘텐츠 제목" };
  const fresh = await runLocalization(localizationRequest(retitled, "vi"), fakeAI(async () => ({ ...translation(), title: "Tiêu đề mới" })));
  assert.equal(applyLocalization(retitled, "vi", fresh).localizations!.vi!.title, "Tiêu đề mới", "a changed Korean title brings a new translation");
});

test("review fixes: editing a translation clears its now-outdated back-translation", async () => {
  const localized = applyLocalization(board, "vi", await runLocalization(localizationRequest(board, "vi"), fakeAI(async () => translation())));
  const scene = localized.scenes[0];
  const edited = editLocalizedScene(localized, "vi", scene, { narration: "Câu đã sửa." }).localizations!.vi!.scenes[scene.id];
  assert.equal(edited.backTranslation.narration, "");
  assert.notEqual(edited.backTranslation.subtitle, "", "untouched fields keep theirs");
  assert.ok(edited.warnings.some(warning => warning.includes("역번역이 없는 부분")));
});

test("review fixes: empty master fields stay empty and missing text is rejected", async () => {
  const blank = { ...board, scenes: board.scenes.map((scene, i) => i === 0 ? { ...scene, narration: "", subtitle: "" } : scene) };
  const request = localizationRequest(blank, "vi");
  const answer = translation(request);
  answer.scenes[0] = { ...answer.scenes[0], narration: "", subtitle: "" };
  const result = await runLocalization(request, fakeAI(async () => answer));
  assert.equal(result.scenes[blank.scenes[0].id].narration, "");
  const invented = translation(request);
  assert.equal((await runLocalization(request, fakeAI(async () => invented))).scenes[blank.scenes[0].id].subtitle, "", "text the master lacks is dropped");
  const incomplete = translation(request); incomplete.scenes[1].narration = "";
  await assert.rejects(runLocalization(request, fakeAI(async () => incomplete)), coded("INVALID_OUTPUT"));
});

test("review fixes: a reply left in Korean is flagged; parenthesized Korean terms are not", () => {
  const master = { title: "안전모", narration: "현장에 들어가기 전에 안전모를 쓰세요.", subtitle: "안전모 착용" };
  const back = { title: "", narration: "안전모를 쓰세요.", subtitle: "안전모" };
  assert.ok(localizationWarnings(master, { ...master, backTranslation: back }, "vi").some(warning => warning.includes("베트남어 문자가 적습니다")));
  const translated = { title: "Mũ bảo hộ", narration: "Hãy đội mũ bảo hộ (안전모) trước khi vào công trường.", subtitle: "Đội mũ bảo hộ (안전모)", backTranslation: back };
  assert.ok(!localizationWarnings(master, translated, "vi").some(warning => warning.includes("문자가 적습니다")));
  assert.ok(!localizationWarnings(master, { ...translated, narration: "佩戴安全帽（안전모）。", subtitle: "佩戴安全帽（안전모）" }, "zh-Hans").some(warning => warning.includes("문자가 적습니다")), "full-width parentheses too");
});

