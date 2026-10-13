import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { convertPresentation, runOfficeConversion } from "./server/presentation-import";
import { DocumentImportError, importDocumentRequest } from "./server/document-import";
import { readDocumentUpload } from "./document-upload";
import { pdfSourceSchema, selectPdfPages, sourceNote } from "./pdf-source";
import { readPdfGenerationRequest } from "./server/pdf-input";
import { defaults, generateDemo, markdown, sample, csv } from "./storyboard";
import { readDraft, serializeDraft } from "./studio-state";

const pptHeader = Buffer.from("d0cf11e0a1b11ae1", "hex");
const signal = () => new AbortController().signal;
const fixture = () => readFile(new URL("./fixtures/slide-selection.pptx", import.meta.url));
async function pdfBytes(pages: number) {
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= pages; page++) pdf.addPage([400, 300]).drawText(`SLIDE ${page}`);
  return Buffer.from(await pdf.save());
}
const request = (name: string, data: Buffer, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/documents", {
  method: "POST", headers: { origin, "x-document-name": encodeURIComponent(name) }, body: new Uint8Array(data),
});

test("PPT conversion uses a private profile, includes hidden slides, omits notes and removes temporary files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-ppt-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const conversions = join(root, "conversions"), font = join(root, "fallback.ttf");
  await mkdir(conversions);
  await writeFile(font, "LOCAL FONT TEST BYTES");
  const pdf = await pdfBytes(3);
  const converted = await convertPresentation("안전교육.PPTX", await fixture(), signal(), { binary: "test-converter", tempRoot: conversions, fontFiles: [font], run: async (binary, args) => {
    assert.equal(binary, "test-converter");
    assert.ok(args.includes("--headless"));
    const directory = join(conversions, (await readdir(conversions))[0]);
    assert.match(await readFile(join(directory, "profile/user/registrymodifications.xcu"), "utf8"), /MacroSecurityLevel.*<value>3<\/value>/);
    assert.deepEqual(await readFile(join(directory, "profile/user/fonts/font-0.ttf")), await readFile(font));
    assert.deepEqual(await readFile(args.at(-1)!), await fixture());
    const filter = JSON.parse(args[args.indexOf("--convert-to") + 1].replace("pdf:impress_pdf_Export:", ""));
    assert.equal(filter.ExportHiddenSlides.value, "true");
    assert.equal(filter.ExportNotesPages.value, "false");
    assert.equal(filter.IsAddStream.value, "false");
    await writeFile(join(args[args.indexOf("--outdir") + 1], "source.pdf"), pdf);
  } });
  assert.deepEqual(converted, { pdf, pages: 3 });
  assert.deepEqual(await readdir(conversions), []);
});

test("invalid, encrypted, oversized and mismatched presentations fail without leaking file contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-ppt-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const options = { binary: "test-converter", tempRoot: root, fontFiles: [], run: async (_: string, args: string[]) => {
    calls++;
    await writeFile(join(args[args.indexOf("--outdir") + 1], "source.pdf"), await pdfBytes(2));
  } };
  for (const [name, data] of [["bad.ppt", Buffer.from("PRIVATE INVALID DATA")], ["bad.pptx", pptHeader], ["empty.pptx", Buffer.alloc(0)], ["wrong.txt", pptHeader]] as const)
    await assert.rejects(convertPresentation(name, data, signal(), options), (e: unknown) => e instanceof DocumentImportError && !e.message.includes("PRIVATE"));
  const archive = await fixture();
  const expanded = Buffer.from(archive), central = archive.readUInt32LE(archive.length - 6);
  expanded.writeUInt32LE(31 * 1024 * 1024, central + 24);
  await assert.rejects(convertPresentation("large.pptx", expanded, signal(), options), (e: unknown) => e instanceof DocumentImportError && e.status === 413);
  assert.equal(calls, 0);
  await assert.rejects(convertPresentation("mismatch.pptx", archive, signal(), options), /슬라이드 수가 원본과 다릅니다/);
  assert.deepEqual(await readdir(root), []);
});

test("conversion failure and cancellation clean temporary data and release the conversion lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-ppt-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(convertPresentation("test.ppt", pptHeader, signal(), { binary: "fake", tempRoot: root, fontFiles: [], run: async () => { throw new Error("PRIVATE PATH"); } }), (e: unknown) => e instanceof DocumentImportError && !e.message.includes("PRIVATE"));
  const controller = new AbortController();
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const operation = convertPresentation("test.ppt", pptHeader, controller.signal, { binary: "fake", tempRoot: root, fontFiles: [], run: async (_, __, abort) => {
    started();
    await new Promise((_, reject) => abort.addEventListener("abort", () => reject(abort.reason), { once: true }));
  } });
  await waiting;
  await assert.rejects(convertPresentation("other.ppt", pptHeader, signal()), (e: unknown) => e instanceof DocumentImportError && e.status === 429);
  controller.abort();
  await assert.rejects(operation, (e: unknown) => e instanceof DocumentImportError && e.status === 499);
  assert.deepEqual(await readdir(root), []);
});

