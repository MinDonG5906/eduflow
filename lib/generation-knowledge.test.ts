import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { defaults, newScene } from "./storyboard";
import { searchNeedles } from "./knowledge";
import { visualSearchTerms } from "./knowledge-visual-search";
import { selectPdfPages } from "./pdf-source";
import { generationKnowledgeQuery, retrieveGenerationKnowledge, searchGenerationKnowledge } from "./server/generation-knowledge";
import { searchHybridKnowledge } from "./server/knowledge-hybrid-search";
import { KnowledgeBase } from "./server/knowledge-base";
import { createGenerateHandler } from "./server/generate-handler";

async function sourcePdf(texts: string[]) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of texts) pdf.addPage([600, 400]).drawText(text, { x: 30, y: 300, size: 12, font });
  return pdf.save();
}
const context = (data?: Uint8Array) => ({ signal: new AbortController().signal,
  ...(data ? { pdf: { filename: "selected-pages.pdf", data } } : {}) });

test("decomposed Korean filenames retrieve the same stored passages as composed filenames", () => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-query-"));
  const base = new KnowledgeBase(directory);
  try {
    const title = "밀폐공간 작업 프로그램 수립 및 시행에 관한 기술지원규정";
    base.add({ title, text: "밀폐공간 작업 프로그램은 적정한 환기상태와 유해가스 농도 및 감시인의 연락체계를 확인합니다.", origin: "internal", published: "", revision: "" });
    const filename = `E-G-18-2026 ${title} (1).pdf`;
    assert.deepEqual(searchNeedles(filename.normalize("NFD")), searchNeedles(filename));
    const expected = base.search(filename);
    assert.ok(expected.length > 0);
    assert.deepEqual(base.search(filename.normalize("NFD")), expected);
  } finally { base.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("PDF retrieval uses selected page content even with an empty manuscript and generic filename", async () => {
  const data = await selectPdfPages(await sourcePdf(["Unselected welding instructions.", "Ventilation prevents hazardous atmosphere accumulation."]), [2]);
  const input = { manuscript: "", settings: defaults, pdfSource: { name: "upload.pdf", pages: [24] } };
  const query = await generationKnowledgeQuery(input, context(data));
  assert.ok(query.query.includes("Ventilation prevents hazardous atmosphere"));
  assert.ok(!query.query.includes("Unselected"));
  assert.ok(!query.query.includes("upload.pdf"));
  assert.equal(query.topic, "");
  assert.equal(input.manuscript, "");
  const directory = mkdtempSync(join(tmpdir(), "eduflow-pdf-query-"));
  const base = new KnowledgeBase(directory);
  try {
    const document = base.add({ title: "Work guide", text: "Ventilation prevents hazardous atmosphere accumulation. Check ventilation equipment before entry.", origin: "internal", published: "", revision: "" });
    assert.equal(base.search(query.query, 6, query.topic)[0]?.documentId, document.id);
  } finally { base.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("image-only PDFs retain normalized filename fallback and explicit topics", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const input = { manuscript: "", settings: defaults, pdfSource: { name: "밀폐공간.pdf".normalize("NFD"), pages: [22] }, sourceRequest: "환기설비".normalize("NFD") };
  const query = await generationKnowledgeQuery(input, context(await pdf.save()));
  assert.ok(query.query.includes("밀폐공간.pdf"));
  assert.equal(query.topic, "환기설비");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generationKnowledgeQuery(input, { signal: controller.signal }));
});

test("scene citation retrieval keeps the original page scope", async () => {
  const data = await sourcePdf(["Ventilation equipment inspection.", "Emergency rescue communication."]);
  const pdfSource = { name: "manual.pdf", pages: [22, 25] };
  const input = { manuscript: "", settings: defaults, pdfSource,
    scene: { ...newScene(), sourceId: "pdf-page:25", pdfSource }, sceneSourceScope: "citation" as const };
  const query = await generationKnowledgeQuery(input, context(data));
  assert.ok(query.query.includes("Emergency rescue"));
  assert.ok(!query.query.includes("Ventilation"));
  const stale = await generationKnowledgeQuery({ ...input, scene: { ...input.scene, sourceId: "pdf-page:18" } }, context(data));
  assert.ok(stale.query.includes("Ventilation") && stale.query.includes("Emergency rescue"));
});

test("generation handler supplies the validated attachment to retrieval before paid admission", async () => {
  const data = await sourcePdf(["Ventilation equipment inspection."]);
  let searched = false, generated = false;
  const controller = new AbortController();
  const post = createGenerateHandler({ mode: "ai", model: "mock", promptVersion: "test", generate: async () => { generated = true; return {}; } }, {
    sceneKnowledge: async () => { assert.fail("cancelled pre-retrieval must never reach scene retrieval"); },
    knowledge: async (input, searchContext) => {
      searched = true;
      assert.deepEqual(input.pdfSource?.pages, [22]);
      assert.ok(searchContext.pdf);
      const query = await generationKnowledgeQuery(input, searchContext);
      assert.ok(query.query.includes("Ventilation"));
      controller.abort();
      return [];
    },
  });
  const body = new FormData();
  body.set("input", JSON.stringify({ manuscript: "", settings: defaults, pdfSource: { name: "upload.pdf", pages: [22] } }));
  body.set("pdf", new Blob([new Uint8Array(data)], { type: "application/pdf" }), "selected-pages.pdf");
  const result = await post(new Request("http://localhost/api/generate", { method: "POST", headers: { Origin: "http://localhost", Host: "localhost" }, body, signal: controller.signal }));
  assert.equal(searched, true); assert.equal(generated, false);
  assert.equal(result.status, 499); // Cancellation during retrieval still stops before billing.
});

test("slow RAG falls back within its deadline while user cancellation never falls through to generation", async () => {
  const input = { manuscript: "원문", settings: defaults };
  let searchSignal: AbortSignal | undefined;
  const result = await retrieveGenerationKnowledge(input, context(), async (_, ctx) => {
    searchSignal = ctx.signal; return new Promise(() => {});
  }, 10);
  assert.deepEqual(result.references, []);
  assert.equal(result.status, "unavailable");
  assert.equal(result.failure?.stage, "source_search");
  assert.equal(result.failure?.reason, "timeout");
  assert.equal(result.failure?.timeoutMs, 10);
  assert.equal(searchSignal?.aborted, true);
  const controller = new AbortController();
  const pending = retrieveGenerationKnowledge(input, { signal: controller.signal }, async () => {
    controller.abort(); throw new Error("cancelled-search");
  });
  await assert.rejects(pending, (error: any) => error.code === "CANCELLED");
});


test("scene-specific visual terms survive a long manuscript's search budget", async () => {
  const longManuscript = Array.from({length: 150}, (_, i) => `주제${String.fromCharCode(0xac00 + i)}설명`).join(" ");
  const scene = { ...newScene(), title: "환기팬 용량 계산", visual: "환기팬 설치 위치를 보여준다." };
  const result = await generationKnowledgeQuery({ manuscript: longManuscript, settings: defaults, scene }, context());
  assert.ok(visualSearchTerms(result.query).includes("환기팬"));
  assert.ok(result.query.indexOf(scene.title) < result.query.indexOf(longManuscript));
  assert.ok(result.query.includes(longManuscript), "the source remains available to text retrieval");
});

test("unit queries use local search and cannot attach accident prevention to immediate response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-unit-query-"));
  const base = new KnowledgeBase(directory);
  const response = "사고 직후 작업을 중지합니다. 전원을 차단합니다. 응급조치를 실시합니다.";
  try {
    base.add({ title: "중량물 사고 안전 자료", text: "중량물 작업 전 작업계획서를 작성합니다. 사고 예방을 위해 작업 순서를 점검합니다.",
      origin: "internal", published: "", revision: "" });
    const queries: string[] = [];
    const search: typeof searchHybridKnowledge = async (query, topic, _, abort) => {
      queries.push(query); return searchHybridKnowledge(query, topic, directory, abort);
    };
    const input = { manuscript: `중량물 교육\n${response}`, settings: defaults };
    assert.deepEqual(await searchGenerationKnowledge(input, context(), search), []);
    const good = base.add({ title: "현장 비상 대응", text: response, origin: "internal", published: "", revision: "" });
    const references = await searchGenerationKnowledge(input, context(), search);
    assert.ok(references.length > 0);
    assert.ok(references.every(ref => ref.documentId === good.id));
    assert.ok(references.every(ref => ref.unitIds?.length && ref.context?.documentTitle));
    assert.ok(queries.some(query => query.includes("전원을 차단")));
    assert.ok(!queries.some(query => query.includes(response)), "the entire response is not one broad query");
  } finally { base.close(); rmSync(directory, { recursive: true, force: true }); }
});
