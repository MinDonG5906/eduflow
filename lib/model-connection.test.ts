import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { GenerationError, generationTask } from "./generation-contract";
import { defaults, generateDemo, sample } from "./storyboard";
import { createAnthropicAdapter } from "./server/anthropic-adapter";
import { chatgptAccessToken, pkceChallenge, startChatGPTSignIn } from "./server/chatgpt-auth";
import { createChatGPTAdapter } from "./server/chatgpt-adapter";
import { createClaudeAgentAdapter, subscriptionEnv } from "./server/claude-agent-adapter";
import { createConnectionHandlers } from "./server/connection-handler";
import { readConnectionState, updateConnectionState } from "./server/connection-store";
import { adapterFor, anthropicConfig } from "./server/generator";
import { createGenerateHandler } from "./server/generate-handler";
import type { GenerationContext } from "./server/generation-service";
import { claudeJsonSchema } from "./server/provider-prompt";
import { protectSubscriptionGeneration, resetSubscriptionGuardForTests } from "./server/subscription-guard";

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
const generateRequest = () => new Request("http://127.0.0.1:3000/api/generate", {
  method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify(input),
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
  // Without the experiment flag the Claude subscription cannot be selected at all.
  assert.equal((await handlers.POST(post({ action: "select", provider: "claude-subscription" }))).status, 503);
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
  // Claude prices hold below 100k input tokens; raised personal caps stay at 16k/8k.
  const capped = anthropicConfig(state, { EDUFLOW_AI_MAX_INPUT_TOKENS: "110000", EDUFLOW_AI_MAX_OUTPUT_TOKENS: "12000" });
  assert.equal(capped.maxInputTokens, 16000);
  assert.equal(capped.maxOutputTokens, 8000);
  assert.equal(adapterFor({ ...state, anthropicModel: "claude-haiku-5-5" }, {}).model, "claude-haiku-5-5");
  assert.throws(() => adapterFor({ ...state, provider: "chatgpt" }, {}), coded("AI_SIGN_IN_REQUIRED"));
  assert.throws(() => adapterFor({ ...state, provider: "claude-subscription", claudeSubscriptionAcknowledged: true }, {}), coded("AI_NOT_CONFIGURED"));
  assert.equal(adapterFor({ ...state, provider: "claude-subscription", claudeSubscriptionAcknowledged: true },
    { EDUFLOW_EXPERIMENTAL_CLAUDE_SUBSCRIPTION: "true" }).billing?.kind, "subscription");
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

async function chatgptFixture(t: { after: (cleanup: () => void) => void }) {
  const directory = temporary(t);
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const idToken = (claims: Record<string, unknown>, audience: string) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://auth.openai.com").setAudience(audience).setSubject("chatgpt-user").setIssuedAt().setExpirationTime("10m").sign(privateKey);
  return { directory, jwks, idToken };
}

test("ChatGPT sign-in uses PKCE on the 127.0.0.1 loopback and stores the plan grant only after ID-token checks", async (t) => {
  const { directory, jwks, idToken } = await chatgptFixture(t);
  const tokenBodies: URLSearchParams[] = [];
  let scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  let nonce = "";
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    tokenBodies.push(body);
    return json({ access_token: "fake-access", refresh_token: "fake-refresh", id_token: await idToken({ nonce, email: "user@example.com" }, "oaiapp_test"),
      token_type: "Bearer", expires_in: 3600, scope });
  };
  const handlers = createConnectionHandlers({ directory, env: {}, chatgpt: { fetch, jwks } });
  assert.throws(() => startChatGPTSignIn(new Request("http://localhost:3000/api/connection", { headers: { host: "localhost:3000" } }), { directory }),
    coded("AI_ACCESS_DENIED"));
  const started = await (await handlers.POST(post({ action: "chatgptStart" }))).json();
  const authorize = new URL(started.url);
  assert.equal(authorize.origin + authorize.pathname, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(authorize.searchParams.get("agent_name_hint"), "EduFlow");
  assert.equal(authorize.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/auth/callback");
  assert.equal(authorize.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.ok(authorize.searchParams.get("scope")!.split(" ").includes("chatgpt.tokens.use.direct"));
  assert.match(authorize.searchParams.get("ext_agent_host_id")!, /^urn:uuid:/);
  const pending = readConnectionState(directory, {}).chatgptPending!;
  assert.equal(authorize.searchParams.get("code_challenge"), pkceChallenge(pending.verifier));
  nonce = authorize.searchParams.get("nonce")!;
  const callback = (params: Record<string, string>) => handlers.callback(new Request(
    `http://127.0.0.1:3000/auth/callback?${new URLSearchParams(params)}`, { headers: { host: "127.0.0.1:3000" } }));

  const forged = await callback({ code: "c", state: "x".repeat(43), client_id: "oaiapp_test" });
  assert.equal(forged.headers.get("location"), "http://127.0.0.1:3000/?chatgpt=invalid");
  assert.equal(tokenBodies.length, 0);
  const done = await callback({ code: "auth-code", state: authorize.searchParams.get("state")!, client_id: "oaiapp_test" });
  assert.equal(done.headers.get("location"), "http://127.0.0.1:3000/?chatgpt=connected");
  assert.equal(tokenBodies[0].get("code_verifier"), pending.verifier);
  assert.equal(tokenBodies[0].get("client_id"), "oaiapp_test");
  assert.equal(tokenBodies[0].get("redirect_uri"), "http://127.0.0.1:3000/auth/callback");
  const state = readConnectionState(directory, {});
  assert.equal(state.provider, "chatgpt");
  assert.equal(state.chatgptClientId, "oaiapp_test");
  assert.equal(state.chatgptPending, undefined);
  const status = await (await handlers.GET(new Request("http://127.0.0.1:3000/api/connection"))).text();
  assert.ok(!status.includes("fake-access") && !status.includes("fake-refresh") && status.includes("user@example.com"));
  // The state is single use: replaying the same callback cannot sign in again.
  assert.equal((await callback({ code: "auth-code", state: authorize.searchParams.get("state")!, client_id: "oaiapp_test" })).headers.get("location"),
    "http://127.0.0.1:3000/?chatgpt=invalid");

  // A returning sign-in reuses the issued client; a wrong nonce or missing plan scope never enables plan usage.
  const again = new URL((await (await handlers.POST(post({ action: "chatgptStart" }))).json()).url);
  assert.equal(again.searchParams.get("client_id"), "oaiapp_test");
  assert.equal(again.searchParams.get("agent_name_hint"), null);
  nonce = "wrong-nonce-value";
  assert.equal((await callback({ code: "c2", state: again.searchParams.get("state")! })).headers.get("location"), "http://127.0.0.1:3000/?chatgpt=invalid");
  const third = new URL((await (await handlers.POST(post({ action: "chatgptStart" }))).json()).url);
  nonce = third.searchParams.get("nonce")!;
  scope = "openid profile email offline_access";
  assert.equal((await callback({ code: "c3", state: third.searchParams.get("state")! })).headers.get("location"), "http://127.0.0.1:3000/?chatgpt=no-plan");
  assert.throws(() => adapterFor(readConnectionState(directory, {}), {}), coded("AI_SIGN_IN_REQUIRED"));
});

test("ChatGPT tokens refresh once near expiry and an unusable refresh token signs the account out", async (t) => {
  const directory = temporary(t);
  const now = Date.parse("2026-10-27T10:00:00Z");
  updateConnectionState((s) => ({ ...s, provider: "chatgpt", chatgptClientId: "oaiapp_test", chatgpt: {
    issuer: "https://auth.openai.com", subject: "chatgpt-user", clientId: "oaiapp_test", idToken: "id", accessToken: "old-access",
    refreshToken: "old-refresh", expiresAt: now + 30_000, scopes: ["chatgpt.tokens.use.direct", "offline_access"], savedAt: new Date(now).toISOString(),
  } }), directory, {});
  let calls = 0;
  let reply = () => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
  const fetch = async (_: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
    return reply();
  };
  const [a, b] = await Promise.all([chatgptAccessToken({ directory, fetch, now: () => now }), chatgptAccessToken({ directory, fetch, now: () => now })]);
  assert.equal(a, "new-access"); assert.equal(b, "new-access"); assert.equal(calls, 1);
  const saved = readConnectionState(directory, {}).chatgpt!;
  assert.equal(saved.refreshToken, "new-refresh");
  assert.deepEqual(saved.scopes, ["chatgpt.tokens.use.direct", "offline_access"]);
  updateConnectionState((s) => ({ ...s, chatgpt: { ...s.chatgpt!, expiresAt: now } }), directory, {});
  reply = () => json({ error: "server_error" }, 503);
  await assert.rejects(chatgptAccessToken({ directory, fetch, now: () => now }), coded("PROVIDER_UNAVAILABLE"));
  assert.ok(readConnectionState(directory, {}).chatgpt);
  reply = () => json({ error: "refresh_token_reused" }, 400);
  await assert.rejects(chatgptAccessToken({ directory, fetch, now: () => now }), coded("AI_SIGN_IN_REQUIRED"));
  assert.equal(readConnectionState(directory, {}).chatgpt, undefined);
  assert.equal(readConnectionState(directory, {}).chatgptClientId, "oaiapp_test");
});

test("ChatGPT plan requests stream without storage or unsupported fields and report plan limits", async (t) => {
  const directory = temporary(t);
  updateConnectionState((s) => ({ ...s, provider: "chatgpt", chatgpt: {
    issuer: "https://auth.openai.com", subject: "u", clientId: "oaiapp_test", idToken: "id", accessToken: "plan-access",
    refreshToken: "r", expiresAt: Date.now() + 3_600_000, scopes: ["chatgpt.tokens.use.direct"], savedAt: new Date().toISOString(),
  } }), directory, {});
  const bodies: Record<string, any>[] = [];
  let reply = () => sse([
    { data: { type: "response.output_text.delta", delta: JSON.stringify(output()), item_id: "m", output_index: 0, content_index: 0, sequence_number: 1 } },
    { data: { type: "response.completed", sequence_number: 2, response: { id: "r", object: "response", status: "completed", output: [] } } },
  ]);
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer plan-access");
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    bodies.push(JSON.parse(String(init?.body)));
    return reply();
  };
  const adapter = createChatGPTAdapter({ model: "gpt-test", auth: { directory }, fetch });
  assert.equal(JSON.parse(await adapter.generate(input, context()) as string).title, output().title);
  const body = bodies[0];
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.model, "gpt-test");
  for (const field of ["max_output_tokens", "temperature", "metadata", "user", "previous_response_id", "service_tier"]) assert.ok(!(field in body), field);
  assert.ok(!JSON.stringify(body.input).includes('"system"'));
  reply = () => json({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit", type: "usage" } }, 429);
  await assert.rejects(adapter.generate(input, context()), coded("SUBSCRIPTION_LIMITED"));
  reply = () => json({ detail: "not admitted" }, 401);
  await assert.rejects(adapter.generate(input, context()), coded("AI_SIGN_IN_REQUIRED"));
});

test("Claude subscription experiment gets no tools, settings or API keys and refuses a key-billed session", async () => {
  let options: Record<string, any> = {};
  let firstMessage: SDKUserMessage | undefined;
  let messages: Partial<SDKMessage>[] = [];
  const query = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, any> }) => (async function* () {
    options = params.options;
    for await (const message of params.prompt) { firstMessage = message; break; }
    for (const message of messages) yield message as SDKMessage;
  })();
  const adapter = createClaudeAgentAdapter({ query, env: {
    PATH: "/usr/bin", HOME: "/home/test", ANTHROPIC_API_KEY: "sk-ant-should-not-pass", EDUFLOW_AI_API_KEY: "sk-should-not-pass",
    CLAUDE_CODE_USE_BEDROCK: "1",
  } });
  messages = [
    { type: "system", subtype: "init", apiKeySource: "none" } as Partial<SDKMessage>,
    { type: "result", subtype: "success", is_error: false, result: "", structured_output: output() } as Partial<SDKMessage>,
  ];
  assert.equal(JSON.parse(await adapter.generate(input, context()) as string).title, output().title);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "PATH"]);
  assert.equal(options.outputFormat.type, "json_schema");
  assert.ok(Array.isArray(firstMessage?.message.content));
  assert.deepEqual(subscriptionEnv({ ANTHROPIC_AUTH_TOKEN: "x", PATH: "/bin" }), { PATH: "/bin" });
  messages = [{ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" } as Partial<SDKMessage>];
  await assert.rejects(adapter.generate(input, context()), coded("AI_NOT_CONFIGURED"));
  messages = [{ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Not logged in · Please run /login" } as Partial<SDKMessage>];
  await assert.rejects(adapter.generate(input, context()), coded("AI_SIGN_IN_REQUIRED"));
  messages = [{ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "limit" } as Partial<SDKMessage>];
  await assert.rejects(adapter.generate(input, context()), coded("SUBSCRIPTION_LIMITED"));
});

test("plan logins skip the dollar ledger but keep local-only access, one run at a time and an hourly count", async () => {
  resetSubscriptionGuardForTests();
  const adapter = { mode: "ai" as const, model: "plan-test", promptVersion: "v", billing: { kind: "subscription" as const },
    generate: async () => JSON.stringify(output()) };
  const first = protectSubscriptionGeneration(generateRequest(), adapter, { limits: { maxConcurrent: 1, requestsPerHour: 2 } });
  assert.throws(() => protectSubscriptionGeneration(generateRequest(), adapter, { limits: { maxConcurrent: 1, requestsPerHour: 2 } }), coded("RATE_LIMITED"));
  first.finish();
  protectSubscriptionGeneration(generateRequest(), adapter, { limits: { maxConcurrent: 1, requestsPerHour: 2 } }).finish();
  assert.throws(() => protectSubscriptionGeneration(generateRequest(), adapter, { limits: { maxConcurrent: 1, requestsPerHour: 2 } }), coded("RATE_LIMITED"));
  resetSubscriptionGuardForTests();
  assert.throws(() => protectSubscriptionGeneration(new Request("http://127.0.0.1:3000/api/generate", {
    method: "POST", headers: { origin: "http://evil.test", "content-type": "application/json" }, body: "{}" }), adapter), coded("AI_ACCESS_DENIED"));
  const response = await createGenerateHandler(adapter)(generateRequest());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).generation.model, "plan-test");
  resetSubscriptionGuardForTests();
});
