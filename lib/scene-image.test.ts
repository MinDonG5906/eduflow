import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { PDFParse } from "pdf-parse";
import { defaults, generateDemo, sample, type Scene } from "./storyboard";
import { editScene, moveScene, replaceScene } from "./board-edit";
import { defaultImageSettings, sceneImageBasis, sceneImageInput, sceneImageResultSchema } from "./scene-image";
import { createSceneImageHandlers, SCENE_IMAGE_MODEL, sceneImageConfig } from "./server/scene-image";
import { createConnectionHandlers } from "./server/connection-handler";
import { readConnectionState, updateConnectionState } from "./server/connection-store";
import { exportStoryboardPdf } from "./server/pdf-export";
import { readDraft, serializeDraft } from "./studio-state";
import { promptTask } from "./server/provider-prompt";
import { OPENAI_SCENE_IMAGE_MODEL } from "./server/openai-scene-image";

const KEY = "fake-gemini-image-key-for-tests-only";
const env = { EDUFLOW_GEMINI_API_KEY: KEY, EDUFLOW_AI_REQUESTS_PER_HOUR: "100" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const scene = () => generateDemo(sample, defaults).scenes[0];
const input = () => sceneImageInput(scene(), defaults, { style: "illustration", direction: "파란 작업복과 흰 안전모" }, "작업자를 가까이 보여주세요");
function temporary(t: TestContext, enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-scene-images-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (enabled) updateConnectionState(state => ({ ...state, imageEnabled: true }), directory, env);
  return directory;
}
function post(body: unknown, options: { origin?: string; signal?: AbortSignal } = {}) {
  return new Request("http://127.0.0.1:3000/api/scene-image", { method: "POST", signal: options.signal,
    headers: { origin: options.origin ?? "http://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
}
function png() {
  const canvas = createCanvas(32, 18); canvas.getContext("2d").fillRect(0, 0, 32, 18);
  return canvas.toBuffer("image/png");
}
function generated(parts = [{ inlineData: { mimeType: "image/png", data: png().toString("base64") } }], finishReason = "STOP") {
  return json({ candidates: [{ finishReason, content: { role: "model", parts } }] });
}
function usage(directory: string) {
  const db = new DatabaseSync(join(directory, "ai-budget.sqlite"));
  try { return { amounts: db.prepare("SELECT amount FROM budgets").all().map(row => Number(row.amount)),
    active: Number(db.prepare("SELECT count(*) AS n FROM reservations WHERE active=1").get()!.n) }; }
  finally { db.close(); }
}

test("image generation is separately opt-in, cannot switch text providers, and never exposes the team key", async t => {
  const directory = temporary(t, false);
  const connections = createConnectionHandlers({ directory, env });
  const handler = createSceneImageHandlers({ directory, env });
  assert.equal((await (await handler.GET(post({}))).json()).available, false);
  assert.equal((await connections.POST(post({ action: "setImageEnabled", enabled: true }))).status, 400);
  assert.equal((await connections.POST(post({ action: "setImageEnabled", enabled: true, consent: true }))).status, 200);
  assert.equal(readConnectionState(directory, env).provider, "demo");
  const status = await handler.GET(post({}));
  const text = await status.text();
  assert.ok(!text.includes(KEY));
  const publicStatus = JSON.parse(text);
  assert.equal(publicStatus.available, true);
  assert.equal(publicStatus.model, SCENE_IMAGE_MODEL);
  const config = sceneImageConfig(directory, env);
  assert.equal(config.reservationCost / 1_000_000, publicStatus.reservationUSD);
  assert.equal(config.attemptCost / 1_000_000, publicStatus.perImageCeilingUSD);
  assert.equal(config.dayBudget, 5_000_000); assert.equal(config.monthBudget, 10_000_000);
  assert.equal((await connections.POST(post({ action: "setImageEnabled", enabled: false, consent: true }))).status, 200);
  assert.equal((await (await handler.GET(post({}))).json()).available, false);
});

test("source evidence and RAG excerpts reach identical counted/generated inputs with bounded image output and one paid call", async t => {
  const directory = temporary(t);
  const body = input();
  body.scene.references = [{ id: "knowledge:testing", title: "보호구 안내", excerpt: "안전모를 점검합니다.", page: 3 }];
  const calls: { url: string; body: any }[] = [];
  const handler = createSceneImageHandlers({ directory, env, fetch: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return String(url).includes(":countTokens") ? json({ totalTokens: 100 }) : generated();
  } });
  const response = await handler.POST(post(body));
  assert.equal(response.status, 200, await response.clone().text());
  const result = sceneImageResultSchema.parse(await response.json());
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.contents, calls[1].body.contents);
  assert.match(result.prompt, /안전모를 점검합니다/);
  assert.ok(result.prompt.includes(body.scene.evidence));
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.match(calls[1].url, new RegExp(`models/${SCENE_IMAGE_MODEL}:generateContent`));
  assert.equal(calls[1].body.generationConfig.candidateCount, 1);
  assert.equal(calls[1].body.generationConfig.maxOutputTokens, 4096);
  assert.deepEqual(calls[1].body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "1K" });
  assert.ok(!calls[1].body.tools);
  assert.equal(result.basedOn, createHash("sha256").update(sceneImageBasis(body)).digest("hex"));
  assert.ok(Buffer.from(result.data, "base64").subarray(0, 8).equals(png().subarray(0, 8)));
  const ledger = usage(directory);
  assert.equal(ledger.active, 0);
  assert.deepEqual(ledger.amounts, [sceneImageConfig(directory, env).attemptCost, sceneImageConfig(directory, env).attemptCost]);
});

test("regeneration includes only the selected reference image and ignores intermediate thinking images", async t => {
  const directory = temporary(t);
  const bodies: any[] = [];
  const handler = createSceneImageHandlers({ directory, env, fetch: async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return String(url).includes(":countTokens") ? json({ totalTokens: 200 }) : generated([
      { thought: true, inlineData: { mimeType: "image/png", data: png().toString("base64") } },
      { inlineData: { mimeType: "image/png", data: png().toString("base64") } },
    ] as any);
  } });
  const form = new FormData(); form.set("input", JSON.stringify(input()));
  form.set("reference", new Blob([new Uint8Array(png())], { type: "image/png" }), "reference.png");
  const result = await handler.POST(new Request("http://127.0.0.1:3000/api/scene-image", { method: "POST", headers: { origin: "http://127.0.0.1:3000" }, body: form }));
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(bodies[1].contents[0].parts.length, 2);
  assert.equal(bodies[1].contents[0].parts[1].inlineData.mimeType, "image/png");
  assert.deepEqual(bodies[0].contents, bodies[1].contents);
});

