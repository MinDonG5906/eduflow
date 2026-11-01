import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { candidateProblems, validatedStructure, processedStructure, type ValidationCandidate, type ValidationVerdict } from "./knowledge-validation";
import { ValidationStore, contentHash } from "./server/knowledge-validation-store";
import { checkValidationPage, publishValidation, type ValidationDependencies } from "./server/knowledge-validation-service";
import { RAGFlowClient, PARSEFIXER_COMMIT, parseWithParseFixer, serviceConfig } from "./server/knowledge-services";
import { KnowledgeBase } from "./server/knowledge-base";
import { searchHybridKnowledge } from "./server/knowledge-hybrid-search";
import { writeValidation } from "./server/knowledge-validation-handler";
import type { AIConfig } from "./server/ai-config";
import { knowledgeVisionConfig } from "./server/knowledge-vision";
import { correctSource } from "./server/knowledge-source-check";
import { OPENAI_MODEL } from "./server/openai-adapter";
import { DatabaseSync } from "node:sqlite";
import { GenerationError } from "./generation-contract";

const candidate: ValidationCandidate = { text: "고소작업 추락 위험을 줄이기 위한 안전난간 설치와 작업 전 점검을 실시한다.", tables: [], figures: [], uncertainties: [] };
const verdict: ValidationVerdict = { textMatches: true, numbersAndUnitsMatch: true, tableCellsMatch: true,
  figuresAndLinksMatch: true, readingOrderMatches: true, coverageComplete: true, issues: [] };
const metadata = { title: "검사 시험 자료", origin: "official" as const, url: "https://example.org/source.pdf", published: "", revision: "test" };
const dependencies: ValidationDependencies = {
  config: () => ({} as AIConfig), image: async () => Buffer.from("test-page-image"),
  parse: async image => ({ commit: PARSEFIXER_COMMIT, imageHash: contentHash(image), initial: "오류가 포함된 초기 판독", markdown: "고소작업 판독" }),
  correct: async () => structuredClone(candidate),
};
async function fixture(t: TestContext, pages = [1]) {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-validation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pdf = await PDFDocument.create(); for (let i = 0; i < Math.max(...pages); i++) pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  const store = new ValidationStore(directory);
  const run = store.create(metadata, bytes, pages); store.close();
  return { directory, run, bytes };
}
function read(directory: string, id: string) { const store = new ValidationStore(directory); try { return store.get(id)!; } finally { store.close(); } }
const signal = () => AbortSignal.timeout(10000);
function mockRagflow() {
  let failAdd = false, retrievalOverride: unknown[] | undefined;
  const chunks: { id: string; document_id: string; content: string }[] = [];
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input), body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method: init?.method ?? "GET", url, body });
    const ok = (data: unknown) => Response.json({ code: 0, data });
    if (url.endsWith("?type=empty")) return ok([{ id: "remote-doc" }]);
    if (url.endsWith("/chunks")) {
      if (failAdd) return Response.json({ code: 100 }, { status: 200 });
      const chunk = { id: `chunk-${chunks.length + 1}`, document_id: "remote-doc", content: String(body.content) };
      chunks.push(chunk); return ok({ chunk });
    }
    if (url.endsWith("/retrieval")) return ok({ chunks: retrievalOverride ?? chunks });
    return ok({});
  };
  const client = new RAGFlowClient({ url: "http://127.0.0.1:9380", key: "test-secret" }, "test-dataset", transport);
  return { client, calls, chunks, fail: (value: boolean) => { failAdd = value; },
    results: (value: unknown[]) => { retrievalOverride = value; } };
}

