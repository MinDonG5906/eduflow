import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { defaults, newScene } from "./storyboard";
import { GenerationError } from "./generation-contract";
import { readDraft, serializeDraft } from "./studio-state";
import { verifySceneEvidence, type EvidenceVerificationRequest } from "./server/generation-grounding";
import { searchSceneKnowledge } from "./server/scene-knowledge";
import { retrieveGenerationKnowledge } from "./server/generation-knowledge";
import { runGeneration } from "./server/generation-service";
import { groundingFailure } from "./server/grounding-failure";

const text = "밀폐공간 작업 전 환기합니다.";
const scene = () => ({ ...newScene(), title: "밀폐공간 환기", narration: text, subtitle: text, evidence: text });
const ref = () => ({ id: `knowledge:${crypto.randomUUID()}`, documentId: crypto.randomUUID(), title: "환기 근거",
  excerpt: text, origin: "internal" as const, url: "", published: "", revision: "" });
const signal = () => new AbortController().signal;
const verdict = (request: EvidenceVerificationRequest) => ({ verdicts: request.pairs.map(pair => ({ pairId: pair.id,
  matches: pair.claims.map(claim => ({ claimId: claim.id, verdict: "unsupported", quote: "", reason: "지원하지 않음", value: "corroboration", applicability: "direct", transfer: null })),
})) });

test("verification failures retain safe reasons and token counts, not raw provider content", async () => {
  const cases = [
    [new DOMException("secret-timeout", "TimeoutError"), "timeout"],
    [new GenerationError("TIMEOUT"), "timeout"],
    [new GenerationError("TOKEN_LIMIT_EXCEEDED", { inputTokens: 17000, maxInputTokens: 16000 }), "input_limit"],
    [new GenerationError("OUTPUT_TRUNCATED"), "output_limit"],
    [new GenerationError("RATE_LIMITED"), "rate_limited"],
    [new GenerationError("AI_AUTH_FAILED"), "auth_failed"],
    [new GenerationError("AI_NOT_CONFIGURED"), "configuration"],
    [new GenerationError("BUDGET_EXCEEDED"), "budget"],
    [new GenerationError("AI_REFUSED"), "refused"],
    [new GenerationError("PROVIDER_UNAVAILABLE"), "provider_error"],
    [new Error("secret-key and private-manuscript"), "unknown"],
  ] as const;
  for (const [error, reason] of cases) {
    const results = await verifySceneEvidence([scene(), scene()], [ref()], async () => { throw error; }, signal(),
      [{ references: [ref()], status: "retrieved" }, { references: [], status: "no_match" }]);
    const failure = results[0].grounding?.failures?.[0];
    assert.equal(failure?.reason, reason);
    assert.equal(failure?.stage, "verification");
    assert.ok(failure?.recordedAt && Number.isFinite(Date.parse(failure.recordedAt)));
    assert.equal(results[0].grounding?.status, "unavailable");
    assert.equal(results[0].narration, text);
    assert.equal(results[1].grounding?.status, "no_match", "an unattempted scene must not inherit a shared provider failure");
    assert.equal(results[1].grounding?.failures, undefined);
    assert.doesNotMatch(JSON.stringify(results), /secret-key|private-manuscript|secret-timeout/);
    if (error instanceof GenerationError && error.inputUsage) assert.equal(failure?.inputTokens, 17000);
  }
});

test("malformed or missing verdicts are distinguishable from a completed negative verdict", async () => {
  for (const raw of ["not JSON", { verdicts: [] }, { verdicts: [{ pairId: "missing", matches: [] }] }]) {
    const [result] = await verifySceneEvidence([scene()], [ref()], async () => raw, signal());
    assert.equal(result.grounding?.status, "unavailable");
    assert.equal(result.grounding?.failures?.[0].reason, "invalid_response");
  }
  const [result] = await verifySceneEvidence([scene()], [ref()], async request => verdict(request), signal());
  assert.equal(result.grounding?.status, "no_match");
  assert.equal(result.grounding?.failures, undefined);
});

