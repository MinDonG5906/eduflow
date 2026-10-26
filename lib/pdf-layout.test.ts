import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { preparePdfContent } from "./server/pdf-content";
import { createOpenAIAdapter, OPENAI_MODEL } from "./server/openai-adapter";
import { readAIConfig } from "./server/ai-config";
import { generationTask, GenerationError } from "./generation-contract";
import { defaults } from "./storyboard";

async function tableFixture(options: { arrow?: boolean; broken?: boolean; openGrid?: boolean; clippedText?: boolean } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 500]);
  for (const y of [100, 200, 300, 400]) page.drawLine({ start: { x: options.openGrid && y === 300 ? 200 : 40, y }, end: { x: 560, y }, thickness: 1 });
  for (const x of [40, 380, 560]) page.drawLine({ start: { x, y: 100 }, end: { x, y: 400 }, thickness: 1 });
  // Top left header spans two columns.
  page.drawLine({ start: { x: 200, y: 100 }, end: { x: 200, y: options.broken ? 200 : 300 }, thickness: 1 });
  for (const [text, x, y] of [
    ["HAZARD AND RISK", 60, 360], ["CONTROL", 400, 360],
    ["H1", 60, 260], ["High risk", 220, 260], ["Guard A", 400, 260],
    ["H2", 60, 160], ["Low risk", 220, 160], ["Inspect B", 400, 160],
    ["NOTE: retain this condition and the source page.", 40, 50],
  ] as const) page.drawText(text, { x, y, size: 12 });
  const canvas = createCanvas(40, 30); const context = canvas.getContext("2d");
  context.fillStyle = "#e00000"; context.fillRect(0, 0, 40, 30);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  page.drawImage(image, { x: 250, y: 210, width: 50, height: 30 });
  if (options.clippedText) {
    page.pushOperators(pushGraphicsState(), rectangle(220, 240, 20, 20), clip(), endPath());
    page.drawText("PARTIALLY HIDDEN TEXT", { x: 220, y: 250, size: 12 });
    page.pushOperators(popGraphicsState());
  }
  if (options.arrow) page.drawLine({ start: { x: 60, y: 440 }, end: { x: 500, y: 420 }, thickness: 3, color: rgb(0, 0, 1) });
  return { filename: "selected-pages.pdf", data: await pdf.save() };
}

test("table input preserves merged headers, row/column associations, complete notes and figure links", async () => {
  const result = await preparePdfContent(await tableFixture(), [25], new AbortController().signal);
  assert.deepEqual(result.visualPages, []);
  assert.equal(result.pdf, undefined);
  assert.equal(result.layoutPages.length, 1);
  const page = result.layoutPages[0], table = page.tables[0];
  assert.ok(page.text.includes("NOTE: retain this condition and the source page."));
  assert.equal(table.cells.find(cell => cell.text === "HAZARD AND RISK")?.colSpan, 2);
  const hazard = table.cells.find(cell => cell.text === "H1")!;
  const control = table.cells.find(cell => cell.text === "Guard A")!;
  assert.equal(hazard.row, control.row);
  assert.ok(table.cells.some(cell => cell.text === "Inspect B" && cell.row !== hazard.row));
  const figure = page.figures[0];
  assert.equal(figure.row, hazard.row);
  assert.equal(figure.col, 2);
  assert.equal(figure.table, table.id);
  assert.ok(table.cells.find(cell => cell.row === hazard.row && cell.col === 2)?.figures.includes(figure.id));
  assert.deepEqual(result.images.map(image => image.id), [page.contextImage, figure.id]);
  assert.equal(result.images[0].width, 640);
  const crop = await loadImage(result.images[1].data);
  assert.ok(crop.width > 50 && crop.height > 30);
});

test("vector diagrams and ambiguous tables keep the full-page PDF path", async () => {
  for (const options of [{ arrow: true }, { openGrid: true }]) {
    const result = await preparePdfContent(await tableFixture(options), [7], new AbortController().signal);
    assert.deepEqual(result.visualPages, [7], JSON.stringify(options));
    assert.deepEqual(result.layoutPages, []);
    assert.deepEqual(result.images, []);
    assert.ok(result.pdf);
  }
});

test("clipped table text never exposes the invisible remainder as source text", async () => {
  const result = await preparePdfContent(await tableFixture({ clippedText: true }), [7], new AbortController().signal);
  assert.equal(JSON.stringify(result.layoutPages).includes("PARTIALLY HIDDEN TEXT"), false);
  assert.ok(result.pdf || result.images.some(image => image.kind === "context"));
});

test("cancellation stops structured-page extraction and rendering", async () => {
  await assert.rejects(preparePdfContent(await tableFixture(), [7], AbortSignal.abort(new GenerationError("CANCELLED"))),
    (error: unknown) => error instanceof GenerationError && error.code === "CANCELLED");
});

const config = readAIConfig({ EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-structured-test-key", EDUFLOW_AI_MODEL: OPENAI_MODEL,
  EDUFLOW_AI_INPUT_USD_PER_MILLION: "0.75", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4.50",
  EDUFLOW_AI_REQUEST_BUDGET_USD: "0.10", EDUFLOW_AI_DAY_BUDGET_USD: "0.5", EDUFLOW_AI_MONTH_BUDGET_USD: "2" });

test("HWP/PDF/PPTX sources share the structured payload and count exactly the same input sent for generation", async () => {
  const pdf = await tableFixture();
  for (const name of ["source.hwp", "source.pdf", "source.pptx"]) {
    const calls: any[] = [];
    const adapter = createOpenAIAdapter(config, { fetch: async (url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(String(url).endsWith("/input_tokens") ? { input_tokens: 2000 } :
        { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{}", annotations: [] }] }] }), { headers: { "content-type": "application/json" } });
    } });
    const input = { manuscript: "", settings: defaults, pdfSource: { name, pages: [25] } };
    const context = { pdf, signal: new AbortController().signal, task: generationTask(input),
      limits: { maxInputTokens: 16000, maxOutputTokens: 8000, maxProviderCalls: 1 as const } };
    await adapter.countInputTokens!(input, context); await adapter.generate(input, context);
    assert.deepEqual(calls[0].input, calls[1].input);
    const parts = calls[1].input[0].content;
    assert.equal(parts.some((part: any) => part.type === "input_file"), false);
    assert.equal(parts.filter((part: any) => part.type === "input_image").length, 2);
    const payload = JSON.parse(parts[0].text);
    assert.equal(payload.document.layoutPages[0].page, 25);
    assert.deepEqual(payload.document.layoutPages[0].tables[0].cellFields, ["row", "col", "rowSpan", "colSpan", "text", "figures", "highlights"]);
    assert.equal(JSON.stringify(payload.document).includes("base64"), false);
    assert.ok(payload.task.pdfGuidance.includes("cellFields"));
  }
});
