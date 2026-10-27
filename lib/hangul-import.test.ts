import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { convertHangul } from "./server/hangul-import";
import { DocumentImportError, importDocumentRequest } from "./server/document-import";
import { readDocumentUpload } from "./document-upload";
import { pdfSourceSchema, selectPdfPages, sourceFormat, sourceUnit } from "./pdf-source";
import { readPdfGenerationRequest } from "./server/pdf-input";
import { defaults, generateDemo, markdown, sample, csv } from "./storyboard";
import { captureGeneration, readDraft, serializeDraft } from "./studio-state";

const signal = () => new AbortController().signal;
const fixture = (extension = "hwpx") => readFile(new URL(`./fixtures/hangul-safety.${extension}`, import.meta.url));
async function pdfBytes(pages = 3) {
  const pdf = await PDFDocument.create();
  for (let i = 1; i <= pages; i++) pdf.addPage().drawText(`PAGE ${i}`);
  return Buffer.from(await pdf.save());
}
const request = (name: string, data: Buffer, origin = "http://localhost:3000") => new Request("http://localhost:3000/api/documents", {
  method: "POST", headers: { origin, "x-document-name": encodeURIComponent(name) }, body: new Uint8Array(data),
});

test("HWP and HWPX render locally with private Korean fonts and clean all temporary files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-hwp-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const font = join(root, "local font.ttf"); await writeFile(font, "LOCAL FONT BYTES");
  const pdf = await pdfBytes();
  for (const ext of ["hwp", "hwpx"]) {
    const data = await fixture(ext);
    const converted = await convertHangul(`교육.${ext.toUpperCase()}`, data, signal(), {
      binary: "test-converter", tempRoot: root, fontFiles: [font], run: async (binary, args) => {
        assert.equal(binary, "test-converter"); assert.equal(args[0], "export-pdf");
        assert.ok(!args.includes("--text-as-paths")); assert.ok(!args.includes("--page"));
        assert.ok(args[1].endsWith(`source.${ext}`));
        assert.deepEqual(await readFile(args[1]), data);
        const fonts = args[args.indexOf("--font-path") + 1];
        assert.equal(await readFile(join(fonts, "font-0.ttf"), "utf8"), "LOCAL FONT BYTES");
        await writeFile(args[args.indexOf("-o") + 1], pdf);
      },
    });
    assert.deepEqual(converted, { pdf, pages: 3 });
    assert.deepEqual(await readdir(root), ["local font.ttf"]);
  }
});

test("invalid, encrypted, unsafe and excessively expanded HWPX archives never start conversion", async () => {
  const data = await fixture(), central = data.readUInt32LE(data.length - 6);
  const expanded = Buffer.from(data); expanded.writeUInt32LE(31 * 1024 * 1024, central + 24);
  const encrypted = Buffer.from(data); encrypted.writeUInt16LE(1, central + 8);
  const excessive = Buffer.from(data); excessive.writeUInt16LE(10001, data.length - 12);
  const traversal = Buffer.from(data); traversal.write("../", central + 46);
  const missingHeader = Buffer.from(data);
  const location = missingHeader.indexOf("Contents/header.xml", central); assert.ok(location > 0);
  missingHeader.write("Contents/absent.xml", location);
  let calls = 0;
  const options = { binary: "fake", fontFiles: [], run: async () => { calls++; } };
  for (const [name, bytes] of [
    ["old.hwp", Buffer.from("PRIVATE HWP3")], ["empty.hwp", Buffer.alloc(0)], ["wrong.pdf", data],
    ["bad.hwpx", Buffer.from("PRIVATE DATA")], ["expanded.hwpx", expanded], ["locked.hwpx", encrypted],
    ["many.hwpx", excessive], ["traversal.hwpx", traversal], ["no-header.hwpx", missingHeader],
  ] as const) {
    await assert.rejects(convertHangul(name, bytes, signal(), options), (error: unknown) => error instanceof DocumentImportError && !error.message.includes("PRIVATE"));
  }
  assert.equal(calls, 0);
});

test("failed, corrupt and over-200-page conversions clean their data and allow the next upload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-hwp-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = await fixture();
  for (const result of [undefined, Buffer.from("NOT A PDF"), await pdfBytes(201)]) {
    await assert.rejects(convertHangul("교육.hwpx", data, signal(), {
      binary: "fake", tempRoot: root, fontFiles: [], run: async (_, args) => {
        if (!result) throw new Error("PRIVATE ORIGINAL CONTENTS");
        await writeFile(args[args.indexOf("-o") + 1], result);
      },
    }), (error: unknown) => error instanceof DocumentImportError && !error.message.includes("PRIVATE"));
    assert.deepEqual(await readdir(root), []);
  }
});

