import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { ValidationStore, contentHash } from "./server/knowledge-validation-store";
import { enqueueExisting, processValidationQueue, type QueueDependencies } from "./server/knowledge-validation-queue";
import { checkValidationPage, publishValidation, type ValidationDependencies } from "./server/knowledge-validation-service";
import { KnowledgeBase } from "./server/knowledge-base";
import { LocalSearchIndex } from "./server/knowledge-local-index";
import { makeKnowledgeStructure } from "./knowledge-structure";
import { validationCounts, type ValidationCandidate, type ValidationVerdict } from "./knowledge-validation";
import { searchHybridKnowledge } from "./server/knowledge-hybrid-search";
import { GenerationError } from "./generation-contract";
import type { AIConfig } from "./server/ai-config";

const candidate: ValidationCandidate = { text: "고소작업 추락 사고 예방을 위해 안전난간과 작업발판을 점검합니다.", tables: [], figures: [], uncertainties: [] };
const verdict: ValidationVerdict = { textMatches: true, numbersAndUnitsMatch: true, tableCellsMatch: true, figuresAndLinksMatch: true, readingOrderMatches: true, coverageComplete: true, issues: [] };
const parser: ValidationDependencies = { config: () => ({} as AIConfig), image: async () => Buffer.from("original"),
  parse: async image => ({ commit: "c3d48d2a7d17a13c526ff0fa42731f389a3bbf83", initial: "initial", markdown: "initial", imageHash: contentHash(image) }),
  correct: async () => structuredClone(candidate) };
const metadata = { title: "자동 처리 테스트", origin: "internal" as const, published: "", revision: "" };
async function fixture(t: TestContext, pages = 1) {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-queue-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pdf = await PDFDocument.create(); for (let i = 0; i < pages; i++) pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const store = new ValidationStore(directory); t.after(() => store.close());
  const index = new LocalSearchIndex(directory, async () => [1, 0]);
  const deps: QueueDependencies = { availability: () => ({ ready: true, nextAt: 0, reason: "" }),
    check: (id, page, dir, signal) => checkValidationPage(id, page, dir, signal, parser),
    publish: (id, dir, signal) => publishValidation(id, dir, signal, index) };
  return { directory, bytes, store, deps, index };
}

test("50 uploaded documents advance to stored results without page approvals", async t => {
  const { directory, bytes, store, deps, index } = await fixture(t);
  for (let i = 0; i < 50; i++) store.enqueue(store.create({ ...metadata, title: `자료 ${i}` }, bytes, [1]).id);
  for (let i = 0; i < 50; i++) assert.equal(await processValidationQueue(directory, deps), true);
  assert.equal(await processValidationQueue(directory, deps), false);
  assert.equal(store.jobs().filter(job => job.state === "complete").length, 50);
  assert.ok(store.list().every(run => run.status === "published"));
  assert.ok((await searchHybridKnowledge("고소작업 추락", "", directory, AbortSignal.timeout(5000), index)).length);
});

test("uncertainty is stored after one extraction without retries or approvals", async t => {
  const { directory, bytes, store, deps } = await fixture(t);
  const run = store.create(metadata, bytes, [1]); store.enqueue(run.id); let calls = 0;
  deps.check = (id, page, dir, signal) => checkValidationPage(id, page, dir, signal, { ...parser, correct: async () => {
    calls++; return { ...candidate, uncertainties: ["다른 페이지에 그림 설명이 이어짐"] };
  } });
  await processValidationQueue(directory, deps);
  assert.equal(store.get(run.id)!.status, "published"); assert.equal(calls, 1);
  assert.equal(store.get(run.id)!.pages[0].status, "processed");
  assert.equal(store.get(run.id)!.pages[0].attempts[0].verdict, undefined);
  assert.equal(validationCounts(store.get(run.id)!).exceptions, 0);
});

test("rate-limited work waits durably and resumes without becoming a review exception", async t => {
  const { directory, bytes, store, deps } = await fixture(t);
  const run = store.create(metadata, bytes, [1]); store.enqueue(run.id); let calls = 0;
  deps.availability = () => ({ ready: false, nextAt: 10000, reason: "시간당 한도" });
  const check = deps.check; deps.check = (...args) => { calls++; return check(...args); };
  await processValidationQueue(directory, deps, 1000);
  const reopened = new ValidationStore(directory); assert.equal(reopened.job(run.id)!.state, "waiting"); reopened.close();
  assert.equal(calls, 0); assert.equal(validationCounts(store.get(run.id)!).exceptions, 0);
  deps.availability = () => ({ ready: true, nextAt: 0, reason: "" });
  assert.equal(await processValidationQueue(directory, deps, 9999), false);
  await processValidationQueue(directory, deps, 10000); assert.equal(store.get(run.id)!.status, "published");
});

