import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, generateDemo, sample, newScene, markdown } from "./storyboard";
import { apiErrorSchema, GenerationError, MAX_OUTPUT_CHARS, parseGenerationResponse, type GenerationInput } from "./generation-contract";
import { runGeneration, type GenerationAdapter } from "./server/generation-service";
import { createGenerateHandler } from "./server/generate-handler";
import { readDraft, serializeDraft } from "./studio-state";
import { TERM_CORRECTION_NOTICE_PREFIX } from "./term-corrections";

const input: GenerationInput = { manuscript: sample, settings: defaults };
function output(request = input) {
  const board = generateDemo(request.manuscript, request.settings, request.scene, request.direction);
  return {
    title: board.title, summary: board.summary, objectives: board.objectives,
    scenes: board.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, index) => ({ sceneNo: index + 1, ...scene })),
  };
}
function adapter(generate: GenerationAdapter["generate"] = async (request) => output(request)): GenerationAdapter {
  return { mode: "demo", model: "test-demo", promptVersion: "test-v1", generate };
}
const hasCode = (code: GenerationError["code"]) => (error: unknown) => error instanceof GenerationError && error.code === code;
const request = (body: string, signal?: AbortSignal) => new Request("http://localhost/api/generate", {
  method: "POST", headers: { "Content-Type": "application/json" }, body, signal,
});

test("generation contract supports scene-count and manuscript boundaries with server-owned IDs and review flags", async () => {
  for (const manuscript of [sample, "가".repeat(100), "가".repeat(20000)]) {
    for (const count of [3, 6, 20] as const) {
      const req = { manuscript, settings: { ...defaults, count } };
      const board = await runGeneration(req, adapter());
      assert.equal(board.scenes.length, count);
      assert.equal(new Set(board.scenes.map((scene) => scene.id)).size, count);
      assert.ok(board.scenes.every((scene) => scene.review && !scene.edited.length));
      assert.equal(board.generation?.attempts, 1);
      assert.equal(board.generation?.warnings.length, 0);
    }
  }
});

test("partial repair preserves successful scenes even when repair reorders or damages other slots", async () => {
  let calls = 0;
  const board = await runGeneration(input, adapter(async (_, context) => {
    const candidate = output();
    if (++calls === 1) {
      candidate.scenes[1].narration = "";
      candidate.scenes[0].title = "첫 응답의 정상 장면";
    } else {
      assert.ok(context.repair?.issues.some((issue) => issue.path.endsWith("narration")));
      assert.equal(context.repair?.acceptedScenes.find((scene) => scene.sceneNo === 1)?.title, "첫 응답의 정상 장면");
      candidate.scenes[0].narration = "";
      candidate.scenes.reverse();
    }
    return candidate;
  }));
  assert.equal(calls, 2);
  assert.equal(board.scenes[0].title, "첫 응답의 정상 장면");
  assert.equal(board.scenes[1].narration, output().scenes[1].narration);
  assert.deepEqual(board.generation?.repairedScenes, [2]);
});

test("malformed, empty and oversized output gets only one repair and never exposes raw content", async () => {
  for (const candidate of ["{private-manuscript", {}, "가".repeat(MAX_OUTPUT_CHARS + 1)]) {
    let calls = 0;
    await assert.rejects(runGeneration(input, adapter(async () => { calls++; return candidate; })), hasCode("INVALID_OUTPUT"));
    assert.equal(calls, 2);
  }
});

test("duplicate scene numbers, missing scenes and forged application metadata are rejected", async () => {
  for (const change of [
    (candidate: ReturnType<typeof output>) => { candidate.scenes[1].sceneNo = 1; },
    (candidate: ReturnType<typeof output>) => { candidate.scenes.pop(); },
    (candidate: ReturnType<typeof output>) => { Object.assign(candidate.scenes[0], { id: "forged", review: false, edited: [] }); },
  ]) {
    let calls = 0;
    await assert.rejects(runGeneration(input, adapter(async () => {
      calls++; const candidate = output(); change(candidate); return candidate;
    })), hasCode("INVALID_OUTPUT"));
    assert.equal(calls, 2);
  }
});

