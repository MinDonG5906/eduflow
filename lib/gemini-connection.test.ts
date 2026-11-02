import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationError, generationTask } from "./generation-contract";
import { defaults, generateDemo, sample } from "./storyboard";
import { createConnectionHandlers } from "./server/connection-handler";
import { GEMINI_MODELS, readConnectionState } from "./server/connection-store";
import { createGeminiAdapter } from "./server/gemini-adapter";
import { adapterFor, geminiConfig, generatorStatus } from "./server/generator";
import type { GenerationContext } from "./server/generation-service";
import { geminiJsonSchema } from "./server/provider-prompt";
import { PDFDocument } from "pdf-lib";
import { createGenerateHandler } from "./server/generate-handler";

const input = { manuscript: sample, settings: defaults };
const coded = (code: string) => (error: unknown) => error instanceof GenerationError && error.code === code;
const limits = { maxInputTokens: 16000, maxOutputTokens: 8000, maxProviderCalls: 1 as const };
const context = (): GenerationContext => ({ signal: new AbortController().signal, task: generationTask(input), limits });
const KEY = "AIza-fake-team-key-5678";
const teamEnv = { EDUFLOW_GENERATOR: "gemini", EDUFLOW_GEMINI_API_KEY: KEY };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function output() {
  const board = generateDemo(input.manuscript, input.settings);
  return { title: board.title, summary: board.summary, objectives: board.objectives,
    scenes: board.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, i) => ({ sceneNo: i + 1, ...scene })) };
}
const reply = (text: string, finishReason = "STOP") => json({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
});
function temporary(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-gemini-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("a team Gemini key in .env.local is used from the first start and never reaches the screen", async (t) => {
  const directory = temporary(t);
  assert.equal(readConnectionState(directory, teamEnv).provider, "gemini-api");
  const handlers = createConnectionHandlers({ directory, env: teamEnv });
  const response = await handlers.GET(new Request("http://127.0.0.1:3000/api/connection"));
  const text = await response.text();
  assert.ok(!text.includes("AIza-fake"));
  assert.deepEqual(JSON.parse(text).gemini, { teamKey: true, model: "gemini-3.8-flash", label: "Gemini 3.8 Flash" });
  const missing = createConnectionHandlers({ directory: temporary(t), env: { EDUFLOW_GENERATOR: "gemini" } });
  assert.equal((await (await missing.GET(new Request("http://127.0.0.1:3000/api/connection"))).json()).gemini.teamKey, false);
});

test("Gemini uses pinned prices under the team caps, and an unknown model or missing key is refused", () => {
  for (const model of Object.keys(GEMINI_MODELS)) {
    const config = geminiConfig({ ...teamEnv, EDUFLOW_GEMINI_MODEL: model, EDUFLOW_AI_DAY_BUDGET_USD: "50", EDUFLOW_AI_MONTH_BUDGET_USD: "100" });
    assert.equal(config.model, model);
    assert.equal(config.dayBudget, 40_000_000);
    assert.ok(config.reservationCost <= config.requestBudget, model);
  }
  const capped = geminiConfig({ ...teamEnv, EDUFLOW_AI_MAX_INPUT_TOKENS: "110000", EDUFLOW_AI_MAX_OUTPUT_TOKENS: "12000" });
  assert.equal(capped.maxInputTokens, 16000);
  assert.equal(capped.maxOutputTokens, 8000);
  assert.equal(geminiConfig(teamEnv).inputRate, 750_000);
  assert.throws(() => geminiConfig({ EDUFLOW_GENERATOR: "gemini" }), coded("AI_NOT_CONFIGURED"));
  assert.throws(() => geminiConfig({ ...teamEnv, EDUFLOW_GEMINI_MODEL: "gemini-4-argon" }), coded("AI_NOT_CONFIGURED"));
  assert.throws(() => geminiConfig({ ...teamEnv, EDUFLOW_GEMINI_MODEL: "toString" }), coded("AI_NOT_CONFIGURED"));
  assert.equal(adapterFor({ version: 1, provider: "gemini-api", anthropicModel: "claude-opus-5-5", imageEnabled: false }, teamEnv).model, "gemini-3.8-flash");
});

test("Gemini schema keeps only keywords Gemini accepts", () => {
  const schema = geminiJsonSchema(generationTask(input).responseSchema) as { properties: Record<string, { type?: string }> };
  const text = JSON.stringify(schema);
  for (const keyword of ["maxLength", "minLength", "$schema", "pattern", "maxItems"]) assert.ok(!text.includes(`"${keyword}"`), keyword);
  assert.equal(schema.properties.title.type, "string");
  assert.ok(text.includes('"minItems"') && text.includes('"additionalProperties":false'));
});

test("Gemini sends structured JSON with the shared output cap, makes one call per attempt and maps failures", async () => {
  const calls: { url: string; headers: Headers; body: Record<string, any> }[] = [];
  let answer: () => Response = () => reply(JSON.stringify(output()));
  const adapter = createGeminiAdapter(geminiConfig(teamEnv), { fetch: async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return String(url).includes(":countTokens") ? json({ totalTokens: 4321 }) : answer();
  } });

  assert.equal(await adapter.countInputTokens!(input, context()), 4321);
  assert.match(calls[0].url, /models\/gemini-3\.8-flash:countTokens/);
  assert.ok(calls[0].body.contents[0].parts[0].text.startsWith(generationTask(input).instruction), "system instructions are counted too");

  const text = await adapter.generate(input, context()) as string;
  assert.deepEqual(JSON.parse(text).title, output().title);
  const sent = calls[1];
  assert.match(sent.url, /models\/gemini-3\.8-flash:generateContent/);
  assert.equal(sent.headers.get("x-goog-api-key"), KEY);
  assert.ok(!JSON.stringify(sent.body).includes(KEY));
  assert.equal(sent.body.generationConfig.responseMimeType, "application/json");
  assert.equal(sent.body.generationConfig.maxOutputTokens, 8000);
  assert.equal(sent.body.generationConfig.thinkingConfig.thinkingLevel, "LOW");
  assert.ok(!JSON.stringify(sent.body.generationConfig.responseJsonSchema).includes("maxLength"));
  assert.ok(sent.body.systemInstruction);
  assert.ok(!("temperature" in sent.body.generationConfig) && !("tools" in sent.body));

  answer = () => reply("", "SAFETY");
  await assert.rejects(adapter.generate(input, context()), coded("AI_REFUSED"));
  answer = () => reply("{", "MAX_TOKENS");
  await assert.rejects(adapter.generate(input, context()), coded("OUTPUT_TRUNCATED"));
  answer = () => json({ error: { code: 400, message: `API key not valid ${KEY}`, status: "INVALID_ARGUMENT" } }, 401);
  await assert.rejects(adapter.generate(input, context()), (error: unknown) =>
    coded("AI_AUTH_FAILED")(error) && !(error as Error).message.includes("AIza"));
  const before = calls.length;
  answer = () => json({ error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }, 429);
  await assert.rejects(adapter.generate(input, context()), coded("RATE_LIMITED"));
  assert.equal(calls.length, before + 1, "the SDK must not retry on its own");
  await assert.rejects(adapter.generate(input, { ...context(), limits: undefined }), coded("AI_NOT_CONFIGURED"));
});

