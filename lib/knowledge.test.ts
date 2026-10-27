import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { chunkKnowledge } from "./knowledge";
import { KnowledgeBase } from "./server/knowledge-base";
import { addKnowledge, listKnowledge, recheckKnowledge, searchKnowledgeRequest, updateKnowledge } from "./server/knowledge-handler";
import { listKnowledgeReview, readKnowledgePdf, renderKnowledgePage, reviewKnowledgePage } from "./server/knowledge-handler";
import { analyzeKnowledgePdf } from "./server/knowledge-ingest";
import { createHash } from "node:crypto";

test("persistent knowledge index retrieves original passages with source version and PDF page", () => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-knowledge-"));
  try {
    const source = { title: "고소작업 예방 지침", origin: "official" as const,
      url: "https://example.org/source", published: "2026-10-01", revision: "2판",
      text: "[PDF 1페이지]\n\n고소작업은 높은 곳에서 이루어지는 작업입니다.\n\n[PDF 2페이지]\n\n추락 위험을 막기 위해 개구부의 안전난간과 추락방호망을 확인합니다. 안전대 부착설비도 점검합니다." };
    const first = new KnowledgeBase(directory);
    const document = first.add(source);
    assert.equal(document.chunks, 2);
    assert.throws(() => first.add(source), /KNOWLEDGE_DUPLICATE/);
    first.close();

    const reopened = new KnowledgeBase(directory);
    const hits = reopened.search("고소작업 중 추락 위험이 있습니다. 개구부 안전난간과 작업발판을 확인합니다.");
    assert.ok(hits.some((hit) => hit.documentId === document.id && hit.page === 2));
    assert.ok(hits.some((hit) => hit.excerpt.includes("추락방호망") && hit.revision === "2판"));
    assert.deepEqual(reopened.search("탄소중립과 전기 사용"), []);
    assert.deepEqual(reopened.search("화기작업 안전 교육. 용접과 용단 중 불티와 가연물을 확인합니다. 작업자는 작업 전 상태를 확인합니다.", 6, "화기작업"), []);
    assert.equal(reopened.setActive(document.id, false), true);
    assert.deepEqual(reopened.search("추락방호망과 안전난간"), []);
    assert.equal(reopened.list()[0].active, false);
    reopened.setActive(document.id, true);
    assert.ok(reopened.search("추락방호망과 안전난간").length);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("chunking never merges two original PDF pages", () => {
  assert.deepEqual(chunkKnowledge("[PDF 3페이지]\n\n첫 페이지 내용입니다.\n\n[PDF 5페이지]\n\n두 번째 페이지 내용입니다.")
    .map(({ page }) => page), [3, 5]);
});

test("local knowledge API registers, searches and reversibly excludes a source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-knowledge-api-"));
  const url = "http://localhost:3001/api/knowledge";
  const headers = { Origin: "http://localhost:3001", Host: "localhost:3001" };
  try {
    const data = new FormData();
    data.set("title", "밀폐공간 안전 가이드"); data.set("origin", "official");
    data.set("url", "https://example.org/confined-space");
    data.set("published", "2026-10-01");
    data.set("text", "밀폐공간 작업 전에는 산소 및 유해가스 농도를 측정합니다. 충분히 환기하고 송기마스크 등 호흡보호구의 착용 상태를 확인합니다.");
    const denied = await addKnowledge(new Request(url, { method: "POST", body: data }), directory);
    assert.equal(denied.status, 403);
    const added = await addKnowledge(new Request(url, { method: "POST", headers, body: data }), directory);
    assert.equal(added.status, 201);
    const id = (await added.json()).document.id;
    const listed = await listKnowledge(new Request(url), directory);
    assert.equal((await listed.json()).documents[0].id, id);
    const search = () => searchKnowledgeRequest(new Request(`${url}/search`, { method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "밀폐공간에서 질식 사고가 날 수 있습니다. 산소 농도와 환기 상태를 확인합니다." }) }), directory);
    assert.ok((await (await search()).json()).references.some((reference: { documentId: string }) => reference.documentId === id));
    const changed = await updateKnowledge(new Request(url, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id, active: false }) }), directory);
    assert.equal(changed.status, 200);
    assert.deepEqual((await (await search()).json()).references, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("large PDF registration can index selected original pages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-knowledge-pages-"));
  try {
    const pdf = await PDFDocument.create();
    for (const text of ["unrelated introduction", "Fall protection anchorage inspection before elevated work", "unrelated conclusion"])
      pdf.addPage().drawText(text);
    const data = new FormData();
    data.set("title", "Height work manual"); data.set("origin", "official");
    data.set("url", "https://example.org/height.pdf"); data.set("pdfPages", "2");
    data.set("file", new File([Buffer.from(await pdf.save())], "height.pdf", { type: "application/pdf" }));
    const response = await addKnowledge(new Request("http://localhost:3001/api/knowledge", {
      method: "POST", headers: { Origin: "http://localhost:3001", Host: "localhost:3001" }, body: data,
    }), directory);
    assert.equal(response.status, 201);
    const base = new KnowledgeBase(directory);
    assert.equal(base.search("Fall protection anchorage inspection")[0]?.page, 2);
    assert.ok(base.search("Fall protection anchorage inspection").every((hit) => !hit.excerpt.includes("unrelated")));
    base.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("uncertain OCR page stays outside search until the user approves its extracted text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-knowledge-review-"));
  const headers = { Origin: "http://localhost:3001", Host: "localhost:3001" };
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("Fall protection anchorage inspection before elevated work begins");
    pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const analyzed = await analyzeKnowledgePdf(bytes, "", new AbortController().signal,
      async () => ({ recognize: async () => ({ text: "Confined space requires oxygen measurement before work begins", confidence: 61 }), close: async () => {} }));
    assert.equal(analyzed.pages[0].needsReview, false);
    assert.equal(analyzed.pages[1].needsReview, true);
    const base = new KnowledgeBase(directory);
    const document = base.addImported({ title: "Safety manual", origin: "official", url: "https://example.org/manual",
      published: "2026", revision: "1" }, createHash("sha256").update(bytes).digest("hex"), bytes, analyzed.pages);
    assert.equal(document.pendingPages, 1);
    assert.ok(base.search("Fall protection anchorage inspection").length);
    assert.deepEqual(base.search("Confined space requires oxygen measurement"), []);
    base.close();
    const review = await listKnowledgeReview(new Request(`http://localhost:3001/api/knowledge/review?id=${document.id}`), directory);
    assert.equal((await review.json()).pages[0].status, "pending");
    const original = await readKnowledgePdf(new Request(`http://localhost:3001/api/knowledge/file?id=${document.id}`), directory);
    assert.equal(original.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await original.arrayBuffer()), bytes), 0);
    const image = await renderKnowledgePage(new Request(`http://localhost:3001/api/knowledge/page?id=${document.id}&page=2`), directory);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await image.arrayBuffer()).subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
    const approved = await reviewKnowledgePage(new Request("http://localhost:3001/api/knowledge/review", { method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ id: document.id, page: 2, action: "approve", text: "Confined space requires oxygen measurement before work begins" }),
    }), directory);
    assert.equal(approved.status, 200);
    const reopened = new KnowledgeBase(directory);
    assert.equal(reopened.list()[0].pendingPages, 0);
    assert.equal(reopened.search("Confined space requires oxygen measurement")[0]?.page, 2);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("clear table cells are indexed with their row and column positions", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  for (const x of [40, 240, 440]) page.drawLine({ start: { x, y: 500 }, end: { x, y: 700 } });
  for (const y of [500, 600, 700]) page.drawLine({ start: { x: 40, y }, end: { x: 440, y } });
  page.drawText("Hazard", { x: 50, y: 650 });
  page.drawText("Control", { x: 250, y: 650 });
  page.drawText("Falling from height", { x: 50, y: 550 });
  page.drawText("Use guardrails and harness", { x: 250, y: 550 });
  const analyzed = await analyzeKnowledgePdf(Buffer.from(await pdf.save()), "", new AbortController().signal,
    async () => { throw new Error("OCR must not run on a readable table"); });
  assert.equal(analyzed.pages[0].needsReview, false);
  assert.match(analyzed.pages[0].text, /행 2 \| 열 1: Falling from height \| 열 2: Use guardrails and harness/);
});