test("unknown, empty and mismatched citations remain reviewable and get explicit warnings", async () => {
  const board = await runGeneration(input, adapter(async () => {
    const candidate = output();
    candidate.scenes[0].sourceId = "sentence:9999-9999";
    candidate.scenes[1].evidence = "원문에 없는 인용 내용";
    candidate.scenes[2].sourceId = "";
    candidate.scenes[2].evidence = "";
    return candidate;
  }));
  assert.equal(board.generation?.attempts, 1);
  assert.equal(board.generation?.warnings.length, 3);
  assert.ok(board.scenes.slice(0, 3).every((scene) => scene.review && scene.reviewReason.includes("원문")));
});

test("AI evidence drops inline locators only after preserving a verifiable original quote", async () => {
  const model = { ...adapter(async () => {
    const candidate = output();
    candidate.scenes[0].evidence += ` [${candidate.scenes[0].sourceId}]`;
    return candidate;
  }), mode: "ai" as const };
  const board = await runGeneration(input, model);
  assert.equal(board.scenes[0].evidence, output().scenes[0].evidence);
  assert.equal(board.generation?.warnings.length, 0);
});

test("AI can resolve a missing locator only for an exact contiguous manuscript quote", async () => {
  const sentences = output().scenes;
  const model = { ...adapter(async () => {
    const candidate = output();
    candidate.scenes[0].sourceId = "";
    candidate.scenes[0].evidence = `${sentences[0].evidence} / ${sentences[1].evidence}`;
    candidate.scenes[1].sourceId = "";
    candidate.scenes[1].evidence = "원문에 없는 내용";
    return candidate;
  }), mode: "ai" as const };
  const board = await runGeneration(input, model);
  assert.equal(board.scenes[0].sourceId, `sentence:1-${sentences[1].sourceId.split("-")[1]}`);
  assert.equal(board.scenes[0].evidence, `${sentences[0].evidence} ${sentences[1].evidence}`);
  assert.equal(board.scenes[1].sourceId, "");
  assert.ok(board.generation?.warnings.some((warning) => warning.startsWith("2번 장면")));
});

test("AI repairs a scene with stray Devanagari in Korean production copy", async () => {
  let calls = 0;
  const model = { ...adapter(async (_, context) => {
    const candidate = output();
    calls++;
    if (calls === 1) candidate.scenes[1].visual = "순서를 क्रम대로 보여줍니다.";
    else assert.ok(context.repair?.issues.some((issue) => issue.reason === "unexpected_script_in_korean_output"));
    return candidate;
  }), mode: "ai" as const };
  const board = await runGeneration(input, model);
  assert.equal(calls, 2);
  assert.deepEqual(board.generation?.repairedScenes, [2]);
  assert.ok(!board.scenes[1].visual.includes("क्रम"));
});

test("server deadline settles an uncooperative provider and signals cancellation without another call", async () => {
  let providerSignal: AbortSignal | undefined;
  let calls = 0;
  await assert.rejects(runGeneration(input, adapter(async (_, context) => {
    providerSignal = context.signal; calls++;
    return new Promise(() => {});
  }), { timeoutMs: 10 }), hasCode("TIMEOUT"));
  assert.equal(calls, 1);
  assert.equal(providerSignal?.aborted, true);
});

test("already cancelled and in-flight cancelled requests do not invoke repair", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  let calls = 0;
  const provider = adapter(async () => { calls++; return output(); });
  await assert.rejects(runGeneration(input, provider, { signal: cancelled.signal }), hasCode("CANCELLED"));
  assert.equal(calls, 0);
  const live = new AbortController();
  await assert.rejects(runGeneration(input, adapter(async (_, context) => {
    calls++; live.abort(); assert.equal(context.signal.aborted, true); return output();
  }), { signal: live.signal }), hasCode("CANCELLED"));
  assert.equal(calls, 1);
});