test("cancellation releases the Hangul conversion lock and removes temporary data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-hwp-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = await fixture(), controller = new AbortController();
  let started!: () => void; const waiting = new Promise<void>((resolve) => { started = resolve; });
  const operation = convertHangul("교육.hwpx", data, controller.signal, {
    binary: "fake", tempRoot: root, fontFiles: [], run: async (_, __, abort) => {
      started(); await new Promise((_, reject) => abort.addEventListener("abort", () => reject(abort.reason), { once: true }));
    },
  });
  await waiting;
  await assert.rejects(convertHangul("다른문서.hwpx", data, signal()), (error: unknown) => error instanceof DocumentImportError && error.status === 429);
  controller.abort();
  await assert.rejects(operation, (error: unknown) => error instanceof DocumentImportError && error.status === 499);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(convertHangul("교육.hwpx", data, AbortSignal.abort()), (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("missing Hangul tool gives a setup or PDF fallback without exposing private paths", async () => {
  const previous = process.env.EDUFLOW_HWP_CONVERTER_PATH;
  process.env.EDUFLOW_HWP_CONVERTER_PATH = "/nonexistent/PRIVATE-rhwp";
  try {
    await assert.rejects(convertHangul("교육.hwp", await fixture("hwp"), signal()), (error: unknown) =>
      error instanceof DocumentImportError && error.status === 503 && error.message.includes("PDF로 저장") && !error.message.includes("PRIVATE"));
  } finally {
    if (previous === undefined) delete process.env.EDUFLOW_HWP_CONVERTER_PATH;
    else process.env.EDUFLOW_HWP_CONVERTER_PATH = previous;
  }
});

test("Hangul upload validates origin before conversion and preserves original filenames in PDF responses", async () => {
  let calls = 0; const pdf = await pdfBytes();
  const converter = async () => { calls++; return { pdf, pages: 3 }; };
  const pptConverter = async () => { throw new Error("Hangul must not use LibreOffice"); };
  for (const ext of ["HWP", "HWPX"]) {
    const data = await fixture(ext.toLowerCase());
    assert.equal((await importDocumentRequest(request(`교육.${ext}`, data, "https://elsewhere.example"), pptConverter, converter)).status, 403);
    const before = calls;
    const response = await importDocumentRequest(request(`교육.${ext}`, data), pptConverter, converter);
    assert.equal(calls, before + 1); assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const upload = await readDocumentUpload(response, new File([data], `교육.${ext}`));
    assert.equal(upload.document.name, `교육.${ext}`); assert.equal(upload.document.pages, 3);
    assert.equal(upload.document.kind, "pdf"); assert.equal(upload.document.text, ""); assert.deepEqual(upload.document.selectedPages, []);
    assert.equal(upload.pdf?.type, "application/pdf"); assert.deepEqual(Buffer.from(await upload.pdf!.arrayBuffer()), pdf);
  }
  assert.equal(calls, 2);
  await assert.rejects(readDocumentUpload(Response.json({}), new File([], "교육.hwpx")), /HWPX 변환 결과/);
  await assert.rejects(readDocumentUpload(new Response(null, { headers: { "Content-Type": "application/pdf", "X-Document-Pages": "3" } }), new File([], "교육.hwp")), /HWP 변환 결과가 비어/);
});

test("selected Hangul pages alone reach generation input and retain page mapping through recovery and exports", async () => {
  for (const name of ["안전.HWP", "안전.HWPX"]) {
    const selected = await selectPdfPages(await pdfBytes(), [2]);
    const input = { manuscript: "", settings: defaults, pdfSource: { name, pages: [2] }, sourceRequest: "선택한 안전수칙으로 교육을 만들어 주세요" };
    assert.ok(pdfSourceSchema.safeParse(input.pdfSource).success);
    assert.equal(sourceFormat(name), name.endsWith("HWPX") ? "HWPX" : "HWP"); assert.equal(sourceUnit(name), "페이지");
    const job = captureGeneration(input, null, new Blob([new Uint8Array(selected)], { type: "application/pdf" }));
    const form = new FormData(); form.set("input", JSON.stringify(job.input)); form.set("pdf", job.pdf!, "selected-pages.pdf");
    const parsed = await readPdfGenerationRequest(new Request("http://localhost:3000/api/generate", { method: "POST", body: form }));
    assert.deepEqual(parsed.input.pdfSource, input.pdfSource); assert.equal((await PDFDocument.load(parsed.pdf.data)).getPageCount(), 1);
    const parser = new PDFParse({ data: parsed.pdf.data, isEvalSupported: false });
    try { const text = (await parser.getText()).text; assert.match(text, /PAGE 2/); assert.doesNotMatch(text, /PAGE [13]/); }
    finally { await parser.destroy(); }
    const document = { name, kind: "pdf" as const, pages: 3, text: "", query: input.sourceRequest, selectedPages: [2], fileId: crypto.randomUUID() };
    const board = { ...generateDemo(sample, defaults), pdfSource: input.pdfSource };
    board.scenes[0].pdfSource = input.pdfSource;
    const draft = { manuscript: "", settings: defaults, board, document };
    assert.deepEqual(readDraft(serializeDraft(draft)), draft);
    assert.ok(markdown(board).includes(`원본 ${sourceFormat(name)}: ${name}\n선택 페이지: 2`));
    assert.ok(csv(board).includes(`"${name}","2"`));
  }
});

test("native Hangul converter renders both authored fixtures with matching pagination", { skip: !process.env.EDUFLOW_TEST_HWP_CONVERTER }, async () => {
  for (const ext of ["hwp", "hwpx"]) {
    const { pdf, pages } = await convertHangul(`교육.${ext}`, await fixture(ext), signal(), { binary: process.env.EDUFLOW_TEST_HWP_CONVERTER });
    assert.equal(pages, 3);
    const selected = await selectPdfPages(pdf, [1]);
    const parser = new PDFParse({ data: selected, isEvalSupported: false });
    try {
      const text = (await parser.getText()).text;
      for (const term of ["끼임", "전원 차단", "안전대"]) assert.ok(text.includes(term));
      const rendered = (await parser.getScreenshot({ partial: [1], desiredWidth: 800, imageDataUrl: false })).pages[0];
      assert.ok(rendered.data.length > 10000);
    } finally { await parser.destroy(); }
  }
});