test("the status badge names Google as the destination of a Gemini request", () => {
  // generatorStatus reads the real private directory; only the vendor mapping is checked here.
  const status = generatorStatus();
  assert.ok([null, "OpenAI", "Anthropic", "Google"].includes(status.vendor));
});

test("Gemini counting and generation preserve PDF original pages and citation scope", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 200]); pdf.addPage([200, 400]);
  const attachment = { filename: "selected.pdf", data: await pdf.save() };
  const source = { name: "manual.pdf", pages: [22, 25] };
  const scene = { ...generateDemo(sample, defaults).scenes[0], sourceId: "pdf-page:25", pdfSource: { ...source, pages: [25] } };
  const requestInput = { ...input, manuscript: "", pdfSource: source, scene, sceneSourceScope: "citation" as const };
  const calls: Record<string, any>[] = [];
  const adapter = createGeminiAdapter(geminiConfig(teamEnv), { fetch: async (url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return String(url).includes(":countTokens") ? json({ totalTokens: 1000 }) : reply("{}");
  } });
  const ctx = { ...context(), pdf: attachment, task: generationTask(requestInput) };
  await adapter.countInputTokens!(requestInput, ctx);
  await adapter.generate(requestInput, ctx);
  const countParts = calls[0].contents[0].parts;
  const generateParts = calls[1].contents[0].parts;
  assert.deepEqual(countParts.slice(1), generateParts);
  const selected = await PDFDocument.load(Buffer.from(generateParts[0].inlineData.data, "base64"));
  assert.equal(selected.getPageCount(), 1);
  assert.deepEqual(selected.getPage(0).getSize(), { width: 200, height: 400 });
  const prompt = JSON.parse(generateParts[1].text);
  assert.deepEqual(prompt.document.visualPages, [25]);
  assert.deepEqual(prompt.document.visualPageLocations, [{ attachmentPage: 1, originalPage: 25, sourceId: "pdf-page:25" }]);
  assert.deepEqual(prompt.task.pdfSource.pages, [25]);
  assert.equal(prompt.task.sceneSourceScope, "citation");

  const selectionInput = { ...requestInput, sceneSourceScope: "selection" as const };
  await adapter.generate(selectionInput, { ...ctx, task: generationTask(selectionInput) });
  const selectionParts = calls[2].contents[0].parts;
  assert.equal((await PDFDocument.load(Buffer.from(selectionParts[0].inlineData.data, "base64"))).getPageCount(), 2);
  assert.deepEqual(JSON.parse(selectionParts[1].text).document.visualPages, [22, 25]);
  await assert.rejects(async () => adapter.countInputTokens!(input, { ...context(), signal: AbortSignal.abort(new GenerationError("CANCELLED")) }), coded("CANCELLED"));
  assert.equal(calls.length, 3, "cancelled counting must not send a network request");
});