test("input JSON errors and oversized requests are rejected before provider work", async () => {
  let calls = 0;
  const post = createGenerateHandler(adapter(async () => { calls++; return output(); }));
  for (const [body, status, code] of [
    ["{", 400, "INVALID_REQUEST"],
    [JSON.stringify({ manuscript: "짧은 원고", settings: defaults }), 400, "INVALID_REQUEST"],
    [JSON.stringify({ ...input, scene: { ...generateDemo(sample, defaults).scenes[0], id: "not-a-uuid" } }), 400, "INVALID_REQUEST"],
    ["가".repeat(150001), 413, "REQUEST_TOO_LARGE"],
  ] as const) {
    const response = await post(request(body));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { code, error: new GenerationError(code).message, retryable: false });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(calls, 0);
});

test("HTTP failure contract distinguishes timeout, cancellation, limits and provider failure safely", async () => {
  const timeout = await createGenerateHandler(adapter(async () => new Promise(() => {})), { timeoutMs: 10 })(request(JSON.stringify(input)));
  assert.equal(timeout.status, 504);
  assert.equal((await timeout.json()).code, "TIMEOUT");
  const controller = new AbortController(); controller.abort();
  const cancel = await createGenerateHandler(adapter())(request(JSON.stringify(input), controller.signal));
  assert.equal(cancel.status, 499);
  assert.equal((await cancel.json()).retryable, false);
  const reading = new AbortController();
  const interruptedRequest = request(JSON.stringify(input), reading.signal);
  Object.defineProperty(interruptedRequest, "text", { value: async () => { reading.abort(); throw new Error("body interrupted"); } });
  const interrupted = await createGenerateHandler(adapter())(interruptedRequest);
  assert.equal(interrupted.status, 499);
  let calls = 0;
  const limited = await createGenerateHandler(adapter(async () => { calls++; throw new GenerationError("RATE_LIMITED"); }))(request(JSON.stringify(input)));
  assert.equal(limited.status, 429);
  assert.equal(calls, 1);
  const unavailable = await createGenerateHandler(adapter(async () => { throw new Error("fake-secret-and-private-text"); }))(request(JSON.stringify(input)));
  assert.equal(unavailable.status, 503);
  const safeError = await unavailable.text();
  assert.equal(JSON.parse(safeError).code, "PROVIDER_UNAVAILABLE");
  assert.ok(!safeError.includes("fake-secret-and-private-text"));
  const invalid = await createGenerateHandler(adapter(async () => null))(request(JSON.stringify(input)));
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).retryable, true);
});

test("real knowledge-backed generation stops before paid admission when no related passage exists", async () => {
  let calls = 0;
  const ai = { ...adapter(async () => { calls++; return output(); }), mode: "ai" as const };
  const post = createGenerateHandler(ai, { knowledge: () => [] });
  const response = await post(new Request("http://localhost/api/generate", { method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
    body: JSON.stringify(input) }));
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "KNOWLEDGE_NO_MATCH");
  assert.equal(calls, 0);
});

test("input-limit responses preserve measured token counts through client validation and distinguish PDF image size", async () => {
  const usage = { inputTokens: 82345, maxInputTokens: 64000 };
  const post = createGenerateHandler(adapter(async () => { throw new GenerationError("TOKEN_LIMIT_EXCEEDED", usage); }));
  const response = await post(request(JSON.stringify(input)));
  assert.equal(response.status, 413);
  const failure = apiErrorSchema.parse(await response.json());
  assert.deepEqual(failure.inputUsage, usage);
  const displayed = new GenerationError(failure.code, failure.inputUsage);
  assert.ok(displayed.message.includes("82,345토큰"));
  assert.ok(displayed.message.includes("64,000토큰"));
  assert.equal(displayed.retryable, false);
  assert.ok(!displayed.message.includes(sample));

  const tooLarge = await createGenerateHandler(adapter(async () => { throw new GenerationError("PDF_RENDER_TOO_LARGE"); }))(request(JSON.stringify(input)));
  const sizeFailure = apiErrorSchema.parse(await tooLarge.json());
  assert.equal(tooLarge.status, 413);
  assert.equal(sizeFailure.code, "PDF_RENDER_TOO_LARGE");
  assert.equal(sizeFailure.inputUsage, undefined);
  assert.ok(new GenerationError(sizeFailure.code).message.includes("50MB"));

  assert.equal(new GenerationError("RATE_LIMITED", usage).inputUsage, undefined);
  assert.equal(new GenerationError("TOKEN_LIMIT_EXCEEDED", { inputTokens: Infinity, maxInputTokens: 64000 }).inputUsage, undefined);
  assert.equal(apiErrorSchema.safeParse({ ...failure, inputUsage: { inputTokens: "private-text", maxInputTokens: 64000 } }).success, false);
});