test("legacy held candidates are stored without another paid call even at the budget limit", async t => {
  const { directory, bytes, store, deps } = await fixture(t);
  const run = store.create(metadata, bytes, [1]);
  const token = store.claim(run.id);
  run.pages[0] = { page: 1, status: "held", attempts: [{ at: "before", candidate, reasons: ["연결 불확실"], verdict: { ...verdict, figuresAndLinksMatch: false } }] };
  store.save(run, token); store.release(run.id, token); store.enqueue(run.id);
  deps.availability = () => { assert.fail("cached extraction must not reserve paid capacity"); };
  deps.check = (id, page, dir, signal) => checkValidationPage(id, page, dir, signal, { ...parser,
    config: () => { assert.fail("no paid configuration needed"); }, correct: async () => { assert.fail("must reuse extraction"); } });
  await processValidationQueue(directory, deps);
  const result = store.get(run.id)!;
  assert.equal(result.status, "published"); assert.equal(result.pages[0].status, "processed");
  assert.equal(result.pages[0].attempts.length, 2); assert.equal(result.pages[0].attempts[1].calls, 0);
});

test("pause during an in-flight page prevents publication and resume continues", async t => {
  const { directory, bytes, store, deps } = await fixture(t);
  const run = store.create(metadata, bytes, [1]); store.enqueue(run.id);
  const original = deps.check;
  deps.check = async (...args) => { const result = await original(...args); store.putJob({ ...store.job(run.id)!, state: "paused" }); return result; };
  await processValidationQueue(directory, deps);
  assert.equal(store.job(run.id)!.state, "paused"); assert.equal(store.get(run.id)!.localDocumentId, undefined);
  store.enqueue(run.id); await processValidationQueue(directory, deps);
  assert.equal(store.get(run.id)!.status, "published");
});

test("existing material keeps original page numbers, replaces search atomically, and rejects duplicate enrollment", async t => {
  const { directory, bytes, store, deps, index } = await fixture(t);
  const base = new KnowledgeBase(directory); t.after(() => base.close());
  const original = base.addImported(metadata, contentHash(bytes), bytes, [{ page: 7, text: candidate.text, method: "text", confidence: null, reviewReason: "", needsReview: false,
    structure: makeKnowledgeStructure(7, 1, candidate.text, true) }]);
  const one = await enqueueExisting([original.id], directory), two = await enqueueExisting([original.id], directory);
  assert.equal(one[0].runId, two[0].runId); assert.deepEqual(store.get(one[0].runId!)!.filePages, { 7: 1 });
  assert.deepEqual(await searchHybridKnowledge("고소작업 추락", "", directory, AbortSignal.timeout(5000), index), []);
  await processValidationQueue(directory, deps);
  const run = store.get(one[0].runId!)!; assert.equal(run.status, "published");
  assert.equal(base.list().find(doc => doc.id === original.id)!.active, false);
  assert.deepEqual(base.structures(run.localDocumentId!).map(page => [page.page, page.filePage]), [[7, 1]]);
  assert.deepEqual(base.pdf(original.id), bytes);
});

test("editing existing material during automation prevents stale replacement", async t => {
  const { directory, bytes, store, deps } = await fixture(t);
  const base = new KnowledgeBase(directory); t.after(() => base.close());
  const original = base.addImported(metadata, contentHash(bytes), bytes, [{ page: 1, text: candidate.text, method: "text", confidence: null, reviewReason: "", needsReview: false }]);
  const [enrolled] = await enqueueExisting([original.id], directory);
  const structure = base.structures(original.id)[0], edited = structuredClone(structure); edited.text += " 새 수정"; edited.blocks[0].text += " 새 수정";
  base.saveStructure(original.id, edited, JSON.stringify(structure));
  await processValidationQueue(directory, deps);
  assert.equal(store.job(enrolled.runId!)!.state, "blocked");
  assert.equal(store.get(enrolled.runId!)!.localDocumentId, undefined);
  assert.equal(base.list().find(doc => doc.id === original.id)!.active, true);
});

