import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationError, generationTask } from "./generation-contract";
import { defaults, generateDemo, sample } from "./storyboard";
import { createAnthropicAdapter } from "./server/anthropic-adapter";
import { createConnectionHandlers } from "./server/connection-handler";
import { readConnectionState, updateConnectionState } from "./server/connection-store";
import { adapterFor, anthropicConfig } from "./server/generator";
import type { GenerationContext } from "./server/generation-service";
import { claudeJsonSchema } from "./server/provider-prompt";

const input = { manuscript: sample, settings: defaults };
const coded = (code: string) => (error: unknown) => error instanceof GenerationError && error.code === code;
const limits = { maxInputTokens: 16000, maxOutputTokens: 8000, maxProviderCalls: 1 as const };
const context = (): GenerationContext => ({ signal: new AbortController().signal, task: generationTask(input), limits });
function output() {
  const board = generateDemo(input.manuscript, input.settings);
  return { title: board.title, summary: board.summary, objectives: board.objectives,
    scenes: board.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, i) => ({ sceneNo: i + 1, ...scene })) };
}
function temporary(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-connection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const sse = (events: { event?: string; data: unknown }[]) => new Response(
  events.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);
const post = (body: unknown, origin = "http://127.0.0.1:3000") => new Request("http://127.0.0.1:3000/api/connection", {
  method: "POST", headers: { origin, host: "127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify(body),
});

test("saved keys need consent, stay in an owner-only file and never reach the status response", async (t) => {
  const directory = temporary(t);
  const handlers = createConnectionHandlers({ directory, env: {} });
  const status = async () => (await handlers.GET(new Request("http://127.0.0.1:3000/api/connection"))).json();
  assert.equal((await status()).provider, "demo");
  assert.equal((await handlers.POST(post({ action: "saveKey", vendor: "anthropic", key: "sk-ant-fake-test-key-1234" }))).status, 400);
  assert.equal((await handlers.POST(post({ action: "saveKey", vendor: "anthropic", key: "sk-ant-fake-test-key-1234", consent: true }, "http://evil.test"))).status, 403);
  const saved = await handlers.POST(post({ action: "saveKey", vendor: "anthropic", key: "sk-ant-fake-test-key-1234", consent: true }));
  const text = await saved.text();
  assert.equal(saved.status, 200);
  assert.ok(!text.includes("sk-ant-fake-test-key"));
  assert.equal(JSON.parse(text).provider, "anthropic-api");
  assert.equal(JSON.parse(text).anthropic.saved, "····1234");
  assert.equal(statSync(join(directory, "connection.json")).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(readConnectionState(directory, {}).anthropicKey, "sk-ant-fake-test-key-1234");
  assert.equal((await handlers.POST(post({ action: "select", provider: "claude-subscription" }))).status, 400);
  assert.equal((await handlers.POST(post({ action: "select", provider: "chatgpt" }))).status, 400);
  assert.equal((await (await handlers.POST(post({ action: "removeKey", vendor: "anthropic" }))).json()).provider, "demo");
  writeFileSync(join(directory, "connection.json"), "{broken");
  assert.throws(() => readConnectionState(directory, {}), coded("AI_NOT_CONFIGURED"));
  assert.equal((await handlers.GET(new Request("http://127.0.0.1:3000/api/connection"))).status, 503);
  assert.equal(readFileSync(join(directory, "connection.json"), "utf8"), "{broken");
});

test("old .env.local setups keep OpenAI, and saved Claude keys use pinned prices under the team caps", (t) => {
  const directory = temporary(t);
  assert.equal(readConnectionState(directory, { EDUFLOW_GENERATOR: "openai" }).provider, "openai-api");
  const state = updateConnectionState((s) => ({ ...s, provider: "anthropic-api", anthropicKey: "sk-ant-fake-test-key-1234" }), directory, {});
  const config = anthropicConfig(state, { EDUFLOW_AI_DAY_BUDGET_USD: "50", EDUFLOW_AI_MONTH_BUDGET_USD: "100" });
  assert.equal(config.model, "claude-opus-5-5");
  assert.equal(config.inputRate, 4_000_000);
  assert.equal(config.dayBudget, 5_000_000);
  assert.ok(config.reservationCost <= config.requestBudget);
  assert.equal(adapterFor({ ...state, anthropicModel: "claude-haiku-5-5" }, {}).model, "claude-haiku-5-5");
  const capped = anthropicConfig(state, { EDUFLOW_AI_MAX_INPUT_TOKENS: "110000", EDUFLOW_AI_MAX_OUTPUT_TOKENS: "12000" });
  assert.equal(capped.maxInputTokens, 16000);
  assert.equal(capped.maxOutputTokens, 8000);
});

test("Claude schema drops only unsupported keywords and keeps property names such as title", () => {
  const schema = claudeJsonSchema(generationTask(input).responseSchema) as { properties: Record<string, { type?: string }> };
  const text = JSON.stringify(schema);
  for (const keyword of ["maxLength", "minLength", "minimum", "maximum", "minItems", "maxItems", "$schema"]) assert.ok(!text.includes(`"${keyword}"`));
  assert.equal(schema.properties.title.type, "string");
  assert.ok(text.includes('"additionalProperties":false'));
});

function claudeStream(text: string, stopReason = "end_turn") {
  return sse([
    { event: "message_start", data: { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

test("Claude API sends structured JSON with the shared output cap and maps refusals, truncation and key errors", async (t) => {
  const directory = temporary(t);
  const state = updateConnectionState((s) => ({ ...s, provider: "anthropic-api", anthropicKey: "sk-ant-fake-test-key-1234" }), directory, {});
  const config = anthropicConfig(state, {});
  const calls: { url: string; headers: Headers; body: Record<string, any> }[] = [];
  let reply: () => Response = () => claudeStream(JSON.stringify(output()));
  const adapter = createAnthropicAdapter(config, { fetch: async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return String(url).includes("count_tokens") ? json({ input_tokens: 4321 }) : reply();
  } });
  assert.equal(await adapter.countInputTokens!(input, context()), 4321);
  const text = await adapter.generate(input, context()) as string;
  assert.deepEqual(JSON.parse(text).title, output().title);
  const sent = calls[1];
  assert.equal(sent.headers.get("authorization"), "Bearer sk-ant-fake-test-key-1234");
  assert.equal(sent.body.model, "claude-opus-5-5");
  assert.equal(sent.body.max_tokens, 8000);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.output_config.format.type, "json_schema");
  assert.ok(!JSON.stringify(sent.body.output_config.format.schema).includes("maxLength"));
  assert.equal(sent.body.messages[0].content.at(-1).type, "text");
  assert.ok(!("temperature" in sent.body) && !("tools" in sent.body));
  reply = () => claudeStream("", "refusal");
  await assert.rejects(adapter.generate(input, context()), coded("AI_REFUSED"));
  reply = () => claudeStream("{", "max_tokens");
  await assert.rejects(adapter.generate(input, context()), coded("OUTPUT_TRUNCATED"));
  reply = () => json({ type: "error", error: { type: "authentication_error", message: "secret detail sk-ant-fake" } }, 401);
  await assert.rejects(adapter.generate(input, context()), (error: unknown) =>
    coded("AI_AUTH_FAILED")(error) && !(error as Error).message.includes("sk-ant"));
  await assert.rejects(adapter.generate(input, { ...context(), limits: undefined }), coded("AI_NOT_CONFIGURED"));
});
