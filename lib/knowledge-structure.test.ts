import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { applyKnowledgeVision, knowledgeTableSchema, knowledgeVisionSchema, makeKnowledgeStructure,
  recommendationsForBlocks, structureChunks, tableBlocks, type KnowledgeTable, type KnowledgeVision } from "./knowledge-structure";
import { KnowledgeBase } from "./server/knowledge-base";
import { analyzeKnowledgePdf } from "./server/knowledge-ingest";
import { analyzeKnowledgeVision, cropKnowledgeFigure, knowledgeVisionConfig } from "./server/knowledge-vision";
import { createKnowledgeStructureHandlers } from "./server/knowledge-structure-handler";
import { OPENAI_MODEL } from "./server/openai-adapter";
import { GenerationError } from "./generation-contract";
import { boardSchema, defaults, generateDemo, markdown, sample } from "./storyboard";
import { runGeneration } from "./server/generation-service";
import { promptTask } from "./server/provider-prompt";
import { generationTask } from "./generation-contract";
import { readKnowledgeLocation } from "./server/knowledge-handler";
import { knowledgeLocationUrl } from "./knowledge";
import { readDraft, serializeDraft } from "./studio-state";

const table: KnowledgeTable = { id: "checklist", rows: 3, cols: 4, cells: [
  { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "단계" },
  { row: 1, col: 2, rowSpan: 1, colSpan: 1, text: "점검 항목" },
  { row: 1, col: 3, rowSpan: 1, colSpan: 1, text: "YES" },
  { row: 1, col: 4, rowSpan: 1, colSpan: 1, text: "NO" },
  { row: 2, col: 1, rowSpan: 2, colSpan: 1, text: "사전 준비" },
  { row: 2, col: 2, rowSpan: 1, colSpan: 1, text: "작업·공정별 위험성평가 실시" },
  { row: 2, col: 3, rowSpan: 1, colSpan: 1, text: "" },
  { row: 2, col: 4, rowSpan: 1, colSpan: 1, text: "" },
  { row: 3, col: 2, rowSpan: 1, colSpan: 1, text: "작업자에게 위험요인 전달" },
  { row: 3, col: 3, rowSpan: 1, colSpan: 1, text: "✓" },
  { row: 3, col: 4, rowSpan: 1, colSpan: 1, text: "" },
] };
const source = () => makeKnowledgeStructure(42, 1, "훅 손상으로 인양물이 떨어지는 사고가 발생합니다.\n\n샤클핀 체결 상태를 별도로 점검합니다.", true);
const response = (): KnowledgeVision => ({ tables: [], figures: [{ id: "hook", title: "훅 손상 사고 그림", bounds: [0.1, 0.1, 0.5, 0.5],
  links: [{ blockId: source().blocks[0].id, quote: "훅 손상으로 인양물이 떨어지는 사고", reason: "그림에 훅 손상과 떨어지는 인양물이 함께 보입니다.", confidence: 0.96, relationship: "illustrates" }] }] });
const meta = { title: "안전교육 원본", origin: "internal" as const, published: "2023", revision: "1" };
const env = { EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-private-test-key", EDUFLOW_AI_MODEL: OPENAI_MODEL,
  EDUFLOW_AI_INPUT_USD_PER_MILLION: "0.75", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4.50", EDUFLOW_AI_REQUEST_BUDGET_USD: "0.10" };
const temp = () => mkdtempSync(join(tmpdir(), "eduflow-structure-"));
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
const completed = (data: unknown) => ({ object: "response", id: "resp_test", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(data), annotations: [] }] }], usage: { input_tokens: 2100, output_tokens: 150 } });

