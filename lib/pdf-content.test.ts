import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { generationTask, GenerationError, type GenerationInput } from "./generation-contract";
import { defaults, generateDemo, sample } from "./storyboard";
import { citedPdfPage, selectPdfPages } from "./pdf-source";
import { preparePdfContent } from "./server/pdf-content";
import { renderPdfPages } from "./server/pdf-render";
import { createOpenAIAdapter, OPENAI_MODEL } from "./server/openai-adapter";
import { readAIConfig } from "./server/ai-config";

async function mixedPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // Ordinary prose can be extracted without sending an image.
  const prose = pdf.addPage([600, 800]);
  prose.drawText("Safety instructions: isolate power before maintenance.", { x: 40, y: 700, size: 16, font });
  prose.drawText("Check that all moving parts have stopped.", { x: 40, y: 670, size: 16, font });
  // Text plus vector graphics must retain its image.
  const diagram = pdf.addPage([600, 800]);
  diagram.drawText("DIAGRAM: follow the blue arrow", { x: 40, y: 700, size: 16, font });
  diagram.drawRectangle({ x: 60, y: 400, width: 120, height: 100, color: rgb(0, 0, 1) });
  // A table with no border is still a visual layout.
  const table = pdf.addPage([600, 800]);
  for (const [i, label] of ["ITEM", "A17", "B26"].entries()) {
    table.drawText(label, { x: 40, y: 700 - i * 30, size: 16, font });
    table.drawText(String(37 + i), { x: 300, y: 700 - i * 30, size: 16, font });
  }
  // A scanned page has no extractable text, but must not disappear.
  const image = await pdf.embedPng((await renderPdfPages(await selectPdfPages(await pdf.save(), [1])))[0]);
  pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  return { filename: "selected-pages.pdf", data: await pdf.save() };
}

test("hybrid PDF preserves prose, diagrams, borderless tables and scans with original page numbers", async () => {
  const pdf = await mixedPdf();
  const result = await preparePdfContent(pdf, [2, 9, 13, 17], new AbortController().signal);
  assert.deepEqual(result.textPages, [{ page: 2, text: "Safety instructions: isolate power before maintenance.\nCheck that all moving parts have stopped." }]);
  assert.deepEqual(result.visualPages, [9, 13, 17]);
  assert.equal((await PDFDocument.load(result.pdf!.data)).getPageCount(), 3);
  assert.deepEqual(await renderPdfPages(result.pdf!.data), await renderPdfPages(await selectPdfPages(pdf.data, [2, 3, 4])));
});

test("sixteen text pages need no visual attachment or rendering", async (t) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 16; i++) pdf.addPage().drawText(`Safety text on page ${i + 1}`, { x: 40, y: 700, size: 16, font });
  const { PDFParse } = await import("pdf-parse");
  const rendering = t.mock.method(PDFParse.prototype, "getScreenshot");
  const result = await preparePdfContent({ filename: "text.pdf", data: await pdf.save() }, Array.from({ length: 16 }, (_, i) => i + 2), new AbortController().signal);
  assert.equal(result.textPages.length, 16);
  assert.equal(result.textPages[15].page, 17);
  assert.deepEqual(result.visualPages, []);
  assert.equal(result.pdf, undefined);
  assert.equal(rendering.mock.callCount(), 0);
});

test("Korean prose retains its words, spacing and page reference without an image", async () => {
  const result = await preparePdfContent({ filename: "korean.pdf", data: new Uint8Array(readFileSync(new URL("./fixtures/source-document.pdf", import.meta.url))) }, [8], new AbortController().signal);
  assert.equal(result.pdf, undefined);
  assert.equal(result.textPages[0].page, 8);
  assert.ok(result.textPages[0].text.includes("산업안전수칙\n파일 읽기 확인용 예시입니다."));
  assert.ok(result.textPages[0].text.includes("원문을 확인하고 지정한 교육대상에게 필요한 설명을 정리합니다."));
});

test("cropped text excludes invisible content; partial clipping keeps the visual fallback", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  page.drawText("OUTSIDE CROP", { x: 40, y: 700, size: 16 });
  page.drawText("VISIBLE TEXT", { x: 40, y: 300, size: 16 });
  page.setCropBox(0, 0, 600, 400);
  const attachment = { filename: "crop.pdf", data: await pdf.save() };
  const result = await preparePdfContent(attachment, [7], new AbortController().signal);
  assert.deepEqual(result.textPages, [{ page: 7, text: "VISIBLE TEXT" }]);
  assert.deepEqual(result.visualPages, []);
  const modified = await PDFDocument.load(attachment.data);
  modified.getPage(0).drawText("PARTIALLY CLIPPED", { x: 570, y: 200, size: 16 });
  const clipped = await preparePdfContent({ ...attachment, data: await modified.save() }, [7], new AbortController().signal);
  assert.deepEqual(clipped.textPages, []);
  assert.deepEqual(clipped.visualPages, [7]);
  await assert.rejects(preparePdfContent(attachment, [7], AbortSignal.abort(new GenerationError("CANCELLED"))), (error: unknown) => error instanceof GenerationError && error.code === "CANCELLED");
  await assert.rejects(preparePdfContent(attachment, [7, 8], new AbortController().signal), (error: unknown) => error instanceof GenerationError && error.code === "INVALID_PDF_PAGES");
});

