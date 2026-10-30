import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, degrees, rgb, StandardFonts } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { formatPdfPages, parsePdfPages, selectPdfPages, MAX_AI_PDF_BYTES } from "./pdf-source";
import { documentSchema } from "./documents";
import { defaults, sample, generateDemo, requestSchema, markdown } from "./storyboard";
import { captureGeneration, readDraft, serializeDraft } from "./studio-state";
import { generationTask, GenerationError } from "./generation-contract";
import { importDocumentRequest } from "./server/document-import";
import { readPdfGenerationRequest } from "./server/pdf-input";
import { createGenerateHandler } from "./server/generate-handler";
import { demoAdapter } from "./server/demo-adapter";
import { readAIConfig } from "./server/ai-config";
import { createOpenAIAdapter, OPENAI_MODEL } from "./server/openai-adapter";
import { protectPaidGeneration } from "./server/ai-protection";
import { runGeneration } from "./server/generation-service";
import { previewPdfRequest } from "./server/pdf-preview";
import { renderPdfPages } from "./server/pdf-render";
import { preparePdfInput } from "./server/prepare-pdf";

const config = readAIConfig({ EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-pdf-test-only-key", EDUFLOW_AI_MODEL: OPENAI_MODEL,
  EDUFLOW_AI_INPUT_USD_PER_MILLION: "0.75", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4.50",
  EDUFLOW_AI_REQUEST_BUDGET_USD: "0.10", EDUFLOW_AI_DAY_BUDGET_USD: "0.5", EDUFLOW_AI_MONTH_BUDGET_USD: "2" });
const input = { manuscript: "", settings: { ...defaults, minutes: 1, count: 3 }, pdfSource: { name: "visual-test.pdf", pages: [2] }, sourceRequest: "Explain the diagram without adding unseen facts." };

async function visualPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = pdf.addPage([400, 300]);
    if (i !== 2) page.drawText(`UNSELECTED PAGE ${i}`, { x: 20, y: 200, font });
    else {
      page.drawRectangle({ x: 30, y: 90, width: 100, height: 100, color: rgb(0, 0.3, 1) });
      page.drawCircle({ x: 270, y: 140, size: 50, color: rgb(1, 0.5, 0) });
      page.drawLine({ start: { x: 140, y: 140 }, end: { x: 210, y: 140 }, thickness: 3 });
    }
  }
  return pdf.save();
}
function multipart(pdf: Uint8Array, requestInput = input, origin = "http://localhost:3000") {
  const form = new FormData(); form.set("input", JSON.stringify(requestInput));
  form.set("pdf", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "selected-pages.pdf");
  return new Request("http://localhost:3000/api/generate", { method: "POST", headers: { origin }, body: form });
}
const coded = (code: string) => (e: unknown) => e instanceof GenerationError && e.code === code;

test("page ranges normalize duplicate selections and reject invalid or out-of-range pages", () => {
  assert.deepEqual(parsePdfPages("3-5, 2, 4, 8", 8), [2, 3, 4, 5, 8]);
  assert.deepEqual(parsePdfPages("", 8), []);
  assert.equal(formatPdfPages([1, 3, 5, 6, 7]), "1, 3, 5-7");
  const fullSelection = Array.from({ length: 200 }, (_, i) => i + 1);
  assert.equal(formatPdfPages(fullSelection), "1-200");
  for (const pages of [[], [2], [1, 2, 4, 6, 7, 8], fullSelection]) {
    assert.deepEqual(parsePdfPages(formatPdfPages(pages), 200), pages);
  }
  for (const range of ["0", "9", "5-3", "1,", "abc", "1-1000000"]) assert.throws(() => parsePdfPages(range, 8));
  assert.equal(requestSchema.safeParse(input).success, true);
  assert.equal(requestSchema.safeParse({ ...input, pdfSource: undefined }).success, false);
  assert.equal(requestSchema.safeParse({ ...input, pdfSource: { ...input.pdfSource, pages: [2, 2] } }).success, false);
});