test("cross-origin, missing evidence and oversized requests are rejected before provider work", async t => {
  let calls = 0;
  const handler = createSceneImageHandlers({ directory: temporary(t), env, fetch: async () => { calls++; return generated(); } });
  assert.equal((await handler.POST(post(input(), { origin: "https://example.com" }))).status, 403);
  assert.equal((await handler.POST(post({ ...input(), scene: { ...input().scene, evidence: "" } }))).status, 400);
  assert.equal((await handler.POST(post({ huge: "a".repeat(9_000_000) }))).status, 413);
  assert.equal(calls, 0);
});

test("token overflow and cancellation during counting cannot start a paid image call and refund unused reservations", async t => {
  for (const cancel of [false, true]) {
    const directory = temporary(t);
    const controller = new AbortController(); let paid = 0;
    const handler = createSceneImageHandlers({ directory, env, fetch: async url => {
      if (!String(url).includes(":countTokens")) { paid++; return generated(); }
      if (cancel) controller.abort();
      return json({ totalTokens: 9000 });
    } });
    const response = await handler.POST(post(input(), { signal: controller.signal }));
    assert.equal(response.status, cancel ? 499 : 413);
    assert.equal(paid, 0);
    assert.deepEqual(usage(directory), { amounts: [0, 0], active: 0 });
  }
});