test("search failures and deadlines stay distinct and completed results survive", async () => {
  const scenes = [scene(), { ...scene(), title: "검색 오류" }, { ...scene(), title: "검색 지연" }];
  const results = await searchSceneKnowledge(scenes, signal(), async query => {
    if (query.includes("검색 오류")) throw new Error("secret-db-path");
    if (query.includes("검색 지연")) return new Promise(() => {});
    return [ref()];
  }, 15);
  assert.equal(results[0].status, "retrieved");
  assert.equal(results[0].failure, undefined);
  assert.equal(results[1].failure?.reason, "search_failed");
  assert.equal(results[2].failure?.reason, "timeout");
  assert.equal(results[2].failure?.timeoutMs, 15);
  assert.doesNotMatch(JSON.stringify(results), /secret-db-path/);
  const pre = await retrieveGenerationKnowledge({ manuscript: text, settings: defaults }, { signal: signal() }, () => { throw Error("private"); });
  assert.equal(pre.failure?.stage, "source_search");
  assert.equal(pre.failure?.reason, "search_failed");
});

test("failure records survive generation and draft recovery, while unverified supplements never do", async () => {
  const reference = ref(); let calls = 0;
  const board = await runGeneration({ manuscript: text, settings: defaults, scene: scene() }, {
    mode: "ai", model: "mock", promptVersion: "test", generate: async (_, context) => {
      calls++;
      if (context.verification) throw new GenerationError("OUTPUT_TRUNCATED");
      return { title: "환기", summary: "환기 교육", objectives: ["환기"], scenes: [{ sceneNo: 1, title: "환기", purpose: "환기",
        visual: "환기 장면", assets: "환기팬", narration: text, subtitle: text, duration: 30, evidence: text, sourceId: "sentence:1-1",
        referenceIds: [], visualReferenceIds: [], supplements: [{ field: "narration", text: "밀폐공간 작업 전에는 환기를 실시합니다.", referenceId: "rag:1" }],
      }] };
    },
  }, { references: [reference], knowledgeFailure: groundingFailure("source_search", undefined, Date.now()),
    retrieveSceneKnowledge: async () => { throw new Error("private-path"); } });
  assert.equal(calls, 2);
  const restored = readDraft(serializeDraft({ manuscript: text, settings: defaults, board })).board!;
  assert.deepEqual(restored.scenes[0].grounding?.failures?.map(f => f.stage), ["source_search", "scene_search", "verification"]);
  assert.equal(restored.scenes[0].grounding?.failures?.[2].reason, "output_limit");
  assert.equal(restored.scenes[0].narration, text);
  assert.equal(restored.scenes[0].grounding?.diagnostics?.supplementsRemoved, 1);
  assert.doesNotMatch(JSON.stringify(restored), /private-path/);
});

test("old drafts disclose missing history; detailed errors render without raw service text", () => {
  const values = [
    { ...scene(), grounding: { status: "unavailable", links: [] } },
    { ...scene(), grounding: { status: "unavailable", links: [], failures: [groundingFailure("verification",
      new GenerationError("TOKEN_LIMIT_EXCEEDED", { inputTokens: 17000, maxInputTokens: 16000 }), Date.now())] } },
  ];
  const html = execFileSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { SceneEvidenceStatus } = require('./components/scene-evidence-links.tsx');
    process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(scene => renderToStaticMarkup(React.createElement(SceneEvidenceStatus, {scene})))));
  `, JSON.stringify(values)], { encoding: "utf8", cwd: process.cwd() });
  const rendered = JSON.parse(html);
  assert.match(rendered[0], /세부 원인은 기록되지 않았습니다/);
  assert.match(rendered[1], /입력 한도/);
  assert.match(rendered[1], /17,000/);
  assert.match(rendered[1], /16,000/);
  assert.match(rendered[1], /장면 하나씩/);
  const restored = readDraft(serializeDraft({ manuscript: text, settings: defaults, board: {
    title: "기존", summary: "기존", objectives: ["기존"], settings: defaults, mode: "ai", scenes: [values[0] as ReturnType<typeof scene>],
  } })).board!;
  assert.equal(restored.scenes[0].grounding?.failures, undefined);
});