test("image-only PDF upload leads to page selection; copying preserves the selected page pixels", async () => {
  const original = await visualPdf(), selected = await selectPdfPages(original, [2]);
  assert.equal((await PDFDocument.load(selected)).getPageCount(), 1);
  const source = new PDFParse({ data: new Uint8Array(original), isEvalSupported: false });
  const target = new PDFParse({ data: new Uint8Array(selected), isEvalSupported: false });
  try {
    assert.equal((await target.getText({ pageJoiner: "" })).text.trim(), "");
    const before = (await source.getScreenshot({ partial: [2], scale: 0.5 })).pages[0];
    const after = (await target.getScreenshot({ partial: [1], scale: 0.5 })).pages[0];
    assert.deepEqual(after.data, before.data);
  } finally { await source.destroy(); await target.destroy(); }
  const request = new Request("http://localhost:3000/api/documents", { method: "POST", headers: { origin: "http://localhost:3000", "x-document-name": "scan.pdf" }, body: new Uint8Array(selected) });
  const response = await importDocumentRequest(request);
  assert.equal(response.status, 200);
  const document = documentSchema.parse(await response.json());
  assert.equal(document.kind, "pdf"); assert.equal(document.pages, 1);
  assert.equal(document.text, ""); assert.deepEqual(document.selectedPages, []);
  const draft = { manuscript: "", settings: defaults, board: null, document: { ...document, selectedPages: [1], fileId: crypto.randomUUID() } };
  assert.deepEqual(readDraft(serializeDraft(draft)), draft);
  await assert.rejects(selectPdfPages(original, [4]));
});

test("multipart validation rejects missing, corrupt, mismatched and oversized PDFs before AI work", async () => {
  const selected = await selectPdfPages(await visualPdf(), [2]);
  const parsed = await readPdfGenerationRequest(multipart(selected));
  assert.deepEqual(parsed.input, input); assert.deepEqual(parsed.pdf.data, selected);
  await assert.rejects(readPdfGenerationRequest(multipart(new TextEncoder().encode("PRIVATE INVALID DATA"))), coded("INVALID_PDF"));
  await assert.rejects(readPdfGenerationRequest(multipart(selected, { ...input, pdfSource: { ...input.pdfSource, pages: [1, 2] } })), coded("INVALID_PDF_PAGES"));
  const tooLarge = multipart(selected); tooLarge.headers.set("content-length", String(MAX_AI_PDF_BYTES + 160001));
  await assert.rejects(readPdfGenerationRequest(tooLarge), coded("PDF_TOO_LARGE"));
  const demo = createGenerateHandler(demoAdapter);
  assert.equal((await demo(multipart(selected))).status, 503);
  assert.equal((await demo(multipart(selected, input, "https://elsewhere.example"))).status, 403);
  const json = new Request("http://localhost:3000/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  assert.equal((await demo(json)).status, 400);
});

test("local preview renders the actual selected diagram and rejects extra pages and external origins", async () => {
  const selected = await selectPdfPages(await visualPdf(), [2]);
  const response = await previewPdfRequest(multipart(selected));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const png = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const parser = new PDFParse({ data: new Uint8Array(selected), isEvalSupported: false });
  try { assert.deepEqual(png, new Uint8Array((await parser.getScreenshot({ partial: [1], desiredWidth: 1024, imageDataUrl: false })).pages[0].data)); }
  finally { await parser.destroy(); }
  assert.equal((await previewPdfRequest(multipart(selected, input, "https://elsewhere.example"))).status, 403);
  assert.equal((await previewPdfRequest(multipart(new TextEncoder().encode("PRIVATE BAD PDF")))).status, 400);
  const two = await selectPdfPages(await visualPdf(), [1, 2]);
  assert.equal((await previewPdfRequest(multipart(two, { ...input, pdfSource: { ...input.pdfSource, pages: [1, 2] } }))).status, 400);
  await assert.rejects(renderPdfPages(selected, AbortSignal.abort(new GenerationError("CANCELLED"))), coded("CANCELLED"));
});

test("PDF compatibility preserves the selected diagram, crop and rotation and honours cancellation", async () => {
  const original = await PDFDocument.load(await visualPdf());
  original.getPage(1).setCropBox(20, 50, 320, 220);
  original.getPage(1).setRotation(degrees(90));
  const data = await selectPdfPages(await original.save(), [2]);
  const prepared = await preparePdfInput({ filename: "selection.pdf", data }, new AbortController().signal);
  const pdf = await PDFDocument.load(prepared.data);
  assert.equal(prepared.filename, "selection.pdf");
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 220, height: 320 });
  assert.deepEqual((await renderPdfPages(prepared.data))[0], (await renderPdfPages(data))[0]);
  await assert.rejects(preparePdfInput({ filename: "selection.pdf", data }, AbortSignal.abort(new GenerationError("CANCELLED"))), coded("CANCELLED"));
});