test("missing source verification, uncertainty and failed numerical checks cannot pass", () => {
  assert.ok(candidateProblems(candidate).length);
  assert.ok(candidateProblems({ ...candidate, uncertainties: ["숫자가 흐림"] }, verdict).length);
  assert.ok(candidateProblems(candidate, { ...verdict, numbersAndUnitsMatch: false }).length);
  assert.ok(candidateProblems(candidate, { ...verdict, coverageComplete: false }).length);
  assert.deepEqual(candidateProblems(candidate, verdict), []);
});
test("overlapping table cells and orphan figure quotes are quarantined", () => {
  const invalid = structuredClone(candidate);
  invalid.tables = [{ id: "table1", rows: 2, cols: 2, cells: Array.from({ length: 4 }, () => ({ row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "2m" })) }];
  invalid.figures = [{ id: "fig1", title: "설치 그림", bounds: [0.1, 0.1, 0.5, 0.5], links: [{ quote: "원본에 없는 연결 문장", reason: "인접한 그림" }] }];
  assert.ok(candidateProblems(invalid, verdict).some(reason => reason.includes("셀")));
  assert.ok(candidateProblems(invalid, verdict).some(reason => reason.includes("연결")));
});
test("a forged passed flag cannot bypass the actual recorded verdict", () => {
  assert.throws(() => validatedStructure({ page: 1, status: "passed", attempts: [{ at: "now", reasons: [], candidate }] }, 1));
});
test("unanimous model verdict cannot approve phantom table columns or duplicated cell transcription", () => {
  const bad = structuredClone(candidate);
  bad.tables = [{ id: "table", rows: 2, cols: 3, cells: [
    { row: 1, col: 1, rowSpan: 1, colSpan: 2, text: "높은 곳에서 떨어질 위험이 있는 장소에서 작업하는 근로자" },
    { row: 1, col: 3, rowSpan: 1, colSpan: 1, text: "안전대" },
    { row: 2, col: 1, rowSpan: 1, colSpan: 2, text: "물체가 떨어지거나 날아올 위험이 있는 곳에서 작업하는 근로자" },
    { row: 2, col: 3, rowSpan: 1, colSpan: 1, text: "안전모" },
  ] }];
  bad.text += bad.tables[0].cells.map(cell => cell.text).join("\n");
  const reasons = candidateProblems(bad, verdict);
  assert.ok(reasons.some(reason => reason.includes("중복 열")));
  assert.ok(reasons.some(reason => reason.includes("본문에도 중복")));
  assert.throws(() => validatedStructure({ page: 1, status: "passed", attempts: [{ at: "now", candidate: bad, verdict, reasons: [] }] }, 1));
});
test("real header merges remain valid when lower rows establish each column", () => {
  const merged = structuredClone(candidate);
  merged.tables = [{ id: "table", rows: 3, cols: 2, cells: [
    { row: 1, col: 1, rowSpan: 1, colSpan: 2, text: "보호구 목록" },
    { row: 2, col: 1, rowSpan: 1, colSpan: 1, text: "안전모" },
    { row: 2, col: 2, rowSpan: 1, colSpan: 1, text: "머리" },
    { row: 3, col: 1, rowSpan: 1, colSpan: 1, text: "안전화" },
    { row: 3, col: 2, rowSpan: 1, colSpan: 1, text: "발" },
  ] }];
  assert.deepEqual(candidateProblems(merged, verdict), []);
});
test("a later quarantine revokes keyword and vector access without deleting prior evidence", async t => {
  const { directory, run } = await fixture(t);
  await checkValidationPage(run.id, 1, directory, signal(), dependencies);
  const remote = mockRagflow(); const published = await publishValidation(run.id, directory, signal(), remote.client);
  const store = new ValidationStore(directory), token = store.claim(run.id);
  try {
    published.quarantine = { at: new Date().toISOString(), reasons: ["후속 검사에서 결함 발견"] };
    store.save(published, token);
  } finally { store.release(run.id, token); store.close(); }
  const base = new KnowledgeBase(directory); base.setActive(published.localDocumentId!, true); base.close();
  assert.deepEqual(await searchHybridKnowledge("고소작업 추락", "", directory, signal(), remote.client), []);
  await assert.rejects(publishValidation(run.id, directory, signal(), remote.client));
  assert.equal(read(directory, run.id).pages[0].attempts.length, 1);
});
test("staging preserves original bytes and has no live search index", async t => {
  const { directory, run, bytes } = await fixture(t);
  const store = new ValidationStore(directory); assert.deepEqual(store.pdf(run.id), bytes); store.close();
  const base = new KnowledgeBase(directory); assert.deepEqual(base.list(), []); assert.deepEqual(base.search("고소작업 추락"), []); base.close();
});
test("single extraction is saved without a verdict and is not rerun", async t => {
  const { directory, run, bytes } = await fixture(t);
  let calls = 0;
  const result = await checkValidationPage(run.id, 1, directory, signal(), { ...dependencies, correct: async () => {
    calls++; return { ...candidate, uncertainties: ["연결 미확정"], figures: [{ id: "fig", title: "그림", bounds: [0.1, 0.1, 0.5, 0.5], links: [{ quote: candidate.text, reason: "인접 위치" }] }] };
  } });
  assert.equal(result.pages[0].status, "processed"); assert.equal(result.pages[0].attempts[0].verdict, undefined);
  const structure = processedStructure(result.pages[0], 1);
  assert.equal(structure.searchable, true); assert.equal(structure.figures.length, 1); assert.deepEqual(structure.links, []);
  await checkValidationPage(run.id, 1, directory, signal(), { ...dependencies, correct: async () => { assert.fail("must not rerun"); } });
  assert.equal(calls, 1); assert.equal(read(directory, run.id).pages[0].attempts.length, 1);
  const store = new ValidationStore(directory); assert.deepEqual(store.pdf(run.id), bytes); store.close();
});
test("unavailable model and cancellation remain held, never silently approved", async t => {
  const { directory, run } = await fixture(t, [1, 2]);
  await checkValidationPage(run.id, 1, directory, signal(), { ...dependencies, correct: async () => { throw new Error("secret provider error"); } });
  const abort = new AbortController(); abort.abort();
  await checkValidationPage(run.id, 2, directory, abort.signal, dependencies);
  assert.ok(read(directory, run.id).pages.every(page => page.status === "held"));
  assert.ok(!JSON.stringify(read(directory, run.id)).includes("secret provider error"));
  const remote = mockRagflow();
  await assert.rejects(publishValidation(run.id, directory, signal(), remote.client)); assert.equal(remote.calls.length, 0);
});
test("a second process cannot claim an active run", async t => {
  const { directory, run } = await fixture(t); const one = new ValidationStore(directory), two = new ValidationStore(directory);
  const token = one.claim(run.id); assert.throws(() => two.claim(run.id)); one.release(run.id, token);
  const second = two.claim(run.id); two.release(run.id, second); one.close(); two.close();
});
test("hourly throttling retains a useful reason without approving or verifying the page", async t => {
  const { directory, run } = await fixture(t);
  const checked = await checkValidationPage(run.id, 1, directory, signal(), { ...dependencies,
    correct: async () => { throw new GenerationError("RATE_LIMITED"); },
  });
  assert.equal(checked.pages[0].status, "held");
  assert.equal(checked.pages[0].attempts[0].errorCode, "RATE_LIMITED");
  assert.equal(checked.pages[0].attempts[0].phase, "correct");
  assert.match(checked.pages[0].attempts[0].reasons[0], /요청이 많습니다/);
});
test("publication skips empty pages and preserves original page numbers", async t => {
  const { directory, run } = await fixture(t, [2, 3]);
  await checkValidationPage(run.id, 2, directory, signal(), dependencies);
  await checkValidationPage(run.id, 3, directory, signal(), { ...dependencies, correct: async () => ({ text: "", tables: [], figures: [], uncertainties: [] }) });
  const remote = mockRagflow(); const result = await publishValidation(run.id, directory, signal(), remote.client);
  assert.equal(result.status, "published"); assert.equal(remote.chunks.length, 1);
  const base = new KnowledgeBase(directory); const doc = base.list()[0];
  assert.equal(doc.active, true); assert.deepEqual(base.structures(doc.id).map(page => [page.page, page.filePage]), [[2, 1]]);
  const storedPdf = await PDFDocument.load(base.pdf(doc.id)!); assert.equal(storedPdf.getPageCount(), 1); base.close();
  const enable = remote.calls.filter(call => call.method === "PATCH").map(call => call.body.enabled);
  assert.deepEqual(enable, [0, 1]);
  await publishValidation(run.id, directory, signal(), remote.client); assert.equal(remote.chunks.length, 1);
});
test("remote failure leaves local document inactive and retry does not duplicate it", async t => {
  const { directory, run } = await fixture(t); await checkValidationPage(run.id, 1, directory, signal(), dependencies);
  const remote = mockRagflow(); remote.fail(true);
  await assert.rejects(publishValidation(run.id, directory, signal(), remote.client));
  const base = new KnowledgeBase(directory); const doc = base.list()[0]; assert.equal(doc.active, false);
  base.setActive(doc.id, true); // Even a legacy toggle must not bypass the publication allowlist.
  assert.deepEqual(await searchHybridKnowledge("고소작업 추락", "", directory, signal(), remote.client), []);
  base.setActive(doc.id, false); base.close(); remote.fail(false);
  await publishValidation(run.id, directory, signal(), remote.client);
  const after = new KnowledgeBase(directory); assert.equal(after.list().length, 1); after.close();
});
test("hybrid retrieval rejects unknown chunks, changed text, disabled and deleted documents", async t => {
  const { directory, run } = await fixture(t); await checkValidationPage(run.id, 1, directory, signal(), dependencies);
  const remote = mockRagflow(); const published = await publishValidation(run.id, directory, signal(), remote.client);
  remote.results([{ id: "rogue", document_id: "remote-doc", content: "잘못된 안전 규정" },
    { ...remote.chunks[0], content: "숫자를 바꾼 결과" }, ...remote.chunks]);
  const results = await searchHybridKnowledge("고소작업 추락", "", directory, signal(), remote.client);
  assert.equal(results.length, 1); assert.equal(results[0].excerpt, candidate.text);
  const base = new KnowledgeBase(directory); base.setActive(published.localDocumentId!, false);
  assert.deepEqual(await searchHybridKnowledge("고소작업 추락", "", directory, signal(), remote.client), []);
  base.deleteDocument(published.localDocumentId!); base.close();
  assert.deepEqual(await searchHybridKnowledge("고소작업 추락", "", directory, signal(), remote.client), []);
});
test("post-verification edits invalidate both keyword and vector results", async t => {
  const { directory, run } = await fixture(t); await checkValidationPage(run.id, 1, directory, signal(), dependencies);
  const remote = mockRagflow(); const result = await publishValidation(run.id, directory, signal(), remote.client);
  const base = new KnowledgeBase(directory); const current = base.structures(result.localDocumentId!)[0];
  const changed = structuredClone(current); changed.text += " 바뀐 숫자 999m"; changed.blocks[0].text += " 바뀐 숫자 999m";
  base.saveStructure(result.localDocumentId!, changed, JSON.stringify(current)); base.close();
  assert.deepEqual(await searchHybridKnowledge("고소작업 추락", "", directory, signal(), remote.client), []);
});
test("RAGFlow business errors are failures even with HTTP 200; empty allowlists never retrieve all documents", async () => {
  let calls = 0;
  const client = new RAGFlowClient({ url: "http://localhost:9380", key: "secret" }, "dataset", async () => { calls++; return Response.json({ code: 102, message: "not found" }); });
  assert.deepEqual(await client.retrieve("test", [], signal()), []); assert.equal(calls, 0);
  await assert.rejects(client.create("test.txt", signal()));
});
test("ParseFixer response must be tied to the exact input image and pinned commit", async () => {
  const env = { EDUFLOW_PARSEFIXER_URL: "http://localhost:8765", EDUFLOW_PARSEFIXER_KEY: "secret" };
  await assert.rejects(parseWithParseFixer(Buffer.from("source"), signal(), env, async () => Response.json({
    commit: PARSEFIXER_COMMIT, imageHash: "0".repeat(64), initial: "initial", markdown: "parsed",
  })));
  assert.throws(() => serviceConfig("PARSEFIXER", { ...env, EDUFLOW_PARSEFIXER_URL: "http://external.example" }));
});
test("validation API rejects cross-origin writes without creating staging data", async t => {
  const { directory } = await fixture(t);
  const response = await writeValidation(new Request("http://localhost:3000/api/knowledge/validation", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}",
  }), directory);
  assert.notEqual(response.status, 200);
});