test("worker leases prevent two workers and recover after expiry", async t => {
  const { store } = await fixture(t); const token = store.claimWorker(1000)!;
  assert.ok(token); assert.equal(store.claimWorker(1001), undefined);
  assert.ok(store.claimWorker(602000)); store.releaseWorker(token); assert.ok(store.workerAlive(602001));
});

test("paid failures cannot exceed the three-call page ceiling", async t => {
  const { directory, bytes, store } = await fixture(t);
  const run = store.create(metadata, bytes, [1]); let calls = 0;
  const deps = { ...parser, correct: async () => { calls++; throw new Error("provider connection failure"); } };
  for (let i = 0; i < 5; i++) await checkValidationPage(run.id, 1, directory, AbortSignal.timeout(5000), deps);
  assert.equal(calls, 3); assert.equal(store.get(run.id)!.pages[0].attempts.at(-1)!.errorCode, "PAGE_CALL_LIMIT");
  assert.equal(store.get(run.id)!.pages[0].attempts.reduce((sum, a) => sum + (a.calls ?? 0), 0), 3);
});

test("manual restart resets the transient retry window without clearing past paid calls", async t => {
  const { directory, bytes, store, deps } = await fixture(t);
  const run = store.create(metadata, bytes, [1]);
  const token = store.claim(run.id);
  run.pages[0].status = "held";
  run.pages[0].attempts = Array.from({ length: 3 }, () => ({ at: "2020-01-01T00:00:00.000Z", reasons: ["old parse failure"], errorCode: "CHECK_FAILED", calls: 0 }));
  store.save(run, token); store.release(run.id, token); store.enqueue(run.id);
  let tries = 0;
  deps.check = (id, page, dir, signal) => checkValidationPage(id, page, dir, signal, { ...parser, parse: async (...args) => {
    if (++tries === 1) throw new Error("temporary parse problem");
    return parser.parse(...args);
  } });
  await processValidationQueue(directory, deps);
  assert.equal(store.job(run.id)!.state, "waiting");
  await processValidationQueue(directory, deps, store.job(run.id)!.nextAt);
  assert.equal(store.job(run.id)!.state, "complete");
  assert.equal(store.get(run.id)!.pages[0].attempts.length, 5);
});

test("three failed responses skip the page with its history and complete an all-failed run without publishing", async t => {
  const { directory, bytes, store, deps } = await fixture(t);
  const run = store.create(metadata, bytes, [1]); store.enqueue(run.id);
  deps.check = (id, page, dir, signal) => checkValidationPage(id, page, dir, signal, { ...parser, correct: async () => { throw new GenerationError("INVALID_OUTPUT"); } });
  for (let i = 0; i < 3; i++) await processValidationQueue(directory, deps, Math.max(Date.now(), store.job(run.id)!.nextAt));
  assert.equal(store.job(run.id)!.state, "complete");
  assert.match(store.job(run.id)!.reason, /판독 실패로 건너뜀 1쪽/);
  assert.equal(store.get(run.id)!.pages[0].status, "skipped");
  assert.equal(store.get(run.id)!.pages[0].skippedFailure?.reason, store.get(run.id)!.pages[0].attempts.at(-1)!.reasons[0]);
  assert.equal(store.get(run.id)!.localDocumentId, undefined);
  assert.equal(store.get(run.id)!.pages[0].attempts.reduce((sum, a) => sum + (a.calls ?? 0), 0), 3);
});

