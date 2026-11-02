import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeBase } from "./server/knowledge-base";
import { ValidationStore } from "./server/knowledge-validation-store";
import { LocalSearchIndex } from "./server/knowledge-local-index";
import { snapshotDemoKnowledge } from "./server/demo-package";
import { generateDemo, sample, defaults } from "./storyboard";
import { serializeDraft, readDraft, DRAFT_STORAGE_KEY } from "./studio-state";
import { exportWorkPackage, importWorkPackage } from "./work-package-browser";
import { parseWorkPackage } from "./work-package";
import { POST } from "../app/api/demo/work/route";

const metadata = { title: "지게차 작업안전", origin: "official" as const, url: "https://example.com/guide", published: "2026", revision: "초판" };

test("demo snapshots preserve source IDs and vector search after moving directories, excluding credentials", async () => {
  const parent = mkdtempSync(join(tmpdir(), "eduflow-portable-test-"));
  const source = join(parent, "sender"), target = join(parent, "receiver");
  try {
    const base = new KnowledgeBase(source);
    const document = base.add({ ...metadata, text: "지게차 작업 전 주변과 이동 경로를 확인하고 작업자 접근을 통제합니다. ".repeat(6) }); base.close();
    const signal = AbortSignal.timeout(10000), embed = async () => [1, 0, 0];
    const index = new LocalSearchIndex(source, embed);
    const remote = await index.create("지게차", signal);
    const chunk = await index.addChunk(remote, "지게차 작업 전 주변을 확인합니다.", signal); await index.enabled(remote, true, signal);
    const store = new ValidationStore(source);
    const run = store.create(metadata, Buffer.from("original-pdf-bytes"), [1]);
    const token = store.claim(run.id);
    run.backendIdentity = index.identity; run.status = "published"; run.localDocumentId = document.id; run.remoteDocumentId = remote;
    run.remoteChunks = [{ id: chunk, page: 1, text: "지게차 작업 전 주변을 확인합니다.", blockIds: ["block-1"], structureHash: "keep-hash" }];
    store.save(run, token); store.release(run.id, token);
    store.putJob({ runId: run.id, state: "queued", updatedAt: new Date().toISOString(), nextAt: 1, reason: "pending" }); store.close();
    writeFileSync(join(source, "connection.json"), '{"openaiKey":"DO-NOT-EXPORT"}');
    writeFileSync(join(source, ".env.local"), "SECRET=DO-NOT-EXPORT");
    writeFileSync(join(source, "ai-budget.sqlite"), "DO-NOT-EXPORT");
    const result = await snapshotDemoKnowledge(source, target);
    assert.equal(result.documents, 1);
    assert.deepEqual(readdirSync(target).sort(), ["knowledge-validation.sqlite", "knowledge-vectors.sqlite", "knowledge.sqlite", "search-portability.json"]);
    const restored = new KnowledgeBase(target); assert.equal(restored.list()[0].id, document.id); restored.close();
    const moved = new LocalSearchIndex(target, embed); assert.equal(moved.identity, index.identity);
    assert.equal((await moved.retrieve("지게차", [remote], signal))[0].id, chunk);
    const validation = new ValidationStore(target);
    assert.deepEqual(validation.get(run.id)?.remoteChunks, run.remoteChunks);
    assert.equal(validation.job(run.id)?.state, "paused");
    assert.equal(validation.pdf(run.id).toString(), "original-pdf-bytes"); validation.close();
    const original = new ValidationStore(source); assert.equal(original.job(run.id)?.state, "queued"); original.close();
    const portability = JSON.parse(readFileSync(join(target, "search-portability.json"), "utf8"));
    assert.ok(!JSON.stringify(portability).includes(source));
    portability.revision = "wrong-model"; writeFileSync(join(target, "search-portability.json"), JSON.stringify(portability));
    assert.throws(() => new LocalSearchIndex(target), /모델 버전/);
    await assert.rejects(snapshotDemoKnowledge(source, target), /빈 폴더/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("a live validation operation blocks packaging without modifying the sender", async () => {
  const parent = mkdtempSync(join(tmpdir(), "eduflow-busy-test-"));
  try {
    const source = join(parent, "sender"), target = join(parent, "receiver"); new KnowledgeBase(source).close();
    const store = new ValidationStore(source), run = store.create(metadata, Buffer.from("pdf"), [1]);
    const token = store.claim(run.id);
    await assert.rejects(snapshotDemoKnowledge(source, target), /처리 중/);
    assert.ok(!existsSync(target)); store.release(run.id, token); store.close();
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

function memoryStorage(initial?: string) {
  const values = new Map(initial ? [[DRAFT_STORAGE_KEY, initial]] : []), images = new Map<string, Blob>(), pdfs = new Map<string, Blob>();
  return { values, images, pdfs, storage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } },
    loadPdf: async (id: string) => pdfs.get(id), savePdf: async (id: string, blob: Blob) => { pdfs.set(id, blob); return id; }, deletePdf: async (id: string) => { pdfs.delete(id); return undefined; },
    loadSceneImage: async (id: string) => images.get(id), saveSceneImage: async (id: string, blob: Blob) => { images.set(id, blob); }, deleteSceneImage: async (id: string) => { images.delete(id); } };
}
test("work packages preserve current board links, decisions, selected PDF and image bytes and restore with new IDs", async () => {
  const board = generateDemo(sample, defaults); board.scenes = [board.scenes[0]];
  board.scenes[0].image = { id: "original-image", sourceType: "upload", sourceText: "원본" };
  board.scenes[0].memo = "사용자가 남긴 메모";
  board.scenes[0].visualPlacements = [];
  board.scenes[0].grounding = { status: "review_required", links: [{ referenceId: "knowledge:retained:1", field: "narration", sentence: "작업 전 확인합니다.", start: 0, end: 10, quote: "작업 전 점검", reason: "공통 원칙 활용", value: "explanation", applicability: "transfer", review: "accepted", transfer: { sourceScope: "트레일러", targetScope: "지게차", principle: "작업 전 점검", conditions: "적용 범위 확인" } }], decisions: [{ referenceId: "knowledge:retained:1", field: "visual", sentence: "확인 장면", quote: "점검", reason: "행동 묘사 없음", status: "deferred", sourceTitle: "원문", page: 2, used: true }] };
  const fileId = "f439ae46-8833-4a2d-821c-8465d09bce05";
  const original = serializeDraft({ manuscript: sample, settings: defaults, board, document: { name: "원고.pdf", kind: "pdf", fileId, pages: 10, selectedPages: [4, 7], text: "", query: "" } });
  const sender = memoryStorage(original);
  sender.images.set("original-image", new Blob(["image-bytes"], { type: "image/png" })); sender.pdfs.set(fileId, new Blob(["selected-pdf"], { type: "application/pdf" }));
  const raw = await exportWorkPackage(sender), receiver = memoryStorage(original);
  receiver.images.set("original-image", new Blob(["receiver-original-image"]));
  await importWorkPackage(raw, receiver);
  const restored = readDraft(receiver.values.get(DRAFT_STORAGE_KEY)!);
  assert.notEqual(restored.board!.scenes[0].image!.id, "original-image");
  assert.notEqual(restored.document!.fileId, fileId);
  assert.equal(await receiver.images.get(restored.board!.scenes[0].image!.id)!.text(), "image-bytes");
  assert.equal(await receiver.pdfs.get(restored.document!.fileId!)!.text(), "selected-pdf");
  assert.equal(await receiver.images.get("original-image")!.text(), "receiver-original-image");
  assert.equal(receiver.values.get("eduflow-before-work-import"), original);
  restored.board!.scenes[0].image!.id = "original-image"; restored.document!.fileId = fileId;
  assert.deepEqual(restored, readDraft(original));
  const invalid = JSON.parse(raw); invalid.pdf.sha256 = "0".repeat(64);
  const previous = receiver.values.get(DRAFT_STORAGE_KEY), before = receiver.images.size;
  await assert.rejects(importWorkPackage(JSON.stringify(invalid), receiver), /손상/);
  assert.equal(receiver.values.get(DRAFT_STORAGE_KEY), previous); assert.equal(receiver.images.size, before);
  const missing = JSON.parse(raw); missing.images = []; assert.throws(() => parseWorkPackage(JSON.stringify(missing)), /이미지/);
});

test("demo work endpoint rejects cross-origin access and oversized payloads before touching data", async () => {
  const url = "http://127.0.0.1:3000/api/demo/work";
  const headers = { "Content-Type": "application/json", Origin: "https://external.example" };
  assert.equal((await POST(new Request(url, { method: "POST", headers, body: "{}" }))).status, 403);
  assert.equal((await POST(new Request(url, { method: "POST", headers: { ...headers, Origin: "http://127.0.0.1:3000", "Content-Length": "999999999" }, body: "{}" }))).status, 413);
});