test("provider errors, refusals and corrupt output do not retry or expose private provider messages", async t => {
  for (const [answer, status] of [
    [() => json({ error: { code: 429, message: `private ${KEY}` } }, 429), 429],
    [() => generated([], "SAFETY"), 422],
    [() => generated([], "MAX_TOKENS"), 502],
    [() => generated([{ inlineData: { mimeType: "image/png", data: "bm90LWFuLWltYWdl" } }]), 502],
    [() => generated([{ inlineData: { mimeType: "image/svg+xml", data: "PHN2Zy8+" } }]), 502],
  ] as const) {
    const directory = temporary(t); let paid = 0;
    const handler = createSceneImageHandlers({ directory, env, fetch: async url => {
      if (String(url).includes(":countTokens")) return json({ totalTokens: 100 });
      paid++; return answer();
    } });
    const response = await handler.POST(post(input()));
    assert.equal(response.status, status, await response.clone().text());
    assert.ok(!(await response.text()).includes(KEY));
    assert.equal(paid, 1);
    assert.equal(usage(directory).active, 0);
    assert.ok(usage(directory).amounts.every(amount => amount === sceneImageConfig(directory, env).attemptCost));
  }
});

test("concurrent image requests and exhausted shared budgets cannot bypass admission", async t => {
  const directory = temporary(t);
  let release!: () => void, counted!: () => void;
  const reachedCount = new Promise<void>(resolve => { counted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let paid = 0;
  const handler = createSceneImageHandlers({ directory, env, fetch: async url => {
    if (String(url).includes(":countTokens")) { counted(); await gate; return json({ totalTokens: 100 }); }
    paid++; return generated();
  } });
  const first = handler.POST(post(input())); await reachedCount;
  const second = await handler.POST(post(input()));
  assert.equal(second.status, 429); assert.equal(paid, 0);
  release(); assert.equal((await first).status, 200); assert.equal(paid, 1);
  const exhausted = createSceneImageHandlers({ directory, env: { ...env, EDUFLOW_AI_DAY_BUDGET_USD: "0.30" }, fetch: async () => { throw new Error("must not call"); } });
  assert.equal((await exhausted.POST(post(input()))).status, 429);
});

test("generated provenance, common style and source evidence survive draft recovery, reordering and PDF export", async t => {
  const board = generateDemo(sample, defaults);
  board.scenes[0].review = false;
  const generated: Scene["image"] = { id: "generated-test", sourceType: "generated", sourceText: "교육 장면", mimeType: "image/png",
    generated: { model: SCENE_IMAGE_MODEL, prompt: "원문 근거에 기반한 스토리보드", createdAt: new Date().toISOString() } };
  const edited = editScene(board, 0, "image", generated);
  assert.equal(edited.scenes[0].review, true);
  edited.imageSettings = { ...defaultImageSettings, direction: "흰 안전모와 파란 작업복" };
  const restored = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board: edited })).board!;
  assert.deepEqual(restored.imageSettings, edited.imageSettings);
  assert.deepEqual(restored.scenes[0].image, generated);
  const { image, ...newText } = restored.scenes[0];
  const revised = replaceScene(restored, newText.id, { ...newText, visual: "변경한 화면 설명" });
  assert.deepEqual(revised.scenes[0].image, generated, "text regeneration preserves the saved image for comparison");
  const textPrompt = promptTask({ supplementalSources: [], selectedScene: restored.scenes[0] });
  assert.ok(!JSON.stringify(textPrompt).includes("원문 근거에 기반한 스토리보드"), "old image prompts do not bloat new text generation");
  const moved = moveScene(restored, 0, 1)!;
  assert.equal(moved.scenes[1].image?.id, generated.id);
  assert.equal(moved.scenes[1].evidence, board.scenes[0].evidence);
  const bytes = await exportStoryboardPdf({ board: moved, sceneImages: new Map([[board.scenes[0].id, png()]]) });
  const parser = new PDFParse({ data: bytes });
  try { assert.match((await parser.getText()).text.replace(/\s/g, ""), /출처:AI생성·/); }
  finally { await parser.destroy(); }
});

test("personal lower token limits remain in force for image calls", t => {
  const directory = temporary(t);
  const config = sceneImageConfig(directory, { ...env, EDUFLOW_AI_MAX_INPUT_TOKENS: "2000", EDUFLOW_AI_MAX_OUTPUT_TOKENS: "2048" });
  assert.equal(config.maxInputTokens, 2000);
  assert.equal(config.maxOutputTokens, 2048);
  assert.ok(config.attemptCost < sceneImageConfig(directory, env).attemptCost);
});

