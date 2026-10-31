import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyKnowledgeVision, makeKnowledgeStructure, type KnowledgeTable } from "./knowledge-structure";
import { visualSearchTerms } from "./knowledge-visual-search";
import { KnowledgeBase } from "./server/knowledge-base";
import { promptKnowledgeSources, promptTask } from "./server/provider-prompt";
import { defaults, generateDemo, markdown, sample } from "./storyboard";
import { runGeneration } from "./server/generation-service";
import { readDraft, serializeDraft } from "./studio-state";

const table: KnowledgeTable = { id: "ventilation", rows: 3, cols: 3, cells: [
  { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "구분" },
  { row: 1, col: 2, rowSpan: 1, colSpan: 2, text: "환기팬 용량과 체적" },
  { row: 2, col: 1, rowSpan: 1, colSpan: 1, text: "환기방법" },
  { row: 2, col: 2, rowSpan: 1, colSpan: 1, text: "작업장 체적의 10배 급기" },
  { row: 2, col: 3, rowSpan: 1, colSpan: 1, text: "" },
  { row: 3, col: 1, rowSpan: 1, colSpan: 1, text: "환기팬 용량" },
  { row: 3, col: 2, rowSpan: 1, colSpan: 1, text: "600m³, 200m³/min, 30분" },
  { row: 3, col: 3, rowSpan: 1, colSpan: 1, text: "" },
] };
const meta = { title: "밀폐공간 안내", origin: "internal" as const, published: "2026", revision: "1" };
const query = "600m3 200m3/min 30min ".repeat(50) + "작업장 체적의 환기팬 용량과 급기";

function fixture(t: TestContext, reviewable = false) {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-visual-search-"));
  const base = new KnowledgeBase(directory);
  t.after(() => { base.close(); rmSync(directory, { recursive: true, force: true }); });
  const raw = makeKnowledgeStructure(24, 3,
    "환기량 계산 예시. 환기팬 용량은 작업장 체적으로 계산합니다.\n\n방독면 필터 교체 주기를 확인합니다.", true, [table]);
  if (reviewable) { raw.searchable = false; raw.approvedBlockIds = [raw.blocks[0].id]; }
  const structure = applyKnowledgeVision(raw, { tables: [], figures: [{ id: "ventilation-image", title: "환기량 계산 예시", bounds: [0.6, 0.6, 0.9, 0.9],
    links: [{ blockId: raw.blocks[0].id, quote: "환기량 계산 예시.", reason: "작업장 체적을 기준으로 환기팬 용량을 계산하는 그림입니다.", relationship: "illustrates", confidence: 0.98 }] }] }, "test");
  const document = base.addImported(meta, "visual-fixture", Buffer.from("test-pdf"), [{
    page: 24, text: structure.text, method: "text", confidence: null, needsReview: reviewable, reviewReason: "", structure,
  }]);
  return { base, document, structure };
}

test("numeric-heavy queries retrieve verified pictures through linked context and accepted tables through a separate channel", t => {
  const { base, document, structure } = fixture(t);
  assert.ok(!visualSearchTerms(query).includes("600"));
  assert.ok(visualSearchTerms(query).includes("환기팬"));
  const results = base.search(query);
  const visuals = results.flatMap(result => result.visuals ?? []);
  assert.equal(visuals.filter(visual => visual.kind !== "table").length, 1);
  assert.equal(visuals.filter(visual => visual.kind === "table").length, 1);
  assert.ok(results.some(result => !result.visuals?.length), "text evidence still has its own slots");
  assert.ok(results.length <= 6 && results.every(result => result.id.length <= 100));
  assert.ok(visuals.every(visual => visual.page === 24 && visual.filePage === 3 && visual.documentId === document.id));
  assert.equal(visuals.find(visual => visual.kind !== "table")!.quote, "환기량 계산 예시.");
  assert.deepEqual(visuals.find(visual => visual.kind === "table")!.table, table);
  assert.equal(base.searchVisuals("방독면 필터 교체 주기").length, 0, "a different block on the same page cannot supply an unrelated image");
  assert.equal(base.searchVisuals(query, 4, "용접 화기작업").length, 0);
  assert.equal(base.search(query, 1).length, 1);
  assert.equal(base.search(query, 0).length, 0);
  const duplicateLink = structuredClone(structure);
  duplicateLink.links.push({ ...duplicateLink.links[0], id: "another-verified-link" });
  assert.ok(base.saveStructure(document.id, duplicateLink, JSON.stringify(structure)));
  assert.equal(base.searchVisuals(query).filter(ref => ref.visuals?.[0].kind !== "table").length, 1, "one card per asset");
  base.setActive(document.id, false);
  assert.deepEqual(base.searchVisuals(query), []);
});