test("client validates request identity, scene uniqueness, nonempty content and server review status", async () => {
  const board = await runGeneration(input, adapter());
  for (const change of [
    (candidate: typeof board) => { candidate.scenes[1].id = candidate.scenes[0].id; },
    (candidate: typeof board) => { candidate.scenes[0].narration = ""; },
    (candidate: typeof board) => { candidate.settings.language = "영어"; },
    (candidate: typeof board) => { candidate.scenes[0].review = false; },
  ]) {
    const candidate = structuredClone(board); change(candidate);
    assert.throws(() => parseGenerationResponse(candidate, input), hasCode("INVALID_OUTPUT"));
  }
  const regeneration = { ...input, scene: board.scenes[2] };
  const replacement = await runGeneration(regeneration, adapter());
  assert.equal(replacement.scenes[0].id, board.scenes[2].id);
  assert.throws(() => parseGenerationResponse(replacement, { ...input, scene: board.scenes[3] }), hasCode("INVALID_OUTPUT"));
});

test("AI mode and generation records survive storage and exports while old/manual drafts stay editable", async () => {
  const model = { ...adapter(), mode: "ai" as const, model: "fake-model-for-contract-test" };
  const board = await runGeneration(input, model);
  const draft = { ...input, board };
  assert.deepEqual(readDraft(serializeDraft(draft)), draft);
  assert.ok(markdown(board).includes("AI 생성 초안"));
  assert.ok(markdown(board).includes("fake-model-for-contract-test"));
  const old = generateDemo(sample, defaults);
  old.scenes[0].narration = "";
  old.scenes.push(newScene());
  assert.deepEqual(readDraft(serializeDraft({ ...input, board: old })).board, old);
});

test("AI copy is corrected after generation without changing source citations, settings or making another call", async () => {
  const req = { manuscript: "원문 자료\n" + "껴임 위험을 확인합니다. ".repeat(10), settings: { ...defaults, count: 3 as const, instructions: "껴임.pdf를 참고" } };
  const originalInput = structuredClone(req);
  const candidate = output(req);
  candidate.title = "껴임 예방 교육";
  candidate.summary = "껴임을 설명합니다.";
  candidate.objectives = ["껴임사고를 이해합니다."];
  const scene = candidate.scenes[0];
  Object.assign(scene, {
    title: "껴임 예방", purpose: "껴임을 이해합니다.",
    visual: "껴임 위험 표시", assets: "껴임 도식과 껴임.png",
    narration: "껴임을 살펴보고 껴임사고를 설명합니다.", subtitle: "껴임 예방",
    evidence: "껴임 위험을 확인합니다.", sourceId: "sentence:1-1",
  });
  const rawOutput = structuredClone(candidate);
  let calls = 0;
  const model = { ...adapter(async () => { calls++; return candidate; }), mode: "ai" as const };
  const board = await runGeneration(req, model);
  assert.equal(calls, 1);
  assert.equal(board.generation?.attempts, 1);
  assert.equal(board.title, "끼임 예방 교육");
  assert.equal(board.summary, "끼임을 설명합니다.");
  assert.deepEqual(board.objectives, ["끼임사고를 이해합니다."]);
  assert.equal(board.scenes[0].title, "끼임 예방");
  assert.equal(board.scenes[0].purpose, "끼임을 이해합니다.");
  assert.equal(board.scenes[0].visual, "끼임 위험 표시");
  assert.equal(board.scenes[0].assets, "끼임 도식과 껴임.png");
  assert.equal(board.scenes[0].narration, "끼임을 살펴보고 끼임사고를 설명합니다.");
  assert.equal(board.scenes[0].subtitle, "끼임 예방");
  assert.equal(board.scenes[0].evidence, scene.evidence);
  assert.equal(board.scenes[0].sourceId, scene.sourceId);
  assert.ok(board.scenes[0].reviewReason.includes("‘껴임’ → ‘끼임’"));
  assert.ok(board.scenes[0].reviewReason.includes("나레이션"));
  assert.equal(board.generation?.warnings.filter((warning) => warning.startsWith(TERM_CORRECTION_NOTICE_PREFIX)).length, 1);
  assert.deepEqual(req, originalInput);
  assert.deepEqual(candidate, rawOutput);
  assert.ok(board.scenes.every((scene) => scene.review && !scene.edited.length));
  const restored = readDraft(serializeDraft({ ...req, board })).board!;
  assert.deepEqual(restored, board);
  assert.ok(markdown(restored).includes("자동 용어 교정: ‘껴임’ → ‘끼임’"));
});