test("scene image and visual recommendation siblings never share the same React key", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "-e", `
    global.React = require('react');
    const { SceneEditor } = require('./components/studio/scene-editor.tsx');
    const { generateDemo, sample, defaults } = require('./lib/storyboard.ts');
    const scene = generateDemo(sample, defaults).scenes[0];
    const element = SceneEditor({scene,index:0,sceneCount:3,manuscript:sample,sourceFile:null,settings:defaults,
      imageSettings:{style:'sketch',direction:''},onImageSettingsChange:()=>{},onOpenConnection:()=>{},
      onChange:()=>{},onMove:()=>{},onDelete:()=>{},onRegenerate:()=>{},canRegenerate:true});
    const keys = element.props.children.filter(child => React.isValidElement(child) && child.key !== null).map(child => child.key);
    console.log(JSON.stringify(keys));
  `], { cwd: process.cwd(), encoding: "utf8" });
  const keys: string[] = JSON.parse(output);
  assert.equal(new Set(keys).size, keys.length, "one scene ID cannot key both image and recommendation panels");
});

test("an existing OpenAI connection enables images without a Gemini key and sends one bounded generation", async t => {
  const directory = temporary(t, false);
  const openaiEnv = { EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-openai-image-key", EDUFLOW_AI_REQUESTS_PER_HOUR: "100" };
  const connections = createConnectionHandlers({ directory, env: openaiEnv });
  const calls: { url: string; body: any }[] = [];
  const handler = createSceneImageHandlers({ directory, env: openaiEnv, fetch: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return json({ created: 1, data: [{ b64_json: png().toString("base64") }] });
  } });
  const before = await (await handler.GET(post({}))).json();
  assert.equal(before.available, false); assert.equal(before.vendor, "OpenAI");
  assert.equal((await connections.POST(post({ action: "setImageEnabled", enabled: true, consent: true }))).status, 200);
  const status = await (await handler.GET(post({}))).json();
  assert.equal(status.available, true); assert.equal(status.vendor, "OpenAI");
  assert.equal(status.model, OPENAI_SCENE_IMAGE_MODEL);
  const response = await handler.POST(post(input()));
  assert.equal(response.status, 200, await response.clone().text());
  const result = sceneImageResultSchema.parse(await response.json());
  assert.equal(result.model, OPENAI_SCENE_IMAGE_MODEL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(calls[0].body.n, 1); assert.equal(calls[0].body.quality, "low");
  assert.equal(calls[0].body.size, "1536x864");
  assert.ok(calls[0].body.prompt.includes(input().scene.evidence));
  assert.ok(!JSON.stringify(result).includes(openaiEnv.EDUFLOW_AI_API_KEY));
  assert.equal(usage(directory).active, 0);
});

test("OpenAI reference edits send a thumbnail and account/model failures do not retry", async t => {
  const directory = temporary(t);
  const openaiEnv = { EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-openai-image-key", EDUFLOW_AI_REQUESTS_PER_HOUR: "100" };
  let calls = 0, fail = false;
  const handler = createSceneImageHandlers({ directory, env: openaiEnv, fetch: async (url, init) => {
    // The SDK probes multipart support using a local data URL; it is not an API call.
    if (String(url).startsWith("data:")) return new Response("");
    calls++;
    assert.equal(String(url), "https://api.openai.com/v1/images/edits");
    if (fail) return json({ error: { message: "private provider details", type: "permission_error", code: "model_not_found" } }, 403);
    const form = await new Request(String(url), init).formData();
    assert.equal(form.get("model"), OPENAI_SCENE_IMAGE_MODEL);
    assert.equal(form.get("quality"), "low");
    const file = form.get("image");
    assert.ok(file instanceof Blob); assert.equal(file.type, "image/png");
    return json({ created: 1, data: [{ b64_json: png().toString("base64") }] });
  } });
  function request() {
    const form = new FormData(); form.set("input", JSON.stringify(input()));
    form.set("reference", new Blob([new Uint8Array(png())], { type: "image/png" }), "reference.png");
    return new Request("http://127.0.0.1:3000/api/scene-image", { method: "POST", headers: { origin: "http://127.0.0.1:3000" }, body: form });
  }
  const response = await handler.POST(request());
  assert.equal(response.status, 200, await response.clone().text());
  fail = true;
  const failed = await handler.POST(request());
  assert.equal(failed.status, 503);
  const error = await failed.json();
  assert.equal(error.code, "IMAGE_MODEL_UNAVAILABLE");
  assert.ok(!JSON.stringify(error).includes("private provider details"));
  assert.equal(calls, 2);
});
