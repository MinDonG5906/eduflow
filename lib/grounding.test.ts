import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { assessCandidate, educationUnits, exactSentences, rankCandidates } from "./grounding";
import { defaults, newScene, type Scene } from "./storyboard";
import { editScene } from "./board-edit";
import { readDraft, serializeDraft } from "./studio-state";
import { runGeneration, type GenerationAdapter } from "./server/generation-service";
import { verifySceneEvidence, verificationPrompt, type EvidenceVerificationRequest } from "./server/generation-grounding";
import { withKnowledgeContext } from "./server/knowledge-context";
import { makeKnowledgeStructure, tableBlocks, type KnowledgeTable } from "./knowledge-structure";

const original = "사고 직후 작업을 중지합니다. 전원을 차단합니다. 응급조치를 실시합니다.";
const scene = (): Scene => ({ ...newScene(), title: "사고 직후 대응", narration: original,
  subtitle: "작업을 중지합니다.\n전원을 차단합니다.", evidence: original, sourceId: "sentence:1-3" });
const reference = (excerpt = original) => ({ id: `knowledge:${crypto.randomUUID()}`, documentId: crypto.randomUUID(),
  title: "중량물 작업 안전", excerpt, origin: "internal" as const, url: "", published: "2026", revision: "1", page: 4 });
const prevention = () => reference("중량물 사고 예방을 위해 작업 전 작업계획서를 작성하고 작업 순서를 점검합니다.");
const signal = () => new AbortController().signal;
const approve = (request: EvidenceVerificationRequest) => ({ verdicts: request.pairs.map(pair => ({
  pairId: pair.id,
  matches: pair.claims.filter(claim => claim.field === "narration" || claim.field === "subtitle").map(claim => ({
    claimId: claim.id, verdict: "supported", quote: pair.reference.excerpt, reason: "같은 사고 대응 행동을 직접 명시합니다.", value: "corroboration", applicability: "direct", transfer: null,
  })),
})) });

test("educational units separate prevention and immediate response, retaining headings", () => {
  const units = educationUnits(`중량물 작업\n작업 전 작업계획서를 작성합니다. ${original}`);
  assert.ok(units.some(unit => unit.intent.situation === "prevention"));
  assert.ok(units.some(unit => unit.intent.situation === "response"));
  assert.ok(units.every(unit => unit.heading === "중량물 작업"));
  assert.ok(!units.some(unit => unit.text.includes("계획서") && unit.text.includes("응급조치")));
});

test("regression: shared accident topic and title cannot turn prevention into emergency evidence", async () => {
  const bad = prevention();
  assert.equal(assessCandidate(original, bad).eligible, false);
  assert.deepEqual(rankCandidates(original, [bad]), []);
  let calls = 0;
  const [result] = await verifySceneEvidence([scene()], [bad], async request => { calls++; return approve(request); }, signal());
  assert.equal(calls, 0);
  assert.deepEqual(result.references, []);
  assert.equal(result.narration, original);
  assert.equal(result.grounding?.status, "no_match");
});