const config = readAIConfig({ EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-hybrid-pdf-test-key", EDUFLOW_AI_MODEL: OPENAI_MODEL,
  EDUFLOW_AI_INPUT_USD_PER_MILLION: "0.75", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4.50",
  EDUFLOW_AI_REQUEST_BUDGET_USD: "0.10", EDUFLOW_AI_DAY_BUDGET_USD: "0.5", EDUFLOW_AI_MONTH_BUDGET_USD: "2" });

test("count and generate use identical hybrid inputs; scene scope selects only its cited source", async () => {
  const pdf = await mixedPdf();
  const calls: Record<string, any>[] = [];
  const adapter = createOpenAIAdapter(config, { fetch: async (url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(String(url).endsWith("/input_tokens") ? { input_tokens: 1000 } :
      { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}", annotations: [] }] }] }), { headers: { "content-type": "application/json" } });
  } });
  const source = { name: "mixed.pdf", pages: [2, 9, 13, 17] };
  const scene = { ...generateDemo(sample, defaults).scenes[0], sourceId: "pdf-page:2", pdfSource: source };
  const input: GenerationInput = { manuscript: "", settings: defaults, pdfSource: source, scene, sceneSourceScope: "citation", direction: "짧게 설명해 주세요." };
  const context = { pdf, task: generationTask(input), signal: new AbortController().signal, limits: { maxInputTokens: 16000, maxOutputTokens: 8000, maxProviderCalls: 1 as const } };
  await adapter.countInputTokens!(input, context);
  await adapter.generate(input, context);
  assert.deepEqual(calls[0].input, calls[1].input);
  assert.equal(typeof calls[0].input, "string");
  const focused = JSON.parse(calls[0].input);
  assert.deepEqual(focused.task.pdfSource.pages, [2]);
  assert.deepEqual(focused.document.visualPages, []);
  assert.equal(focused.document.textPages.length, 1);
  assert.ok(!calls[0].input.includes("DIAGRAM:"));
  // The broader selection reuses neither a narrower cache entry nor its map.
  const broadInput = { ...input, sceneSourceScope: "selection" as const };
  await adapter.countInputTokens!(broadInput, { ...context, task: generationTask(broadInput) });
  const parts = calls[2].input[0].content;
  const mixed = JSON.parse(parts.find((part: any) => part.type === "input_text").text);
  assert.deepEqual(mixed.task.pdfSource.pages, source.pages);
  assert.deepEqual(mixed.document.visualPages, [9, 13, 17]);
  assert.deepEqual(mixed.document.textPages.map((page: { page: number }) => page.page), [2]);
  const attachment = parts.find((part: any) => part.type === "input_file");
  assert.equal((await PDFDocument.load(Buffer.from(attachment.file_data.split(",")[1], "base64"))).getPageCount(), 3);
  const changedSource = { ...input, scene: { ...scene, pdfSource: { ...source, name: "old.pdf" } } };
  await adapter.countInputTokens!(changedSource, { ...context, task: generationTask(changedSource) });
  const fallback = JSON.parse(calls[3].input[0].content.find((part: any) => part.type === "input_text").text);
  assert.deepEqual(fallback.task.pdfSource.pages, source.pages);
  assert.equal(fallback.task.sceneSourceScope, "selection");
  // Caller metadata and stored selection must remain unchanged.
  assert.deepEqual(input.pdfSource?.pages, [2, 9, 13, 17]);
});

test("unavailable or changed source citations retain the full selection", async () => {
  const source = { name: "current.pdf", pages: [2, 9] };
  assert.equal(citedPdfPage(source, { sourceId: "pdf-page:2", pdfSource: source }), 2);
  assert.equal(citedPdfPage(source, { sourceId: "pdf-page:2", pdfSource: { ...source, name: "different.pdf" } }), null);
  assert.equal(citedPdfPage(source, { sourceId: "pdf-page:17", pdfSource: { ...source, pages: [17] } }), null);
  assert.equal(citedPdfPage(source, { sourceId: "sentence:1-2", pdfSource: source }), null);
  assert.equal(citedPdfPage(source, { sourceId: "pdf-page:2" }), null);
});
