import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { audienceOptions, defaults, generateDemo, sample } from "./storyboard";
import { documentTopic, findDocumentExcerpt, MAX_DOCUMENT_CHARS } from "./documents";
import { DocumentImportError, extractDocument, importDocumentRequest } from "./server/document-import";
import { captureGeneration, readDraft, serializeDraft } from "./studio-state";
import { generationTask } from "./generation-contract";

const fixture = (extension: string) => readFileSync(new URL(`./fixtures/source-document.${extension}`, import.meta.url));
const scope = "올려둔 PDF 파일에서 산업안전수칙 부분 제작하고싶어";

function largePdf() {
  const pdf = fixture("pdf");
  const xref = Number(pdf.toString("latin1").match(/startxref\s+(\d+)\s+%%EOF/)?.[1]);
  assert.ok(xref > 0);
  const comment = Buffer.alloc(11 * 1024 * 1024, 0x20);
  comment[0] = 0x25;
  comment[comment.length - 1] = 0x0a;
  const trailer = pdf.subarray(xref).toString("latin1").replace(/startxref\s+\d+/, `startxref\n${xref + comment.length}`);
  return Buffer.concat([pdf.subarray(0, xref), comment, Buffer.from(trailer, "latin1")]);
}

// Add a stored media part without changing any of the original document parts.
function docxWithLargeMedia() {
  const docx = fixture("docx"), end = Buffer.from(docx.subarray(-22));
  const centralOffset = end.readUInt32LE(16);
  const name = Buffer.from("word/media/upload-test.bin");
  const media = Buffer.alloc(31 * 1024 * 1024);
  const checksum = crc32(media);
  const local = Buffer.alloc(30), central = Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(media.length, 18);
  local.writeUInt32LE(media.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(media.length, 20);
  central.writeUInt32LE(media.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(centralOffset, 42);
  end.writeUInt16LE(end.readUInt16LE(8) + 1, 8);
  end.writeUInt16LE(end.readUInt16LE(10) + 1, 10);
  end.writeUInt32LE(end.readUInt32LE(12) + central.length + name.length, 12);
  end.writeUInt32LE(centralOffset + local.length + name.length + media.length, 16);
  return Buffer.concat([docx.subarray(0, centralOffset), local, name, media, docx.subarray(centralOffset, -22), central, name, end]);
}

test("PDF and Word text extraction supports Korean section requests and excludes unrelated sections", async () => {
  for (const extension of ["pdf", "docx"]) {
    const document = await extractDocument(`테스트.${extension}`, fixture(extension));
    assert.ok(document.text.includes("산업안전수칙"));
    const { excerpt, topic } = findDocumentExcerpt(document, scope);
    assert.equal(topic, "산업안전수칙");
    assert.ok(excerpt.includes("파일 읽기"));
    assert.ok(excerpt.includes("교육대상"));
    assert.equal(excerpt.includes("회사 소개"), false);
    assert.equal(excerpt.includes("식당"), false);
    if (extension === "pdf") { assert.equal(document.pages, 1); assert.ok(excerpt.includes("[PDF 1페이지]")); }
    const source = { ...document, query: scope, appliedQuery: scope };
    const restored = readDraft(serializeDraft({ manuscript: excerpt, settings: defaults, board: null, document: source }));
    assert.deepEqual(restored.document, source);
    const input = { manuscript: excerpt, settings: defaults, sourceRequest: scope };
    const task = generationTask(captureGeneration(input, null).input);
    assert.equal(task.sourceRequest, scope);
    assert.equal(task.manuscript, excerpt);
    assert.equal(task.manuscript.includes("식당"), false);
    assert.ok(task.sourceSentences.every((sentence) => !sentence.text.includes("[PDF")));
    assert.ok(generateDemo(excerpt, defaults).scenes.every((scene) => !scene.narration.includes("[PDF")));
  }
});

test("long documents can be searched without truncation; missing and oversized sections stop", () => {
  const document = { name: "긴문서.txt", query: "", text: `${"다른 주제의 설명입니다. ".repeat(3000)}\n\n산업안전수칙\n\n${"파일 기능 확인 예시입니다. ".repeat(15)}\n\n다음 항목\n\n다른 내용입니다.` };
  assert.ok(document.text.length > 20000);
  assert.ok(findDocumentExcerpt(document, scope).excerpt.length < 20000);
  assert.throws(() => findDocumentExcerpt(document, "없는 제목 부분을 제작해줘"), /찾지 못했습니다/);
  assert.throws(() => findDocumentExcerpt(document, "a"), /두 글자/);
  assert.throws(() => findDocumentExcerpt({ ...document, text: `산업안전수칙\n\n${"설명이 아주 긴 문장입니다. ".repeat(2000)}` }, scope), /20,000자/);
  assert.equal(documentTopic('PDF에서 "산업안전수칙" 부분만 만들어줘'), "산업안전수칙");
  assert.equal(documentTopic("PDF에서 산업 안전 수칙 부분만 제작해줘"), "산업 안전 수칙");
});

test("new audience choices remove school levels and old drafts preserve their scenes", () => {
  assert.equal(audienceOptions.length, 5);
  assert.ok(audienceOptions.includes("외국인 근로자"));
  assert.equal(audienceOptions.some((value) => /초등|중등|중고등/.test(value)), false);
  for (const audience of ["초등 저학년", "중고등학생", "대학생/일반인", "실무자/전문가"] as const) {
    const board = generateDemo(sample, { ...defaults, audience });
    const restored = readDraft(JSON.stringify({ manuscript: sample, settings: board.settings, board }));
    assert.equal(restored.settings.audience, audience === "실무자/전문가" ? "산업현장 근무자" : "현장 방문자 · 일반인");
    assert.deepEqual(restored.board, board);
  }
  for (const audience of audienceOptions) {
    const task = generationTask({ manuscript: sample, settings: { ...defaults, audience } });
    assert.equal(task.settings.audience, audience);
    assert.ok(task.audienceGuidance.length);
  }
});

test("import rejects invalid files and excessive extracted text without a byte-size cap", async () => {
  for (const [name, data] of [["empty.txt", Buffer.alloc(0)], ["broken.pdf", Buffer.from("not a pdf")], ["broken.docx", Buffer.from("not a zip")], ["old.hwp", Buffer.from("text")], ["bad.txt", Buffer.from([0xff])], ["nul.txt", Buffer.from("nul\0text")]] as const)
    await assert.rejects(extractDocument(name, data), (error: unknown) => error instanceof DocumentImportError);
  await assert.rejects(extractDocument("long.txt", Buffer.from("가".repeat(MAX_DOCUMENT_CHARS + 1))), (error: unknown) => error instanceof DocumentImportError && error.status === 413);
  const txt = await extractDocument("원고.TXT", Buffer.from(sample));
  assert.equal(txt.text, sample);
});

test("large TXT and Word files keep their text, while abnormal ZIP expansion is rejected", async () => {
  const txt = await extractDocument("large.txt", Buffer.concat([Buffer.from(sample), Buffer.alloc(11 * 1024 * 1024, 0x20)]));
  assert.equal(txt.text, sample);
  const docx = await extractDocument("large.docx", docxWithLargeMedia());
  assert.equal(docx.text, (await extractDocument("small.docx", fixture("docx"))).text);
  const expanded = Buffer.from(fixture("docx"));
  const centralOffset = expanded.readUInt32LE(expanded.length - 6);
  expanded.writeUInt32LE(31 * 1024 * 1024, centralOffset + 24);
  await assert.rejects(extractDocument("abnormal.docx", expanded), (error: unknown) => error instanceof DocumentImportError && error.status === 413);
});

test("upload handler validates origin and errors without exposing parser details", async () => {
  const request = (data: Buffer, headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/documents", {
    method: "POST", headers: { origin: "http://localhost:3000", "x-document-name": encodeURIComponent("테스트.pdf"), ...headers }, body: new Uint8Array(data),
  });
  const response = await importDocumentRequest(request(fixture("pdf")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { name: "테스트.pdf", kind: "pdf", pages: 1, text: "", query: "", selectedPages: [] });
  assert.equal((await importDocumentRequest(request(Buffer.from("PRIVATE RAW CONTENT")))).status, 400);
  assert.equal((await importDocumentRequest(request(fixture("pdf"), { origin: "https://elsewhere.example" }))).status, 403);
  assert.equal((await importDocumentRequest(request(fixture("pdf"), { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).status, 200);
  assert.equal((await importDocumentRequest(request(fixture("pdf"), { "sec-fetch-site": "cross-site" }))).status, 403);
  // Both a declared large upload and a streamed body without content-length must work.
  const pdf = largePdf();
  const uploadHeaders: Record<string, string>[] = [{ "content-length": String(pdf.length) }, {}];
  for (const headers of uploadHeaders) {
    const largeResponse = await importDocumentRequest(request(pdf, headers));
    assert.equal(largeResponse.status, 200);
    assert.equal((await largeResponse.json()).pages, 1);
  }
});