test("correction runs once after partial repair and also covers a regenerated scene", async () => {
  let calls = 0;
  const model = { ...adapter(async (_, context) => {
    const candidate = output();
    candidate.scenes[0].narration = "껴임을 확인합니다.";
    if (++calls === 1) candidate.scenes[1].narration = "";
    else {
      assert.equal(context.repair?.acceptedScenes[0].narration, "껴임을 확인합니다.");
      candidate.scenes[1].narration = "껴임사고를 설명합니다.";
    }
    return candidate;
  }), mode: "ai" as const };
  const board = await runGeneration(input, model);
  assert.equal(calls, 2);
  assert.equal(board.scenes[0].narration, "끼임을 확인합니다.");
  assert.equal(board.scenes[1].narration, "끼임사고를 설명합니다.");
  assert.equal(board.scenes[0].reviewReason.match(/자동 용어 교정:/g)?.length, 1);

  board.scenes[0].narration = "사용자가 편집한 껴임 표현";
  board.scenes[0].edited = ["narration"];
  const saved = serializeDraft({ ...input, board });
  assert.equal(readDraft(saved).board?.scenes[0].narration, "사용자가 편집한 껴임 표현");
  const regeneration = { ...input, scene: board.scenes[0] };
  let regenerationCalls = 0;
  const replacement = await runGeneration(regeneration, {
    ...adapter(async (req) => {
      regenerationCalls++;
      const candidate = output(req);
      candidate.scenes[0].narration = "껴임을 확인합니다.";
      return candidate;
    }), mode: "ai",
  });
  assert.equal(regenerationCalls, 1);
  assert.equal(replacement.scenes[0].narration, "끼임을 확인합니다.");
  assert.equal(replacement.scenes[0].id, board.scenes[0].id);
  assert.equal(serializeDraft({ ...input, board }), saved);
});

test("extractive demo and unregistered typos keep their original wording", async () => {
  const candidate = output();
  candidate.scenes[0].narration = "껴임과 미등록오타를 확인합니다.";
  const demo = await runGeneration(input, adapter(async () => candidate));
  assert.equal(demo.scenes[0].narration, candidate.scenes[0].narration);
  assert.ok(!demo.scenes[0].reviewReason.includes(TERM_CORRECTION_NOTICE_PREFIX));
  const ai = await runGeneration(input, { ...adapter(async () => {
    const candidate = output();
    candidate.scenes[0].narration = "미등록오타를 확인합니다.";
    return candidate;
  }), mode: "ai" });
  assert.equal(ai.scenes[0].narration, "미등록오타를 확인합니다.");
  assert.ok(!ai.generation?.warnings.some((warning) => warning.startsWith(TERM_CORRECTION_NOTICE_PREFIX)));
});