test("verified exact narration and subtitle sentences survive draft storage and show their usage", async () => {
  const ref = reference();
  const [result] = await verifySceneEvidence([scene()], [ref], async request => approve(request), signal());
  assert.equal(result.references?.[0].id, ref.id);
  assert.equal(result.grounding?.status, "verified");
  assert.ok(result.grounding?.links.some(link => link.field === "narration"));
  assert.ok(result.grounding?.links.some(link => link.field === "subtitle"));
  for (const link of result.grounding!.links) {
    assert.equal(result[link.field].slice(link.start, link.end), link.sentence);
    assert.ok(ref.excerpt.includes(link.quote));
  }
  const board = { title: "대응", summary: "대응 교육", objectives: ["행동 확인"], scenes: [result], settings: defaults, mode: "ai" as const };
  const restored = readDraft(serializeDraft({ manuscript: original, settings: defaults, board })).board!;
  assert.deepEqual(restored.scenes[0].grounding, result.grounding);
  const edited = editScene(restored, 0, "narration", "작업을 계속합니다.");
  assert.equal(edited.scenes[0].grounding?.status, "stale");
  assert.deepEqual(edited.scenes[0].grounding?.links, result.grounding?.links);
  const render = (value: Scene) => execFileSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { SceneEvidenceLinks } = require('./components/scene-evidence-links.tsx');
    process.stdout.write(renderToStaticMarkup(React.createElement(SceneEvidenceLinks, JSON.parse(process.argv[1]))));
  `, JSON.stringify({ scene: value, referenceId: ref.id })], { cwd: process.cwd(), encoding: "utf8" });
  const html = render(result);
  assert.match(html, /AI 대조 통과/); assert.match(html, /나레이션/); assert.match(html, /자막/);
  assert.match(html, /근거 구절·연결 이유 보기/);
  assert.ok(html.includes(`<blockquote>${original}</blockquote>`));
  assert.doesNotMatch(render(edited.scenes[0]), /AI 대조 통과/);
});

test("no related material, unavailable judge and rejected semantics retain the source-only draft", async () => {
  for (const refs of [[], [reference("올바른 분리배출 방법을 설명합니다.")]]) {
    const [result] = await verifySceneEvidence([scene()], refs, async () => { throw new Error("must not call"); }, signal());
    assert.deepEqual(result.references, []); assert.equal(result.narration, original);
    assert.equal(result.grounding?.status, "no_match");
  }
  const [failed] = await verifySceneEvidence([scene()], [reference()], async () => { throw new Error("network"); }, signal());
  assert.equal(failed.grounding?.status, "unavailable"); assert.equal(failed.narration, original);
  const [rejected] = await verifySceneEvidence([scene()], [reference()], async request => ({ verdicts: approve(request).verdicts.map(v => ({ ...v, matches: v.matches.map(m => ({ ...m, verdict: "unsupported" })) })) }), signal());
  assert.deepEqual(rejected.references, []);
});

test("invented quotes, invented claims, duplicate verdicts, invalid JSON and partial support all fail closed", async () => {
  for (const mutation of [
    (result: any) => { result.verdicts[0].matches.forEach((m: any) => m.quote = "자료에 없는 구절"); },
    (result: any) => { result.verdicts[0].matches.forEach((m: any) => m.claimId = "invented"); },
    (result: any) => { result.verdicts.push(result.verdicts[0]); },
    (result: any) => { result.verdicts[0].pairId = "invented"; },
  ]) {
    const [result] = await verifySceneEvidence([scene()], [reference()], async request => { const raw = approve(request); mutation(raw); return raw; }, signal());
    assert.deepEqual(result.references, []);
  }
  const [invalid] = await verifySceneEvidence([scene()], [reference()], async () => "not json", signal());
  assert.equal(invalid.grounding?.status, "unavailable");
  const compound = { ...scene(), narration: "사고 직후 작업을 중지하고 전원을 차단한 뒤 응급조치를 합니다.", subtitle: "" };
  const [partial] = await verifySceneEvidence([compound], [reference("사고 직후 작업을 중지합니다.")], async request => approve(request), signal());
  assert.deepEqual(partial.references, [], "one action cannot support a compound sentence");
});

test("few-candidate cap is explicit and cancellation is never treated as a source-only success", async () => {
  let pairs = 0;
  const results = await verifySceneEvidence(Array.from({ length: 20 }, scene), [reference(), reference()], async request => {
    pairs = request.pairs.length; return approve(request);
  }, signal());
  assert.equal(pairs, 20);
  assert.equal(results.filter(s => s.grounding?.status === "verified").length, 20);
  const controller = new AbortController();
  await assert.rejects(verifySceneEvidence([scene()], [reference()], async () => { controller.abort(); throw new Error(); }, controller.signal));
  await assert.rejects(verifySceneEvidence([scene()], [], undefined, controller.signal));
});

test("context retains original section and table headers without using them as quoted evidence", () => {
  const table: KnowledgeTable = { id: "t1", rows: 2, cols: 2, cells: [
    { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "적용 상황" }, { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: "조치사항" },
    { row: 2, col: 1, rowSpan: 1, colSpan: 1, text: "사고 직후" }, { row: 2, col: 2, rowSpan: 1, colSpan: 1, text: "전원을 차단합니다." },
  ] };
  const structure = makeKnowledgeStructure(4, 1, "", true, [table]);
  structure.blocks.unshift({ id: "section", text: "2. 사고 발생 시 조치" });
  const row = tableBlocks(table, 4)[1];
  const contextual = withKnowledgeContext({ ...reference(row.text), blockIds: [row.id] }, structure);
  assert.equal(contextual.context?.sectionTitle, "2. 사고 발생 시 조치");
  assert.deepEqual(contextual.context?.tableHeaders, ["적용 상황", "조치사항"]);
  assert.equal(contextual.excerpt, row.text);
});

test("generation receives retrieved sources, then a distinct judge; repair consumes the judge slot", async () => {
  for (const repair of [false, true]) {
    const ref = reference(); let calls = 0;
    const input = { manuscript: original, settings: defaults, scene: scene() };
    const adapter: GenerationAdapter = { mode: "ai", model: "mock", promptVersion: "test", generate: async (_, context) => {
      calls++;
      if (context.verification) {
        assert.equal(calls, 2); assert.equal(context.pdf, undefined);
        assert.match(verificationPrompt(context.verification).instructions, /독립된 근거 검증/);
        return approve(context.verification);
      }
      assert.deepEqual(context.task.supplementalSources, [ref]);
      assert.deepEqual(context.task.selectedScene?.references, []);
      if (repair && calls === 1) return {};
      return { title: "사고 대응", summary: "현장 대응", objectives: ["대응 순서"], scenes: [{
        sceneNo: 1, title: "사고 대응", purpose: "대응 순서", visual: "현장", assets: "현장 화면", narration: original,
        subtitle: "작업을 중지합니다.\n전원을 차단합니다.", duration: 30, evidence: original, sourceId: "sentence:1-3", referenceIds: [], visualReferenceIds: [],
      }] };
    } };
    const board = await runGeneration(input, adapter, { references: [ref] });
    assert.equal(calls, 2);
    assert.equal(board.scenes[0].grounding?.status, repair ? "budget_skipped" : "verified");
    assert.equal(board.scenes[0].narration, original);
  }
});

test("sentence offsets preserve subtitle newlines and whitespace", () => {
  const text = "  작업을 중지합니다.\n 전원을 차단합니다. ";
  assert.equal(exactSentences(text).length, 2);
  for (const part of exactSentences(text)) assert.equal(text.slice(part.start, part.end), part.sentence);
  assert.deepEqual(exactSentences("1.5m 간격을 유지합니다.").map(p => p.sentence), ["1.5m 간격을 유지합니다."]);
});

test("a positive AI verdict cannot override negation or a different numerical condition", async () => {
  for (const [claim, quote] of [
    ["전원을 차단하지 않습니다.", "전원을 차단합니다."],
    ["환기팬을 5분 가동합니다.", "환기팬을 3분 가동합니다."],
  ]) {
    const [result] = await verifySceneEvidence([{ ...scene(), narration: claim, subtitle: "" }], [reference(quote)],
      async request => approve(request), signal());
    assert.deepEqual(result.references, []);
  }
});