test("unverified images and proposed tables do not become recommendations; excluded pages stay excluded", t => {
  const { base, document, structure } = fixture(t, true);
  const next = structuredClone(structure);
  next.links[0].status = "pending";
  next.proposedTables = next.tables;
  next.tables = [];
  assert.ok(base.saveStructure(document.id, next, JSON.stringify(structure)));
  assert.deepEqual(base.searchVisuals(query), []);
  next.links[0].status = "rejected";
  const pending = base.structures(document.id)[0];
  assert.ok(base.saveStructure(document.id, next, JSON.stringify(pending)));
  assert.deepEqual(base.searchVisuals(query), []);
  const current = base.structures(document.id)[0];
  assert.ok(base.saveStructure(document.id, structure, JSON.stringify(current)));
  assert.ok(base.searchVisuals(query).length);
  assert.equal(base.resolvePage(document.id, 24, "exclude"), true);
  assert.deepEqual(base.searchVisuals(query), []);
});

test("selected figure and table reach the scene, draft and export while full table cells stay out of the AI prompt", async t => {
  const { base } = fixture(t);
  const references = base.search(query);
  const visualReferences = references.filter(ref => ref.visuals?.length);
  const prompt = promptKnowledgeSources(references);
  const tablePrompt = prompt.flatMap(ref => ref.visuals ?? []).find(visual => visual.kind === "table")!.table!;
  assert.deepEqual(tablePrompt, { id: table.id, rows: 3, cols: 3 });
  assert.deepEqual(visualReferences.find(ref => ref.visuals![0].kind === "table")!.visuals![0].table, table);
  const demo = generateDemo(sample, defaults);
  const board = await runGeneration({ manuscript: sample, settings: defaults }, {
    mode: "ai", model: "mock", promptVersion: "test", generate: async () => ({
      title: demo.title, summary: demo.summary, objectives: demo.objectives,
      scenes: demo.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, index) => ({
        ...scene, sceneNo: index + 1, referenceIds: [], visualReferenceIds: index === 1 ? visualReferences.map(ref => ref.id) : [],
      })),
    }),
  }, { references });
  const scene = board.scenes[1];
  assert.equal(scene.visuals?.length, 2);
  assert.equal(scene.references?.length, 0, "a visual recommendation does not invent a narration citation");
  const retryPrompt = promptTask({ supplementalSources: references, selectedScene: scene });
  assert.ok(!JSON.stringify(retryPrompt).includes('"cells"'), "regeneration also omits repeated full table snapshots");
  assert.deepEqual(scene.visuals?.find(visual => visual.kind === "table")?.table, table);
  const restored = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board })).board!;
  assert.deepEqual(restored.scenes[1].visuals, scene.visuals);
  assert.match(markdown(restored), /표 ID: ventilation/);
  assert.match(markdown(restored), /그림 ID: ventilation-image/);
});

test("table card markup preserves merged cells and empty answers", () => {
  // Render under normal React conditions; the server test runner uses react-server.
  const markup = execFileSync(process.execPath, ["--import", "tsx", "-e", `
    global.React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { KnowledgeTablePreview } = require('./components/knowledge-table-preview.tsx');
    process.stdout.write(renderToStaticMarkup(React.createElement(KnowledgeTablePreview, {table: JSON.parse(process.argv[1])})));
  `, JSON.stringify(table)], { cwd: process.cwd(), encoding: "utf8" });
  assert.match(markup, /colSpan="2"/i);
  assert.equal((markup.match(/aria-label="빈 셀"/g) ?? []).length, 2);
  assert.match(markup, /600m³, 200m³\/min, 30분/);
  assert.match(markup, /<caption class="sr-only">추천 표의 추출 내용<\/caption>/);
});


test("unused text slots admit additional relevant visuals without increasing the combined limit", t => {
  const { base, document, structure } = fixture(t);
  const expanded = structuredClone(structure);
  for (let i = 1; i <= 4; i++) {
    const figure = { ...expanded.figures[0], id: `ventilation-alternative-${i}`, title: `환기팬 용량 계산 도해 ${i}` };
    expanded.figures.push(figure);
    expanded.links.push({ ...expanded.links[0], id: `link-alternative-${i}`, figureId: figure.id });
  }
  assert.ok(base.saveStructure(document.id, expanded, JSON.stringify(structure)));
  const results = base.search(query);
  const visuals = results.flatMap(reference => reference.visuals ?? []);
  assert.equal(results.length, 6);
  assert.ok(results.some(reference => !reference.visuals?.length), "text evidence is retained");
  assert.ok(visuals.length >= 4, "available slots are not discarded after three visuals");
  assert.ok(visuals.some(visual => visual.kind === "table"));
  assert.ok(visuals.some(visual => visual.kind !== "table"));
  assert.deepEqual(base.search(query), results, "the same stored data and query give stable candidates");
  for (const limit of [0, 1, 2, 3, 6]) assert.ok(base.search(query, limit).length <= limit);
});