test("converter process honours timeout, cancellation and a missing executable", async () => {
  const args = ["-e", "setInterval(() => {}, 1000)"];
  await assert.rejects(runOfficeConversion(process.execPath, args, signal(), 40), (e: unknown) => e instanceof DocumentImportError && e.status === 408);
  const controller = new AbortController();
  const operation = runOfficeConversion(process.execPath, args, controller.signal);
  controller.abort(new Error("cancel-test"));
  await assert.rejects(operation, /cancel-test/);
  await assert.rejects(runOfficeConversion("/nonexistent/eduflow-converter", [], signal()));
});

test("unavailable conversion tool gives PDF fallback guidance without creating temporary files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-ppt-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.EDUFLOW_OFFICE_CONVERTER_PATH;
  process.env.EDUFLOW_OFFICE_CONVERTER_PATH = "/nonexistent/eduflow-soffice";
  try {
    await assert.rejects(convertPresentation("test.ppt", pptHeader, signal(), { tempRoot: root }), (e: unknown) => e instanceof DocumentImportError && e.status === 503 && e.message.includes("PDF로 저장"));
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previous === undefined) delete process.env.EDUFLOW_OFFICE_CONVERTER_PATH;
    else process.env.EDUFLOW_OFFICE_CONVERTER_PATH = previous;
  }
});

test("presentation upload checks origin before converting and returns PDF bytes without caching", async () => {
  let calls = 0;
  const pdf = await pdfBytes(3);
  const converter = async () => { calls++; return { pdf, pages: 3 }; };
  const blocked = await importDocumentRequest(request("교육.pptx", await fixture(), "https://elsewhere.example"), converter);
  assert.equal(blocked.status, 403); assert.equal(calls, 0);
  const response = await importDocumentRequest(request("교육.pptx", await fixture()), converter);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/pdf");
  const { document, pdf: file } = await readDocumentUpload(response, new File([await fixture()], "교육.pptx"));
  assert.equal(document.name, "교육.pptx"); assert.equal(document.pages, 3); assert.equal(document.kind, "pdf");
  assert.deepEqual(document.selectedPages, []);
  assert.equal(file?.type, "application/pdf");
  assert.deepEqual(Buffer.from(await file!.arrayBuffer()), pdf);
  await assert.rejects(readDocumentUpload(Response.json({ error: "변환 도구 없음" }, { status: 503 }), new File([], "교육.pptx")), /변환 도구 없음/);
});

test("selected PPT slides keep original numbers through generation input, draft recovery and exports", async () => {
  const selected = await selectPdfPages(await pdfBytes(3), [2]);
  const input = { manuscript: "", settings: defaults, pdfSource: { name: "교육.PPTX", pages: [2] }, sourceRequest: "표를 설명해 주세요" };
  assert.ok(pdfSourceSchema.safeParse(input.pdfSource).success);
  const form = new FormData();
  form.set("input", JSON.stringify(input));
  form.set("pdf", new Blob([new Uint8Array(selected)], { type: "application/pdf" }), "selected-pages.pdf");
  const parsed = await readPdfGenerationRequest(new Request("http://localhost:3000/api/generate", { method: "POST", body: form }));
  assert.deepEqual(parsed.input.pdfSource, input.pdfSource);
  assert.equal((await PDFDocument.load(parsed.pdf.data)).getPageCount(), 1);
  const parser = new PDFParse({ data: parsed.pdf.data, isEvalSupported: false });
  try {
    const text = (await parser.getText()).text;
    assert.match(text, /SLIDE 2/); assert.doesNotMatch(text, /SLIDE [13]/);
  } finally { await parser.destroy(); }
  const document = { name: "교육.PPTX", kind: "pdf" as const, pages: 3, text: "", query: "", selectedPages: [2], fileId: crypto.randomUUID() };
  const board = { ...generateDemo(sample, defaults), pdfSource: input.pdfSource };
  board.scenes[0].pdfSource = input.pdfSource;
  const draft = { manuscript: "", settings: defaults, board, document };
  assert.deepEqual(readDraft(serializeDraft(draft)), draft);
  assert.match(markdown(board), /원본 PPT: 교육.PPTX\n선택 슬라이드: 2/);
  assert.ok(csv(board).includes('"교육.PPTX","2"'));
  assert.match(sourceNote({ name: "old.pdf", pages: [1] }), /원본 PDF: old.pdf\n선택 페이지: 1/);
});
