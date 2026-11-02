import assert from "node:assert/strict";
import test from "node:test";
import { defaults, newScene } from "./storyboard";
import { GenerationError, CLIENT_TIMEOUT_MS, STORYBOARD_TIMEOUT_MS, SERVER_TIMEOUT_MS } from "./generation-contract";
import { verifySceneEvidence, verificationPrompt, VERIFICATION_TIMEOUT_MS, type EvidenceVerificationRequest } from "./server/generation-grounding";
import { runGeneration } from "./server/generation-service";

const text = "밀폐공간 작업 전 환기합니다.";
const scene = () => ({ ...newScene(), title: "밀폐공간 환기", narration: text, subtitle: text, evidence: text });
const reference = () => ({ id: `knowledge:${crypto.randomUUID()}`, documentId: crypto.randomUUID(), title: "환기 근거",
  excerpt: text, origin: "internal" as const, url: "", published: "", revision: "" });
const approve = (request: EvidenceVerificationRequest) => ({ verdicts: request.pairs.map(pair => ({ pairId: pair.id,
  matches: pair.claims.map(claim => ({ claimId: claim.id, verdict: "supported", quote: text, reason: "같은 환기 행동을 설명합니다.", value: "corroboration", applicability: "direct", transfer: null })),
})) });

test("compact verdicts keep every scene covered without requesting nonexistent visual evidence", async () => {
  let pairCount = 0;
  const results = await verifySceneEvidence(Array.from({ length: 12 }, scene), [reference(), reference()], async request => {
    pairCount = request.pairs.length;
    assert.ok(request.pairs.every(pair => pair.claims.every(claim => claim.field === "narration" || claim.field === "subtitle")));
    assert.match(verificationPrompt(request).instructions, /unsupported인 문장은 생략/);
    return { verdicts: request.pairs.map(pair => ({ pairId: pair.id, matches: [] })) };
  }, new AbortController().signal);
  assert.equal(pairCount, 20);
  assert.ok(results.every(scene => scene.grounding?.status === "no_match" && !scene.grounding.failures?.length));
  assert.ok(results.every(scene => (scene.grounding?.diagnostics?.checked ?? 0) > 0));
  assert.ok(results.every(scene => (scene.grounding?.diagnostics?.rejected ?? 0) >= 2));
});

test("a verification response after the old 20-second cutoff completes in two calls without losing the draft", async () => {
  let calls = 0;
  const board = await runGeneration({ manuscript: text, settings: defaults, scene: scene() }, {
    mode: "ai", model: "local-delayed-mock", promptVersion: "test", generate: async (_, context) => {
      calls++;
      if (context.verification) {
        // Real elapsed time exercises AbortSignal.timeout as well as the request deadline. No network or paid provider.
        await new Promise(resolve => setTimeout(resolve, 21000));
        context.signal.throwIfAborted();
        return approve(context.verification);
      }
      return { title: "환기", summary: "환기 교육", objectives: ["환기"], scenes: [{ sceneNo: 1, title: "환기", purpose: "환기",
        visual: "환기 장면", assets: "환기팬", narration: text, subtitle: text, duration: 30, evidence: text, sourceId: "sentence:1-1",
        referenceIds: [], visualReferenceIds: [], supplements: [],
      }] };
    },
  }, { references: [reference()] });
  assert.equal(calls, 2);
  assert.equal(board.scenes[0].grounding?.status, "verified");
  assert.equal(board.scenes[0].narration, text);
  assert.ok(STORYBOARD_TIMEOUT_MS >= SERVER_TIMEOUT_MS + 10000 + VERIFICATION_TIMEOUT_MS);
  assert.ok(CLIENT_TIMEOUT_MS >= STORYBOARD_TIMEOUT_MS + 15000);
});

test("timeout diagnostics retain the actual verification limit and bounded workload", async () => {
  const [result] = await verifySceneEvidence([scene()], [reference()], async () => {
    throw new DOMException("timeout", "TimeoutError");
  }, new AbortController().signal);
  const failure = result.grounding?.failures?.[0];
  assert.equal(failure?.timeoutMs, 60000);
  assert.equal(failure?.pairCount, 1);
  assert.equal(failure?.claimCount, 2);
  const controller = new AbortController();
  await assert.rejects(verifySceneEvidence([scene()], [reference()], async () => {
    controller.abort(new GenerationError("CANCELLED"));
    throw controller.signal.reason;
  }, controller.signal), (error: unknown) => error instanceof GenerationError && error.code === "CANCELLED");
});
