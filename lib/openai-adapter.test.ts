import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationError, generationTask } from "./generation-contract";
import { defaults, generateDemo, sample, markdown, csv } from "./storyboard";
import { readAIConfig } from "./server/ai-config";
import { createOpenAIAdapter, OPENAI_MODEL } from "./server/openai-adapter";
import { protectPaidGeneration } from "./server/ai-protection";
import { runGeneration, type GenerationContext } from "./server/generation-service";

const config = readAIConfig({
  EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-private-test-key", EDUFLOW_AI_MODEL: OPENAI_MODEL,
  EDUFLOW_AI_INPUT_USD_PER_MILLION: "0.75", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4.50",
  EDUFLOW_AI_REQUEST_BUDGET_USD: "0.10", EDUFLOW_AI_DAY_BUDGET_USD: "0.5", EDUFLOW_AI_MONTH_BUDGET_USD: "2",
});
const input = { manuscript: sample, settings: defaults };
const context = (): GenerationContext => ({ signal: new AbortController().signal, task: generationTask(input), limits: { maxInputTokens: 16000, maxOutputTokens: 8000, maxProviderCalls: 1 } });
const coded = (code: string) => (error: unknown) => error instanceof GenerationError && error.code === code;
function output(request = input) {
  const board = generateDemo(request.manuscript, request.settings);
  return { title: board.title, summary: board.summary, objectives: board.objectives,
    scenes: board.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, i) => ({ sceneNo: i + 1, ...scene })) };
}
function completed(value: unknown) {
  return { object: "response", id: "resp_test", status: "completed", output: [{ type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }] };
}
function reply(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }

test("OpenAI uses fixed standard model, strict JSON, bounded output, no storage/tools, and identical counted input", async () => {
  const calls: { url: string; body: Record<string, any> }[] = [];
  const adapter = createOpenAIAdapter(config, { fetch: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return String(url).endsWith("/input_tokens") ? reply({ object: "response.input_tokens", input_tokens: 1234 }) : reply(completed(output()));
  } });
  const ctx = context();
  assert.equal(await adapter.countInputTokens!(input, ctx), 1234);
  const board = await runGeneration(input, { ...adapter, generate: (_, context) => adapter.generate(input, { ...context, limits: ctx.limits }) });
  assert.equal(board.mode, "ai"); assert.equal(board.generation?.model, OPENAI_MODEL);
  const [count, generate] = calls;
  assert.equal(count.url, "https://api.openai.com/v1/responses/input_tokens");
  assert.equal(generate.url, "https://api.openai.com/v1/responses");
  for (const key of ["input", "instructions", "model", "reasoning", "text"]) assert.deepEqual(count.body[key], generate.body[key]);
  assert.equal(generate.body.max_output_tokens, 8000); assert.equal(generate.body.store, false);
  assert.equal(generate.body.text.format.strict, true); assert.equal(generate.body.reasoning.effort, "none");
  assert.equal(generate.body.service_tier, "default"); assert.deepEqual(generate.body.tools, []);
  assert.equal(JSON.stringify(generate.body).includes(config.apiKey), false);
  assert.equal(config.attemptCost, 48000); assert.equal(config.reservationCost, 96000);
});

test("wrong model or understated price cannot weaken OpenAI budget checks", () => {
  for (const override of [{ model: "other-model" }, { inputRate: 749999 }, { outputRate: 4499999 }])
    assert.throws(() => createOpenAIAdapter({ ...config, ...override }), coded("AI_NOT_CONFIGURED"));
});

test("document scope and industrial audience guidance reach the AI independently of difficulty", async () => {
  const scoped = { ...input, sourceRequest: "올려둔 PDF 파일에서 산업안전수칙 부분 제작하고싶어", settings: { ...defaults, audience: "외국인 근로자" as const, difficulty: "쉬움" as const } };
  let sent: Record<string, any> | undefined;
  const adapter = createOpenAIAdapter(config, { fetch: async (_, init) => {
    sent = JSON.parse(String(init?.body));
    return reply({ input_tokens: 1200 });
  } });
  await adapter.countInputTokens!(scoped, { ...context(), task: generationTask(scoped) });
  const task = JSON.parse(sent!.input).task;
  assert.equal(task.sourceRequest, scoped.sourceRequest);
  assert.equal(task.settings.audience, "외국인 근로자");
  assert.equal(task.settings.difficulty, "쉬움");
  assert.ok(task.audienceGuidance.includes("국적이나 숙련도를 추정하지"));
  assert.ok(sent!.instructions.includes("관련 없는 항목은 제외"));
});

test("SDK errors never auto retry or expose raw provider text", async () => {
  for (const [status, providerCode, expected] of [[401, "invalid_api_key", "AI_AUTH_FAILED"], [429, "insufficient_quota", "AI_AUTH_FAILED"], [429, "rate_limit", "RATE_LIMITED"], [500, "server_error", "PROVIDER_UNAVAILABLE"]] as const) {
    let calls = 0;
    const adapter = createOpenAIAdapter(config, { fetch: async () => { calls++; return reply({ error: { message: "SECRET RAW MANUSCRIPT " + config.apiKey, type: "test", code: providerCode } }, status); } });
    await assert.rejects(adapter.generate(input, context()), (error: unknown) => coded(expected)(error) && error instanceof Error && !error.message.includes("SECRET") && !error.message.includes(config.apiKey));
    assert.equal(calls, 1);
  }
});