test("a previously pending page can be rechecked and indexed without manual approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-knowledge-recheck-"));
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("Fall protection anchorage inspection before elevated work begins");
    pdf.addPage().drawText("Confined space oxygen measurement before entry begins");
    const bytes = Buffer.from(await pdf.save());
    const base = new KnowledgeBase(directory);
    const document = base.addImported({ title: "Earlier manual", origin: "official", url: "https://example.org/manual",
      published: "", revision: "" }, createHash("sha256").update(bytes).digest("hex"), bytes,
    [{ page: 1, text: "Earlier uncertain extraction", method: "ocr", confidence: 50,
      reviewReason: "글자 판독이 불확실합니다.", needsReview: true },
    { page: 2, text: "Earlier uncertain extraction", method: "ocr", confidence: 50,
      reviewReason: "글자 판독이 불확실합니다.", needsReview: true }]);
    assert.deepEqual(base.search("Fall protection anchorage inspection"), []);
    base.resolvePage(document.id, 2, "approve", "Confined space oxygen measurement before entry begins");
    base.close();
    const response = await recheckKnowledge(new Request("http://localhost:3001/api/knowledge/recheck", {
      method: "POST", headers: { Origin: "http://localhost:3001", Host: "localhost:3001", "Content-Type": "application/json" },
      body: JSON.stringify({ id: document.id }),
    }), directory);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { autoIndexed: 1, pendingPages: 0 });
    const reopened = new KnowledgeBase(directory);
    assert.equal(reopened.reviewPages(document.id)[0].status, "auto_indexed");
    assert.equal(reopened.reviewPages(document.id)[1].status, "approved");
    assert.equal(reopened.search("Fall protection anchorage inspection")[0]?.page, 1);
    assert.equal(reopened.search("Confined space oxygen measurement")[0]?.page, 2);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