test("protected SDK sends only the selected PDF in counting, generation and repair, keeping source mapping and retry bytes", async (t) => {
  const selected = await selectPdfPages(await visualPdf(), [2]);
  const parsed = await readPdfGenerationRequest(multipart(selected));
  const rendering = t.mock.method(PDFParse.prototype, "getScreenshot");
  const calls: { url: string; body: Record<string, any> }[] = [];
  const raw = generateDemo(sample, input.settings);
  const output = { title: "Visual diagram", summary: "Blue rectangle and orange circle", objectives: ["Explain the selected diagram"],
    scenes: raw.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, i) => ({ ...scene, sceneNo: i + 1, sourceId: "pdf-page:2", evidence: "Blue rectangle and orange circle" })) };
  let generations = 0;
  const adapter = createOpenAIAdapter(config, { fetch: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const candidate = structuredClone(output);
    if (!String(url).endsWith("/input_tokens") && ++generations === 1) candidate.scenes[1].narration = "";
    return new Response(JSON.stringify(String(url).endsWith("/input_tokens") ? { input_tokens: 3000 } :
      { object: "response", id: "resp_pdf", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(candidate), annotations: [] }] }] }), { headers: { "content-type": "application/json" } });
  } });
  const directory = mkdtempSync(join(tmpdir(), "eduflow-pdf-budget-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paid = protectPaidGeneration(multipart(selected), adapter, { config, directory });
  try {
    const board = await runGeneration(parsed.input, paid.adapter, { pdf: parsed.pdf });
    assert.deepEqual(board.pdfSource, input.pdfSource);
    const mixed = structuredClone(board);
    mixed.scenes[0].pdfSource = { name: "reselected.pdf", pages: [7] };
    assert.ok(markdown(mixed).includes("원본 PDF: reselected.pdf\n선택 페이지: 7"));
    assert.ok(board.scenes[0].reviewReason.includes("원본과 대조"));
    assert.equal(board.scenes[0].sourceId, "pdf-page:2");
    assert.equal(board.generation?.attempts, 2);
    assert.equal(calls.length, 4);
    assert.equal(rendering.mock.callCount(), 1);
    assert.deepEqual(calls[0].body.input, calls[1].body.input);
    assert.deepEqual(calls[2].body.input, calls[3].body.input);
    const content = calls[1].body.input[0].content;
    const file = content.find((item: any) => item.type === "input_file");
    assert.equal(content[0].type, "input_file");
    assert.equal(file.detail, "high");
    const actualPdf = Buffer.from(file.file_data.split(",")[1], "base64");
    assert.equal((await PDFDocument.load(actualPdf)).getPageCount(), 1);
    assert.deepEqual((await renderPdfPages(new Uint8Array(actualPdf)))[0], (await renderPdfPages(selected))[0]);
    for (const call of calls) {
      const parts = call.body.input[0].content;
      assert.equal(parts.filter((item: any) => item.type === "input_file").length, 1);
      assert.equal(parts.filter((item: any) => item.type === "input_image").length, 0);
      assert.deepEqual(parts.find((item: any) => item.type === "input_file"), file);
      assert.deepEqual(JSON.parse(parts.find((item: any) => item.type === "input_text").text).task.pdfSource.pages, [2]);
    }
    assert.ok(calls[1].body.instructions.includes("글자가 없는 페이지도"));
    assert.ok(calls[1].body.instructions.includes("pdf-page:"));
    assert.equal(calls[1].body.store, false); assert.equal(calls[1].body.max_output_tokens, 8000);
    const job = captureGeneration(input, null, new Blob([new Uint8Array(selected)]));
    input.pdfSource.pages.push(3);
    assert.deepEqual(job.input.pdfSource?.pages, [2]);
    assert.deepEqual(new Uint8Array(await job.pdf!.arrayBuffer()), selected);
    input.pdfSource.pages.pop();
  } finally { paid.finish(); }
});