test("single-pass processing makes one bounded model call in the persistent budget ledger", async t => {
  const { directory, run } = await fixture(t);
  const config = knowledgeVisionConfig(directory, { EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-private-test-key",
    EDUFLOW_AI_MODEL: OPENAI_MODEL, EDUFLOW_AI_INPUT_USD_PER_MILLION: "0.75", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4.50", EDUFLOW_AI_REQUEST_BUDGET_USD: "0.10" });
  const calls: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (input, init) => {
    if (String(input).endsWith("input_tokens")) return Response.json({ input_tokens: 2500 });
    const body = JSON.parse(String(init?.body)); calls.push(body);
    const data = calls.length === 1 ? candidate : verdict;
    return Response.json({ object: "response", id: `response-${calls.length}`, status: "completed", output: [{
      type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(data), annotations: [] }],
    }] });
  };
  await checkValidationPage(run.id, 1, directory, signal(), { ...dependencies, config: () => config,
    correct: (text, image, config, directory, signal) => correctSource(text, image, config, directory, signal, transport) });
  assert.equal(calls.length, 1);
  assert.ok(calls.every(call => call.store === false && call.max_output_tokens === config.maxOutputTokens && !call.previous_response_id));
  const db = new DatabaseSync(join(directory, "ai-budget.sqlite"));
  try {
    const rows = db.prepare("SELECT attempts,active FROM reservations").all(); assert.equal(rows.length, 1);
    assert.ok(rows.every(row => row.attempts === 1 && row.active === 0));
    assert.equal(db.prepare("SELECT amount FROM budgets LIMIT 1").get()!.amount, config.attemptCost);
  } finally { db.close(); }
});
test("a document disabled during remote retrieval cannot leak through precomputed keyword results", async t => {
  const { directory, run } = await fixture(t); await checkValidationPage(run.id, 1, directory, signal(), dependencies);
  const remote = mockRagflow(); const published = await publishValidation(run.id, directory, signal(), remote.client);
  const retrieve = remote.client.retrieve.bind(remote.client);
  remote.client.retrieve = async (...args) => {
    const result = await retrieve(...args); const base = new KnowledgeBase(directory);
    base.setActive(published.localDocumentId!, false); base.close(); return result;
  };
  assert.deepEqual(await searchHybridKnowledge("고소작업 추락", "", directory, signal(), remote.client), []);
});
test("test corpus stays excluded from real generation even after publish and a manual activation", async t => {
  const { directory, run } = await fixture(t);
  const store = new ValidationStore(directory), token = store.claim(run.id);
  run.testOnly = true; store.save(run, token); store.release(run.id, token); store.close();
  await checkValidationPage(run.id, 1, directory, signal(), dependencies);
  const remote = mockRagflow(); const published = await publishValidation(run.id, directory, signal(), remote.client);
  const base = new KnowledgeBase(directory); assert.equal(base.list()[0].active, false);
  base.setActive(published.localDocumentId!, true); base.close();
  assert.deepEqual(await searchHybridKnowledge("고소작업 추락", "", directory, signal(), remote.client), []);
});


test("removed review APIs cannot approve or recheck stored data", async () => {
  const review = await import("../app/api/knowledge/review/route");
  const recheck = await import("../app/api/knowledge/recheck/route");
  const structure = await import("../app/api/knowledge/structure/route");
  assert.equal(review.GET().status, 410);
  assert.equal(review.POST().status, 410);
  assert.equal(recheck.POST().status, 410);
  assert.equal(structure.POST().status, 410);
});

test("single-pass publication requires a recorded extraction, not just a processed label", () => {
  assert.throws(() => processedStructure({ page: 1, status: "processed", attempts: [] }, 1));
  assert.throws(() => processedStructure({ page: 1, status: "processed", attempts: [{ at: "now", reasons: [], candidate }] }, 1));
});