test("quota error in provider type is a billing failure even with a different error code", async () => {
  let calls = 0;
  const adapter = createOpenAIAdapter(config, { fetch: async () => {
    calls++;
    return reply({ error: { message: "PRIVATE PROVIDER DIAGNOSTIC", type: "insufficient_quota", code: "billing_not_active" } }, 429);
  } });
  await assert.rejects(adapter.generate(input, context()), coded("AI_AUTH_FAILED"));
  assert.equal(calls, 1);
  assert.equal(new GenerationError("AI_AUTH_FAILED").retryable, false);
});

test("refusal and truncated responses stop without an automatic repair", async () => {
  for (const [response, expected] of [
    [{ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "PRIVATE TEXT" }] }] }, "AI_REFUSED"],
    [{ status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } }, "OUTPUT_TRUNCATED"],
  ] as const) {
    let calls = 0;
    const adapter = createOpenAIAdapter(config, { fetch: async () => { calls++; return reply(response); } });
    await assert.rejects(runGeneration(input, { ...adapter, generate: (_, ctx) => adapter.generate(input, { ...ctx, limits: context().limits }) }), coded(expected));
    assert.equal(calls, 1);
  }
});

test("real SDK pipeline counts both attempts, repairs once, and preserves original accepted scenes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-openai-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let generations = 0, counts = 0;
  const adapter = createOpenAIAdapter(config, { fetch: async (url, init) => {
    if (String(url).endsWith("/input_tokens")) { counts++; return reply({ input_tokens: 2000 }); }
    const candidate = output(); generations++;
    if (generations === 1) { candidate.scenes[0].title = "첫 번째 정상 장면"; candidate.scenes[1].narration = ""; }
    else {
      const sent = JSON.parse(JSON.parse(String(init?.body)).input);
      assert.equal(sent.repair.acceptedScenes[0].title, "첫 번째 정상 장면");
      candidate.scenes[0].title = "바뀐 제목";
    }
    return reply(completed(candidate));
  } });
  const request = new Request("http://127.0.0.1:3000/api/generate", { headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" } });
  const paid = protectPaidGeneration(request, adapter, { config, directory });
  try {
    const board = await runGeneration(input, paid.adapter);
    assert.equal(board.scenes[0].title, "첫 번째 정상 장면"); assert.equal(board.generation?.attempts, 2);
    assert.equal(generations, 2); assert.equal(counts, 2);
  } finally { paid.finish(); }
});

test("count failures/oversized input cannot start a generation", async (t) => {
  for (const tokens of [16001, null]) {
    const directory = mkdtempSync(join(tmpdir(), "eduflow-openai-count-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
    let generations = 0;
    const adapter = createOpenAIAdapter(config, { fetch: async (url) => {
      if (String(url).endsWith("/input_tokens")) return tokens === null ? reply({ error: { message: "private", type: "test" } }, 500) : reply({ input_tokens: tokens });
      generations++; return reply(completed(output()));
    } });
    const request = new Request("http://localhost/api/generate", { headers: { origin: "http://localhost", "content-type": "application/json" } });
    const paid = protectPaidGeneration(request, adapter, { config, directory });
    try { await assert.rejects(runGeneration(input, paid.adapter), coded(tokens === null ? "PROVIDER_UNAVAILABLE" : "TOKEN_LIMIT_EXCEEDED")); }
    finally { paid.finish(); }
    assert.equal(generations, 0);
  }
});

test("cancellation during asynchronous counting holds admission and cannot generate later", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-count-cancel-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let finishCount!: (tokens: number) => void, calls = 0;
  const adapter = { ...createOpenAIAdapter(config), countInputTokens: () => new Promise<number>((resolve) => { finishCount = resolve; }), generate: async () => { calls++; return output(); } };
  const request = new Request("http://localhost/api/generate", { headers: { origin: "http://localhost", "content-type": "application/json" } });
  const paid = protectPaidGeneration(request, adapter, { config, directory });
  try { await assert.rejects(runGeneration(input, paid.adapter, { timeoutMs: 10 }), coded("TIMEOUT")); } finally { paid.finish(); }
  assert.throws(() => protectPaidGeneration(request, adapter, { config, directory }), coded("RATE_LIMITED"));
  finishCount(100); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  const next = protectPaidGeneration(request, adapter, { config, directory }); next.finish();
});

test("mixed demo and AI scene exports identify the actual scene source", async () => {
  const adapter = createOpenAIAdapter(config, { fetch: async () => reply(completed(output())) });
  const ai = await runGeneration(input, { ...adapter, generate: (_, ctx) => adapter.generate(input, { ...ctx, limits: context().limits }) });
  const demo = generateDemo(sample, defaults);
  const mixed = { ...demo, scenes: [ai.scenes[0], demo.scenes[1]] };
  assert.ok(markdown(mixed).includes("AI·데모 장면 포함"));
  const rows = csv(mixed).split("\r\n");
  assert.ok(rows[1].includes('"AI 생성 초안"')); assert.ok(rows[2].includes('"원문 발췌 데모"'));
});