test("merged checklist cells apply to all covered items without inventing YES/NO answers", () => {
  assert.ok(knowledgeTableSchema.safeParse(table).success);
  const blocks = tableBlocks(table, 13);
  assert.match(blocks[1].text, /사전 준비/);
  assert.match(blocks[2].text, /사전 준비/);
  assert.match(blocks[1].text, /YES \/ 열 3: \[빈 응답 칸: 미기입\]/);
  assert.match(blocks[1].text, /NO \/ 열 4: \[빈 응답 칸: 미기입\]/);
  assert.match(blocks[2].text, /✓/);
  for (const cells of [table.cells.slice(1), [...table.cells, table.cells[0]], table.cells.map((c,i) => i ? c : { ...c, colSpan: 10 })])
    assert.equal(knowledgeTableSchema.safeParse({ ...table, cells }).success, false);
});

test("only matching source block and verbatim quote can acquire a recommendation", () => {
  const result = response();
  result.figures[0].links.push(
    { ...result.figures[0].links[0], blockId: "invented" },
    { ...result.figures[0].links[0], blockId: source().blocks[1].id, quote: "없는 문장입니다" });
  const structure = applyKnowledgeVision(source(), result, OPENAI_MODEL);
  assert.equal(structure.links.length, 1);
  assert.equal(recommendationsForBlocks(crypto.randomUUID(), structure, [structure.blocks[1].id]).length, 0);
  assert.equal(recommendationsForBlocks(crypto.randomUUID(), structure, [structure.blocks[0].id]).length, 1);
  for (const relationship of ["uncertain", "unrelated"] as const) {
    const result = response(); result.figures[0].links[0].relationship = relationship;
    const uncertain = applyKnowledgeVision(source(), result, OPENAI_MODEL);
    assert.equal(recommendationsForBlocks(crypto.randomUUID(), uncertain, [uncertain.blocks[0].id]).length, 0);
  }
  const low = response(); low.figures[0].links[0].confidence = 0.89;
  assert.equal(applyKnowledgeVision(source(), low, OPENAI_MODEL).links[0].status, "pending");
  assert.equal(applyKnowledgeVision({ ...source(), searchable: false }, response(), OPENAI_MODEL).links[0].status, "pending");
  assert.equal(knowledgeVisionSchema.safeParse({ ...response(), figures: [{ ...response().figures[0], bounds: [0, 0, 2, 1] }] }).success, false);
  const wholePage = response(); wholePage.figures[0].bounds = [0, 0, 1, 1];
  assert.equal(applyKnowledgeVision(source(), wholePage, OPENAI_MODEL).figures.length, 0);
  const grounded = { ...source(), figureCandidates: [{ id: "hook", title: "원본 그림", bounds: [0.1, 0.1, 0.2, 0.2] }] };
  assert.deepEqual(applyKnowledgeVision(grounded, wholePage, OPENAI_MODEL).figures[0].bounds, grounded.figureCandidates[0].bounds);
});

test("partial table approval indexes approved rows but keeps uncertain OCR out of search", () => {
  const pending = makeKnowledgeStructure(13, 1, "판독되지 않은 주변 글입니다.", false, [table]);
  const chunks = structureChunks(pending);
  assert.ok(chunks.some(chunk => chunk.text.includes("위험성평가")));
  assert.ok(chunks.every(chunk => !chunk.text.includes("판독되지 않은")));
  const uncertain = structuredClone(table); uncertain.cells[5].text += "[원본 기호 확인]";
  const indexed = structureChunks(makeKnowledgeStructure(13, 1, "", true, [uncertain]));
  assert.ok(indexed.every(chunk => !chunk.text.includes("위험성평가")));
  assert.ok(indexed.some(chunk => chunk.text.includes("위험요인 전달")));
});