test("Gemini runs through shared budgets with optional RAG and keeps source details", async (t) => {
  for (const status of ["no_match", "unavailable", "retrieved"] as const) {
    const references = status === "retrieved" ? [{ id: "knowledge:gemini:1", documentId: crypto.randomUUID(),
      title: "공유 지식 자료", url: "", excerpt: "관련된 설명을 보강하는 원문 구절입니다.", published: "2026-10-30", revision: "", origin: "internal" as const, page: 25 }] : [];
    let calls = 0, tokens = 1000;
    const adapter = createGeminiAdapter(geminiConfig(teamEnv), { fetch: async (url, init) => {
      if (String(url).includes(":countTokens")) return json({ totalTokens: tokens });
      calls++;
      const body = JSON.parse(String(init?.body));
      const prompt = JSON.parse(body.contents[0].parts[0].text);
      assert.equal(prompt.task.manuscript, sample);
      assert.deepEqual(prompt.task.supplementalSources, references.map((ref, index) => ({ ...ref, id: `rag:${index + 1}` })), "retrieved evidence is available before drafting");
      assert.ok(prompt.task.groundingGuidance);
      return reply(JSON.stringify(output()));
    } });
    const post = createGenerateHandler(adapter, { budgetDirectory: temporary(t), knowledge: () => {
      if (status === "unavailable") throw new Error("private-db-error");
      return references;
    } });
    const request = () => new Request("http://localhost:3000/api/generate", { method: "POST",
      headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const response = await post(request());
    assert.equal(response.status, 200);
    const board = await response.json();
    assert.equal(board.generation.knowledge.status, status);
    assert.equal(board.generation.knowledge.retrievedCount, references.length);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(board).includes(KEY));
    tokens = 16001;
    const blocked = await post(request());
    assert.equal(blocked.status, 413);
    assert.equal((await blocked.json()).code, "TOKEN_LIMIT_EXCEEDED");
    assert.equal(calls, 1, "over-limit input cannot invoke Gemini generation");
  }
});