test("failed pages never enter search and the following page publishes with its original page number", async t => {
  const { directory, bytes, store, deps, index } = await fixture(t, 2);
  const run = store.create(metadata, bytes, [1, 2]); store.enqueue(run.id);
  const calls: number[] = [];
  deps.check = (id, page, dir, signal) => checkValidationPage(id, page, dir, signal, { ...parser, correct: async () => {
    calls.push(page); if (page === 1) throw new GenerationError("INVALID_OUTPUT"); return structuredClone(candidate);
  } });
  for (let i = 0; i < 4; i++) await processValidationQueue(directory, deps, Math.max(Date.now(), store.job(run.id)!.nextAt));
  assert.deepEqual(calls, [1, 1, 1, 2]);
  const result = store.get(run.id)!;
  assert.equal(result.status, "published"); assert.equal(store.job(run.id)!.state, "complete");
  assert.deepEqual(result.pages.map(page => page.status), ["skipped", "processed"]);
  assert.equal(validationCounts(result).passed, 1); assert.equal(validationCounts(result).exceptions, 1);
  const base = new KnowledgeBase(directory);
  try {
    assert.deepEqual(base.structures(result.localDocumentId!).map(page => [page.page, page.filePage]), [[2, 1]]);
    assert.equal((await PDFDocument.load(base.pdf(result.localDocumentId!)!)).getPageCount(), 1);
  } finally { base.close(); }
  assert.deepEqual(store.pdf(run.id), bytes);
  const results = await searchHybridKnowledge("고소작업 추락", "", directory, AbortSignal.timeout(5000), index);
  assert.ok(results.length);
  assert.ok(results.every(result => result.page === 2));
});

test("resuming a legacy exhausted page skips it before checking paid capacity", async t => {
  const { directory, bytes, store, deps } = await fixture(t, 2);
  const run = store.create(metadata, bytes, [1, 2]), token = store.claim(run.id);
  run.pages[0].status = "held";
  run.pages[0].attempts = Array.from({ length: 3 }, () => ({ at: "2020-01-01T00:00:00.000Z", reasons: ["표 구조 오류"], errorCode: "INVALID_OUTPUT", calls: 1, policy: "single-pass" as const }));
  store.save(run, token); store.release(run.id, token); store.enqueue(run.id);
  deps.availability = () => { assert.fail("exhausted pages must not check paid capacity"); };
  deps.check = async () => { assert.fail("exhausted pages must not make another call"); };
  await processValidationQueue(directory, deps);
  assert.equal(store.get(run.id)!.pages[0].status, "skipped");
  assert.equal(store.get(run.id)!.pages[0].attempts.length, 3);
  assert.equal(store.job(run.id)!.state, "queued");
});

test("budget failures are never treated as unreadable pages", async t => {
  const { directory, bytes, store, deps } = await fixture(t);
  const run = store.create(metadata, bytes, [1]); store.enqueue(run.id);
  deps.check = (id, page, dir, signal) => checkValidationPage(id, page, dir, signal, { ...parser, correct: async () => { throw new GenerationError("BUDGET_EXCEEDED"); } });
  for (let i = 0; i < 4; i++) await processValidationQueue(directory, deps, Math.max(Date.now(), store.job(run.id)!.nextAt));
  assert.equal(store.get(run.id)!.pages[0].status, "held");
  assert.equal(store.get(run.id)!.pages[0].skippedFailure, undefined);
  assert.equal(store.job(run.id)!.state, "waiting");
});

test("truncated page output and token-limit failures also stop after three attempts", async t => {
  for (const code of ["OUTPUT_TRUNCATED", "TOKEN_LIMIT_EXCEEDED"] as const) await t.test(code, async t => {
    const { directory, bytes, store, deps } = await fixture(t);
    const run = store.create(metadata, bytes, [1]); store.enqueue(run.id); let tries = 0;
    deps.check = (id, page, dir, signal) => checkValidationPage(id, page, dir, signal, { ...parser, correct: async () => { tries++; throw new GenerationError(code); } });
    for (let i = 0; i < 3; i++) await processValidationQueue(directory, deps, Math.max(Date.now(), store.job(run.id)!.nextAt));
    assert.equal(tries, 3); assert.equal(store.get(run.id)!.pages[0].status, "skipped");
    assert.equal(store.job(run.id)!.state, "complete");
  });
});


test("existing explicitly excluded pages stay outside automatic processing", async t => {
  const { directory, bytes } = await fixture(t);
  const base = new KnowledgeBase(directory); t.after(() => base.close());
  const doc = base.addImported(metadata, contentHash(bytes), bytes, [{ page: 1, text: candidate.text, method: "ocr", confidence: null,
    reviewReason: "old exclusion", needsReview: true }]);
  assert.ok(base.resolvePage(doc.id, 1, "exclude"));
  const [result] = await enqueueExisting([doc.id], directory);
  assert.equal(result.runId, undefined); assert.ok(result.error);
  assert.equal(base.reviewPages(doc.id)[0].status, "excluded");
});