test("approving one link indexes only that quote on a pending page; excluding the page removes every approved row", async () => {
  const directory = temp();
  try {
    const initial = { ...source(), searchable: false };
    const structure = applyKnowledgeVision(initial, response(), OPENAI_MODEL);
    const base = new KnowledgeBase(directory);
    const document = base.addImported(meta, "pending-hash", Buffer.from("pdf"), [{ page: 42, text: initial.text, method: "text", confidence: null,
      needsReview: true, reviewReason: "구조 확인", structure }]);
    const handlers = createKnowledgeStructureHandlers({ directory, env });
    const request = (body: unknown) => new Request("http://localhost:3000/api/knowledge/structure", { method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify(body) });
    const approved = await handlers.POST(request({ action: "link", id: document.id, page: 42, linkId: structure.links[0].id, approve: true }));
    assert.equal(approved.status, 200);
    assert.ok(base.search("훅 손상으로 인양물이 떨어지는 사고").some(ref => ref.visuals?.length));
    assert.equal(base.search("샤클핀 체결 상태를 별도로 점검").length, 0);
    assert.equal(base.structures(document.id)[0].searchable, false);
    const saved = base.structures(document.id)[0];
    assert.equal(applyKnowledgeVision(saved, { tables: [], figures: [] }, OPENAI_MODEL).links[0].status, "verified", "reanalysis keeps explicit review");
    base.recheckPending(document.id, [{ originalPage: 42, result: { page: 1, text: "다시 읽은 불확실한 문장입니다.",
      method: "text", confidence: null, needsReview: true, reviewReason: "확인 필요" } }]);
    assert.ok(base.search("훅 손상으로 인양물이 떨어지는 사고").some(ref => ref.visuals?.length), "recheck keeps a manually approved quote and its figure");
    assert.equal(base.resolvePage(document.id, 42, "exclude"), true);
    assert.equal(base.search("인양물 떨어지는 사고").length, 0);
    assert.equal((await handlers.POST(request({ action: "analyze", id: document.id, page: 42 }))).status, 404);
    base.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("reopening an analyzed page uses persisted results without another provider call", async () => {
  const directory = temp();
  try {
    const structure = applyKnowledgeVision(source(), response(), OPENAI_MODEL);
    const base = new KnowledgeBase(directory);
    const document = base.addImported(meta, "cached", Buffer.from("pdf"), [{ page: 42, text: structure.text, method: "text", confidence: null,
      needsReview: false, reviewReason: "", structure }]); base.close();
    let calls = 0;
    const handlers = createKnowledgeStructureHandlers({ directory, env, fetch: async () => { calls++; throw new Error("must not call"); } });
    const result = await handlers.POST(new Request("http://localhost:3000/api/knowledge/structure", { method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ action: "analyze", id: document.id, page: 42 }) }));
    assert.equal(result.status, 200); assert.equal((await result.json()).cached, true); assert.equal(calls, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("PDF ingestion persists a real merged grid and its empty checklist cells", async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([500, 400]);
  for (const y of [50, 150, 250, 350]) page.drawLine({ start: { x: 40, y }, end: { x: 460, y }, thickness: 1 });
  for (const x of [40, 320, 390, 460]) page.drawLine({ start: { x, y: 50 }, end: { x, y: 350 }, thickness: 1 });
  page.drawLine({ start: { x: 140, y: 50 }, end: { x: 140, y: 250 }, thickness: 1 });
  for (const [text, x, y] of [["PREPARATION", 55, 300], ["YES", 330, 300], ["NO", 405, 300], ["STEP 1", 55, 200], ["Risk assessment", 150, 200], ["STEP 2", 55, 100], ["Inform workers", 150, 100]] as const)
    page.drawText(text, { x, y, size: 10 });
  const result = await analyzeKnowledgePdf(Buffer.from(await pdf.save()), "", new AbortController().signal);
  const structure = result.pages[0].structure!;
  assert.equal(result.pages[0].needsReview, false);
  assert.equal(structure.tables[0].cells.find(cell => cell.text === "PREPARATION")?.colSpan, 2);
  assert.ok(structure.tables[0].cells.filter(cell => !cell.text).length >= 4);
  assert.match(result.pages[0].text, /빈 응답 칸: 미기입/);
});

test("PDF table numeric scripts preserve geometry without converting baseline digits or fractions", async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([500, 500]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const y of [50, 250, 450]) page.drawLine({ start: { x: 40, y }, end: { x: 460, y }, thickness: 1 });
  for (const x of [40, 250, 460]) page.drawLine({ start: { x, y: 50 }, end: { x, y: 450 }, thickness: 1 });
  page.drawText("VOLUME AND FLOW", { x: 60, y: 420, size: 12, font });
  page.drawText("Original units and indices", { x: 265, y: 420, size: 12, font });
  const formula = (prefix: string, exponent: string, suffix: string, y: number, shift: number, size = 7.5) => {
    const x = 65 + font.widthOfTextAtSize(prefix, 12);
    page.drawText(prefix, { x: 65, y, size: 12, font });
    page.drawText(exponent, { x, y: y + shift, size, font });
    page.drawText(suffix, { x: x + font.widthOfTextAtSize(exponent, size), y, size: 12, font });
  };
  formula("600m", "3", "/hr", 220, 5);
  formula("Area=20m", "2", "", 195, 5);
  formula("10", "-12", "", 170, 5);
  formula("CO", "2", " level", 145, -3);
  formula("m", "3", " baseline", 120, 0);
  formula("m", "3", " full size", 95, 3, 12);
  page.drawText("V(m3), 1/3, 30 min", { x: 265, y: 220, size: 12, font });
  const result = await analyzeKnowledgePdf(Buffer.from(await pdf.save()), "", new AbortController().signal);
  const structure = result.pages[0].structure!;
  const text = structure.tables[0].cells.map(cell => cell.text).join("\n");
  for (const expected of ["600m³/hr", "20m²", "10⁻¹²", "CO₂", "V(m3), 1/3, 30 min"])
    assert.ok(text.includes(expected), `${expected}: ${text}`);
  assert.equal((text.match(/³/g) ?? []).length, 1, "baseline/same-size digits must not become exponents");
  assert.ok(structureChunks(structure).some(chunk => chunk.text.includes("600m³/hr")), "search text keeps the original exponent");
});

test("stored source mapping, exact block retrieval, cache and deletion survive reopening", () => {
  const directory = temp();
  try {
    let base = new KnowledgeBase(directory);
    const structure = source();
    const document = base.addImported(meta, "hash", Buffer.from("pdf"), [{ page: 42, text: structure.text, method: "text", confidence: null, needsReview: false, reviewReason: "", structure }]);
    assert.equal(base.saveStructure(document.id, applyKnowledgeVision(structure, response(), OPENAI_MODEL), JSON.stringify(structure)), true);
    assert.equal(base.saveStructure(document.id, structure, JSON.stringify(structure)), false, "stale results cannot overwrite a new analysis");
    base.close(); base = new KnowledgeBase(directory);
    assert.equal(base.structures(document.id)[0].filePage, 1);
    assert.equal(base.structures(document.id)[0].analyzed, true);
    const hook = base.search("훅 손상으로 인양물이 떨어지는 사고");
    assert.ok(hook.some(ref => ref.visuals?.length === 1 && ref.page === 42));
    assert.ok(base.search("샤클핀 체결 상태를 별도로 점검").every(ref => !ref.visuals?.length));
    base.setActive(document.id, false); assert.equal(base.search("인양물 사고").length, 0);
    assert.equal(base.deleteDocument(document.id), true); assert.deepEqual(base.structures(document.id), []);
    base.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("mini calls count and generate identical inputs, charge one bounded attempt and keep secrets out", async () => {
  const directory = temp();
  try {
    const calls: Record<string, any>[] = [];
    const config = knowledgeVisionConfig(directory, env);
    const result = await analyzeKnowledgeVision(source(), Buffer.from("image"), config, directory, new AbortController().signal, {
      fetch: async (url, init) => { calls.push(JSON.parse(String(init?.body))); return json(String(url).endsWith("/input_tokens") ? { input_tokens: 2100 } : completed(response())); },
    });
    assert.equal(result.structure.links[0].status, "verified"); assert.equal(calls.length, 2);
    for (const key of ["input", "model", "instructions", "text", "reasoning"]) assert.deepEqual(calls[0][key], calls[1][key]);
    assert.equal(calls[1].model, OPENAI_MODEL); assert.equal(calls[1].store, false); assert.deepEqual(calls[1].tools, []);
    assert.equal(calls[1].max_output_tokens, 6000);
    assert.ok(!JSON.stringify(calls).includes(env.EDUFLOW_AI_API_KEY));
    assert.ok(!JSON.stringify(calls[1].text).includes("prefixItems"));
    const db = new DatabaseSync(join(directory, "ai-budget.sqlite"));
    const reservation = db.prepare("SELECT * FROM reservations").get()!;
    assert.equal(reservation.attempts, 1); assert.equal(reservation.active, 0);
    assert.equal(db.prepare("SELECT amount FROM budgets LIMIT 1").get()!.amount, config.attemptCost); db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("oversized input never starts a paid call and releases its unused reservation", async () => {
  const directory = temp(); let calls = 0;
  try {
    const config = knowledgeVisionConfig(directory, env);
    await assert.rejects(analyzeKnowledgeVision(source(), Buffer.from("image"), config, directory, new AbortController().signal,
      { fetch: async () => { calls++; return json({ input_tokens: 200000 }); } }), (error: unknown) => error instanceof GenerationError && error.code === "TOKEN_LIMIT_EXCEEDED");
    assert.equal(calls, 1);
    const db = new DatabaseSync(join(directory, "ai-budget.sqlite"));
    assert.equal(db.prepare("SELECT amount FROM budgets LIMIT 1").get()!.amount, 0); db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("figure cropping uses original page coordinates and local endpoint rejects outside writes", async () => {
  const canvas = createCanvas(200, 100); const ctx = canvas.getContext("2d");
  ctx.fillStyle = "red"; ctx.fillRect(0, 0, 200, 100);
  const image = await loadImage(await cropKnowledgeFigure(canvas.toBuffer("image/png"), { id: "f", title: "test", bounds: [0.1, 0.2, 0.6, 0.8] }));
  assert.equal(image.width, 100); assert.equal(image.height, 60);
  const directory = temp();
  try {
    const handlers = createKnowledgeStructureHandlers({ directory, env });
    const denied = await handlers.POST(new Request("http://localhost:3000/api/knowledge/structure", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://other.test" }, body: JSON.stringify({ action: "prepare", id: crypto.randomUUID() }) }));
    assert.equal(denied.status, 403);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("only cited references contribute visuals, preserved through board storage and both exports", async () => {
  const documentId = crypto.randomUUID();
  const structure = applyKnowledgeVision(source(), response(), OPENAI_MODEL);
  const visuals = recommendationsForBlocks(documentId, structure, [structure.blocks[0].id]);
  const references = [{ id: "knowledge:test:1", documentId, ...meta, url: "", excerpt: source().blocks[0].text, page: 42, visuals }];
  const board = generateDemo(sample, defaults);
  const output = { title: board.title, summary: board.summary, objectives: board.objectives, scenes: board.scenes.map(scene => ({
    sceneNo: board.scenes.indexOf(scene) + 1, title: scene.title, purpose: scene.purpose, visual: scene.visual, assets: scene.assets,
    narration: scene.narration, subtitle: scene.subtitle, duration: scene.duration, evidence: scene.evidence, sourceId: scene.sourceId,
    referenceIds: board.scenes.indexOf(scene) === 1 ? [references[0].id] : [],
  })) };
  const generated = await runGeneration({ manuscript: sample, settings: defaults }, { mode: "ai", model: "mock", promptVersion: "test", generate: async () => output }, { references });
  assert.equal(generated.scenes[0].visuals?.length, 0); assert.equal(generated.scenes[1].visuals?.length, 1);
  const restored = boardSchema.parse(JSON.parse(JSON.stringify(generated)));
  assert.equal(restored.scenes[1].visuals?.[0].page, 42);
  assert.ok(markdown(restored).includes("시각자료 추천")); assert.ok(markdown(restored).includes(visuals[0].figureId));
});

test("visual-only source selection recommends verified pictures without inventing narration citations", async () => {
  const documentId = crypto.randomUUID();
  const structure = applyKnowledgeVision(source(), response(), OPENAI_MODEL);
  const visuals = recommendationsForBlocks(documentId, structure, [structure.blocks[0].id]);
  const references = [
    { id: "knowledge:visual", documentId, ...meta, url: "", excerpt: structure.blocks[0].text, page: 42, blockIds: [structure.blocks[0].id], visuals },
    { id: "knowledge:text", documentId, ...meta, url: "", excerpt: structure.blocks[1].text, page: 42, visuals: [] },
  ];
  const demo = generateDemo(sample, defaults);
  const output = { title: demo.title, summary: demo.summary, objectives: demo.objectives, scenes: demo.scenes.map((scene, index) => ({
    sceneNo: index + 1, title: scene.title, purpose: scene.purpose, visual: scene.visual, assets: scene.assets,
    narration: scene.narration, subtitle: scene.subtitle, duration: scene.duration, evidence: scene.evidence, sourceId: scene.sourceId,
    referenceIds: [], visualReferenceIds: index === 1 ? ["knowledge:visual", "knowledge:visual", "knowledge:text", "knowledge:forged"] : [],
  })) };
  const input = { manuscript: sample, settings: defaults };
  assert.ok(generationTask(input, references).visualGuidance.includes("새 사실의 보강 여부와 무관"));
  const generated = await runGeneration(input, { mode: "ai", model: "mock", promptVersion: "test", generate: async (_, context) => {
    assert.deepEqual(context.task.supplementalSources, references);
    return output;
  } }, { references });
  assert.deepEqual(generated.generation?.knowledge, { retrievedCount: 2, documentCount: 1 });
  assert.equal(generated.generation?.knowledgeSources?.length, 2);
  assert.deepEqual(generated.generation?.knowledgeSources?.[1].visuals, []);
  assert.equal(generated.scenes[1].references?.length, 0);
  assert.equal(generated.scenes[1].visualReferences?.length, 1);
  assert.equal(generated.scenes[1].visuals?.length, 1);
  assert.equal(generated.scenes[0].visuals?.length, 0);
  assert.ok(generated.generation?.warnings.some(warning => warning.includes("확인되지 않은")));
  const restored = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board: generated })).board!;
  assert.deepEqual(restored.scenes[1].visualReferences, generated.scenes[1].visualReferences);
  assert.deepEqual(restored.scenes[1].generation?.knowledge, generated.generation?.knowledge);
  assert.deepEqual(restored.generation?.knowledgeSources, generated.generation?.knowledgeSources);
  assert.ok(markdown(restored).includes("시각자료 지식베이스 근거"));
  assert.ok(markdown(restored).includes(`문서 ID: ${documentId}`));
  const regeneration = await runGeneration({ ...input, scene: restored.scenes[1] }, { mode: "ai", model: "mock", promptVersion: "test", generate: async () => ({ ...output, scenes: [{ ...output.scenes[1], sceneNo: 1, visualReferenceIds: [], referenceIds: [] }] }) }, { references });
  assert.equal(regeneration.scenes[0].id, restored.scenes[1].id);
  assert.deepEqual(regeneration.scenes[0].visuals, []);
  assert.deepEqual(regeneration.scenes[0].visualReferences, []);
});

test("the model cites sources by short prompt ids while the board keeps the full ids", async () => {
  const documentId = crypto.randomUUID();
  const references = ["knowledge:long:1", "knowledge:long:2"].map((id, index) =>
    ({ id, documentId, ...meta, url: "", excerpt: `보강 구절 ${index + 1}입니다.`, page: 3, visuals: [] }));
  const demo = generateDemo(sample, defaults);
  const input = { manuscript: sample, settings: defaults };
  let promptIds: string[] = [];
  const generated = await runGeneration(input, { mode: "ai", model: "mock", promptVersion: "test", generate: async (_, context) => {
    promptIds = promptTask(context.task).supplementalSources.map((source) => source.id);
    return { title: demo.title, summary: demo.summary, objectives: demo.objectives, scenes: demo.scenes.map((scene, index) => ({
      sceneNo: index + 1, title: scene.title, purpose: scene.purpose, visual: scene.visual, assets: scene.assets,
      narration: scene.narration, subtitle: scene.subtitle, duration: scene.duration, evidence: scene.evidence, sourceId: scene.sourceId,
      referenceIds: index === 1 ? ["S2", "knowledge:long:2", "S9"] : [], visualReferenceIds: [],
    })) };
  } }, { references });
  assert.deepEqual(promptIds, ["S1", "S2"]);
  assert.deepEqual(generated.scenes[1].references?.map((reference) => reference.id), ["knowledge:long:2"], "S2 and its full id are one source");
  assert.ok(generated.generation?.warnings.some((warning) => warning.startsWith("2번 장면") && warning.includes("확인되지 않은")), "S9 was never sent");
});

test("knowledge locations preserve original versus stored PDF page and remain inspectable after exclusion", async () => {
  const directory = temp();
  const base = new KnowledgeBase(directory);
  try {
    const pdf = Buffer.from(await (await PDFDocument.create()).save());
    const structure = applyKnowledgeVision(source(), response(), OPENAI_MODEL);
    const document = base.addImported(meta, "location-pdf", pdf, [{ page: 42, text: structure.text, method: "text", confidence: null, needsReview: false, reviewReason: "", structure }]);
    const url = `http://localhost:3000/api/knowledge/location?id=${document.id}&page=42`;
    const result = await readKnowledgeLocation(new Request(url), directory);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
    const location = await result.json();
    assert.equal(location.page, 42); assert.equal(location.filePage, 1);
    assert.equal(location.passages[0].id, structure.blocks[0].id);
    assert.equal(location.passages[0].text, structure.blocks[0].text);
    const link = new URL(knowledgeLocationUrl({ documentId: document.id, page: 42, blockIds: [structure.blocks[0].id], figureId: structure.figures[0].id }), "http://localhost");
    assert.equal(link.searchParams.get("page"), "42"); assert.equal(link.searchParams.get("document"), document.id);
    base.setActive(document.id, false);
    assert.equal((await (await readKnowledgeLocation(new Request(url), directory)).json()).document.active, false);
    assert.equal((await readKnowledgeLocation(new Request(url.replace("page=42", "page=1")), directory)).status, 404);
    assert.equal((await readKnowledgeLocation(new Request(url.replace("page=42", "page=-1")), directory)).status, 400);
    assert.equal((await readKnowledgeLocation(new Request(url.replace("localhost:3000", "other.test")), directory)).status, 403);
    base.deleteDocument(document.id);
    assert.equal((await readKnowledgeLocation(new Request(url), directory)).status, 404);
    const text = base.add({ ...meta, text: "[PDF 42페이지]\n\n훅 손상으로 인양물이 떨어지는 사고가 발생하므로 체결 상태를 점검합니다." });
    const textLocation = base.location(text.id, 42)!;
    assert.equal(textLocation.filePage, undefined);
    assert.ok(textLocation.passages[0].text.includes("훅 손상"));
  } finally { base.close(); rmSync(directory, { recursive: true, force: true }); }
});
