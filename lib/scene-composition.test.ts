import assert from "node:assert/strict";
import test from "node:test";
import { PDFParse } from "pdf-parse";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { defaults, generateDemo, sample, sceneSchema, visualPlacementSchema, plainText } from "./storyboard";
import type { VisualRecommendation } from "./knowledge-structure";
import { activeVisualReferences, activeVisuals, setVisualUsage, relayoutVisualPlacements, clampVisualPlacement, compositionBackgroundRect, compositionLayouts, compositionOverlaySvg, compositionPlaceholderSvg, compositionSubtitle, compositionStickers, defaultVisualPlacements, resizeVisualPlacement, sceneVisualPlacements } from "./scene-composition";
import { sceneImageInput } from "./scene-image";
import { sceneImagePrompt } from "./server/scene-image";
import { readDraft, serializeDraft } from "./studio-state";
import { editScene, moveScene, replaceScene } from "./board-edit";
import { exportStoryboardPdf } from "./server/pdf-export";
import { loadCompositionAssets } from "./composition-assets";
import { createCompositionAssetLoader } from "./server/composition-assets";
import { renderCompositionOverlay } from "./server/composition-render";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeBase } from "./server/knowledge-base";
import { applyKnowledgeVision, makeKnowledgeStructure } from "./knowledge-structure";
import { rgb } from "pdf-lib";

function visual(index: number): VisualRecommendation {
  return { id: `visual-${index}`, figureId: `figure-${index}`, blockId: "block-1", documentId: "9cfbce44-9965-4efc-8c21-c4ba6807a6ca",
    page: 7, filePage: 1, title: index === 1 ? "안전모 착용 그림" : "점검 항목 표", quote: "원문에서 확인한 자료입니다.", reason: "장면의 행동을 설명합니다.", model: "test", confidence: .98,
    ...(index === 1 ? { kind: "figure", bounds: [.1, .1, .9, .9] } : { kind: "table", table: { id: `figure-${index}`, rows: 2, cols: 2,
      cells: [1, 2].flatMap(row => [1, 2].map(col => ({ row, col, rowSpan: 1, colSpan: 1, text: "FULL_TABLE_CELL_NOT_FOR_IMAGE_API" }))) } }) };
}
function board() {
  const result = generateDemo(sample, defaults);
  result.scenes[0] = { ...result.scenes[0], visual: "자료를 오른쪽에 놓고 작업자는 왼쪽에서 설명한다.", visuals: [visual(1), visual(2)] };
  return result;
}

test("unused visual recommendations stay excluded through layout, save, image inputs and TXT, and can be restored", () => {
  const original = board();
  const scene = original.scenes[0];
  scene.visuals![0] = { ...scene.visuals![0], title: "UNUSED_VISUAL_TITLE", page: 6 };
  scene.visualReferences = scene.visuals!.map((item, index) => ({ id: `source-${index}`, documentId: item.documentId,
    title: index === 0 ? "UNUSED_VISUAL_SOURCE" : "ACTIVE_VISUAL_SOURCE", page: item.page, excerpt: item.quote,
    origin: "official", published: "", revision: "", url: "", visuals: [item] }));
  const disabled = { ...scene, visualPlacements: setVisualUsage(scene, "visual-1", false) };
  assert.deepEqual(activeVisuals(disabled).map(item => item.id), ["visual-2"]);
  assert.deepEqual(compositionStickers(disabled).map(item => item.visualId), ["visual-2"]);
  assert.deepEqual(activeVisualReferences(disabled).map(item => item.id), ["source-1"]);
  for (const layout of Object.keys(compositionLayouts) as (keyof typeof compositionLayouts)[]) {
    assert.deepEqual(relayoutVisualPlacements(disabled, layout).map(item => item.visualId), ["visual-2"]);
  }
  const input = sceneImageInput(disabled, defaults, { style: "sketch", direction: "" });
  assert.equal(input.scene.composition.length, 1);
  assert.deepEqual(input.scene.visualReferences.map(item => item.id), ["source-1"]);
  original.scenes[0] = disabled;
  const restored = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board: original })).board!;
  assert.deepEqual(restored.scenes[0].visualPlacements, disabled.visualPlacements);
  assert.doesNotMatch(plainText(restored), /UNUSED_VISUAL_TITLE|UNUSED_VISUAL_SOURCE/);
  assert.match(plainText(restored), /ACTIVE_VISUAL_SOURCE/);
  const enabled = { ...disabled, visualPlacements: setVisualUsage(disabled, "visual-1", true) };
  assert.equal(compositionStickers(enabled).length, 2);
  assert.equal(setVisualUsage(enabled, "visual-1", true).length, 2, "restoring twice cannot duplicate placement");
  assert.equal(enabled.visualPlacements.find(item => item.visualId === "visual-2"), disabled.visualPlacements[0], "other positions are preserved");
  const empty = { ...disabled, visualPlacements: setVisualUsage(disabled, "visual-2", false) };
  assert.deepEqual(relayoutVisualPlacements(empty), []);
  assert.deepEqual(activeVisualReferences(empty), []);
  assert.equal(scene.visuals!.length, 2, "source recommendations remain available for reuse");
});

test("recommended composition uses real source identities and keeps all twenty assets in bounds in every preset", () => {
  const scene = board().scenes[0];
  assert.equal(defaultVisualPlacements(scene)[0].x, 38);
  assert.equal(defaultVisualPlacements({ ...scene, visual: "화면 왼쪽에 그림과 표를 배치하고, 오른쪽에는 설명자가 자료를 가리킨다." })[0].x, 5);
  for (const layout of Object.keys(compositionLayouts) as (keyof typeof compositionLayouts)[]) {
    const crowded = { ...scene, visuals: Array.from({ length: 20 }, (_, i) => visual(i + 1)) };
    const placements = defaultVisualPlacements(crowded, layout);
    assert.equal(placements.length, 20);
    assert.ok(placements.every(placement => visualPlacementSchema.safeParse(placement).success));
    for (let i = 0; i < placements.length; i++) for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i], b = placements[j];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, "initial stickers must not overlap");
    }
  }
  assert.equal(sceneVisualPlacements({ ...scene, visuals: [visual(1), visual(1)] }).length, 1);
  assert.deepEqual(sceneVisualPlacements({ ...scene, visualPlacements: [] }), [], "hidden stickers stay hidden");
  const placements = defaultVisualPlacements(scene);
  assert.equal(sceneVisualPlacements({ ...scene, visuals: [visual(2)], visualPlacements: placements }).length, 1, "removed sources do not leave orphan stickers");
  assert.equal(sceneSchema.safeParse({ ...scene, visualPlacements: [placements[0], placements[0]] }).success, false);
  assert.equal(visualPlacementSchema.safeParse({ ...placements[0], x: 90, width: 40 }).success, false);
  assert.deepEqual(clampVisualPlacement({ visualId: "source", x: 120, y: -10, width: 50, height: 500 }), { visualId: "source", x: 50, y: 0, width: 50, height: 100 });
});

test("manual positions survive draft reload, scene movement and text regeneration; image prompts get coordinates but not table cells", () => {
  const original = board(), scene = original.scenes[0];
  const placements = defaultVisualPlacements(scene).map(p => ({ ...p, x: 8, width: 40 }));
  const updated = editScene(original, 0, "visualPlacements", placements);
  const restored = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board: updated })).board!;
  assert.deepEqual(restored.scenes[0].visualPlacements, placements);
  assert.deepEqual(moveScene(restored, 0, 1)!.scenes[1].visualPlacements, placements);
  assert.deepEqual(replaceScene(restored, scene.id, scene).scenes[0].visualPlacements, placements);
  const input = sceneImageInput(restored.scenes[0], defaults, { style: "sketch", direction: "" });
  assert.equal(input.scene.composition[0].x, 8);
  const prompt = sceneImagePrompt(input);
  assert.ok(!prompt.includes("FULL_TABLE_CELL_NOT_FOR_IMAGE_API"));
  assert.match(prompt, /배치와 구도/); assert.match(prompt, /빈 자료판/);
  assert.deepEqual(compositionStickers(restored.scenes[0]).map(s => [s.label, s.kind]), [["추천 시각자료 1", "그림"], ["추천 시각자료 2", "표"]]);
});

test("export overlay places readable source markers at saved coordinates and escapes source titles", async () => {
  const scene = board().scenes[0];
  scene.visuals![0].title = '<script>alert("x")</script>';
  scene.visualPlacements = [{ visualId: "visual-1", x: 10, y: 20, width: 40, height: 50 }];
  const svg = compositionOverlaySvg(scene);
  assert.ok(!svg.includes("<script>")); assert.match(svg, /&lt;script/);
  const image = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(1600, 900), context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  assert.equal(context.getImageData(10, 10, 1, 1).data[3], 0, "outside sticker remains transparent");
  const inside = context.getImageData(170, 190, 1, 1).data;
  assert.ok(inside[0] > 230 && inside[1] > 220 && inside[3] > 230, "source placeholder covers its exact saved rectangle");
});

test("PDF includes the same numbered placeholders and source legend even without a generated image", async () => {
  const value = board(); value.scenes = [value.scenes[0]];
  value.scenes[0].visualPlacements = defaultVisualPlacements(value.scenes[0], "left");
  const bytes = await exportStoryboardPdf({ board: value, compositionAssets: {} });
  const parser = new PDFParse({ data: bytes });
  try {
    const text = (await parser.getText()).text.replace(/\s/g, "");
    assert.match(text, /추천시각자료1·그림/); assert.match(text, /추천시각자료2·표/);
    assert.match(text, /안전모착용그림\(7페이지\)/); assert.match(text, /점검항목표\(7페이지\)/);
  } finally { await parser.destroy(); }
});

test("corner resizing preserves the anchored corner and clamps size to the frame", () => {
  const placement = { visualId: "asset", x: 35, y: 20, width: 40, height: 50 };
  assert.deepEqual(resizeVisualPlacement(placement, 90, 100), { ...placement, width: 65, height: 80 });
  assert.deepEqual(resizeVisualPlacement(placement, -5, 1), { ...placement, width: 10, height: 10 });
  assert.deepEqual(resizeVisualPlacement(placement, NaN, Infinity), placement);
});

test("legacy background scaling is removed from saved drafts and all output uses fit", () => {
  const value = board();
  const image = { id: "background", sourceType: "upload", sourceText: "source", scalePercent: 60 };
  const restored = readDraft(JSON.stringify({ manuscript: sample, settings: defaults, board: { ...value, scenes: [{ ...value.scenes[0], image }] } })).board!;
  assert.ok(!("scalePercent" in restored.scenes[0].image!));
  for (const [width, height] of [[1600, 900], [900, 1600]]) {
    const png = compositionBackgroundRect(width, height, 1600, 900);
    const pdf = compositionBackgroundRect(width, height, 280, 157.5);
    for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(png[key] / 1600 - pdf[key] / 280) < 1e-9);
    assert.ok(Math.abs(png.width / png.height - width / height) < 1e-9);
  }
});

test("PDF fits the background and composes the actual asset overlay", async () => {
  const value = board(); value.scenes = [value.scenes[0]];
  value.scenes[0].image = { id: "background", sourceType: "upload", sourceText: "example" };
  const canvas = createCanvas(1600, 900); canvas.getContext('2d').fillRect(0, 0, 1600, 900);
  const bytes = await exportStoryboardPdf({ board: value, compositionAssets: {}, sceneImages: new Map([[value.scenes[0].id, canvas.toBuffer('image/png')]]) });
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.getPages()[0].node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
  const operators = streams.filter((stream): stream is PDFRawStream => stream instanceof PDFRawStream)
    .map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString('utf8')).join('\n');
  assert.match(operators, /280 0 0 157\.5 0 0 cm/);
  assert.doesNotMatch(operators, /140 0 0 78\.75 0 0 cm/);
});

test("real recommended pixels and extracted table cells render in the composition, while missing assets stay explicit", async () => {
  const scene = board().scenes[0];
  const canvas = createCanvas(160, 90), ctx = canvas.getContext('2d'); ctx.fillStyle = '#e02020'; ctx.fillRect(0, 0, 160, 90);
  let calls = 0;
  const loaded = await loadCompositionAssets(scene, { fetch: async url => {
    calls++; assert.match(String(url), /^\/api\/knowledge\/figure\?/);
    return new Response(new Uint8Array(canvas.toBuffer('image/png')), { headers: { 'content-type': 'image/png' } });
  } });
  assert.equal(calls, 1, 'tables use stored cells and never call the image endpoint');
  assert.deepEqual(loaded.missing, []);
  scene.visualPlacements = [{ visualId: 'visual-1', x: 0, y: 0, width: 60, height: 70 }]; scene.subtitleSettings = { enabled: false, position: 'auto' };
  const svg = compositionOverlaySvg(scene, loaded.assets);
  assert.match(svg, /data:image\/png;base64/);
  const image = await loadImage(await renderCompositionOverlay(scene, loaded.assets));
  const out = createCanvas(1600, 900), context = out.getContext('2d'); context.drawImage(image, 0, 0);
  const pixel = context.getImageData(480, 320, 1, 1).data;
  assert.ok(pixel[0] > 200 && pixel[1] < 80, 'the source photo itself must be visible, not a title-only placeholder');
  const missing = await loadCompositionAssets(scene, { fetch: async () => new Response('', { status: 404 }) });
  assert.deepEqual(missing.missing, ['visual-1']);
  assert.match(compositionOverlaySvg(scene, missing.assets), /원본 사진 확인 필요/);
  const tableOnly = { ...scene, visualPlacements: [{ visualId: 'visual-2', x: 5, y: 5, width: 60, height: 70 }] };
  assert.match(compositionOverlaySvg(tableOnly), /FULL_TABLE_CELL/);
  assert.ok(!compositionOverlaySvg(scene, { 'visual-1': 'https://external.invalid/image.png' }).includes('external.invalid'));
});

test("subtitles use the scene text, wrap safely and avoid lower source material automatically", () => {
  const scene = board().scenes[0]; scene.subtitle = '작업 전 안전모의 상태를 확인하세요.';
  scene.visualPlacements = [{ visualId: 'visual-1', x: 5, y: 50, width: 90, height: 45 }];
  const caption = compositionSubtitle(scene)!;
  assert.equal(caption.position, 'top'); assert.equal(caption.lines.join(''), scene.subtitle);
  scene.subtitleSettings = { enabled: true, position: 'bottom' };
  assert.equal(compositionSubtitle(scene)!.position, 'bottom');
  const value = board(); value.scenes[0] = scene;
  const restored = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board: value })).board!;
  assert.deepEqual(restored.scenes[0].subtitleSettings, scene.subtitleSettings);
  assert.deepEqual(replaceScene(restored, scene.id, { ...scene, subtitleSettings: undefined }).scenes[0].subtitleSettings, scene.subtitleSettings);
  assert.equal(compositionSubtitle({ ...scene, subtitle: '' }), null);
  assert.equal(compositionSubtitle({ ...scene, subtitleSettings: { enabled: false, position: 'auto' } }), null);
  assert.ok(compositionSubtitle({ ...scene, subtitle: '매우 긴 자막입니다. '.repeat(200) })!.truncated);
});

test("server export loader reads the same stored crop locally without AI calls", async t => {
  const directory = mkdtempSync(join(tmpdir(), 'eduflow-composition-assets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pdf = await PDFDocument.create(); const page = pdf.addPage([300, 200]); page.drawRectangle({ x: 0, y: 0, width: 300, height: 200, color: rgb(1, 0, 0) });
  const structure = makeKnowledgeStructure(7, 1, '안전모 착용 그림을 확인합니다.', true);
  const verified = applyKnowledgeVision(structure, { tables: [], figures: [{ id: 'source-picture', title: '안전모 착용 그림', bounds: [.1,.1,.6,.6], links: [{ blockId: structure.blocks[0].id,
    quote: '안전모 착용 그림을 확인합니다.', reason: '장면의 안전모 착용을 설명합니다.', relationship: 'illustrates', confidence: .99 }] }] }, 'local-test');
  const base = new KnowledgeBase(directory);
  const document = base.addImported({ title: '테스트 자료', origin: 'internal', published: '', revision: '' }, 'local-crop-fixture', Buffer.from(await pdf.save()), [{ page: 7, text: structure.text, method: 'text', confidence: null, needsReview: false, reviewReason: '', structure: verified }]);
  base.close();
  const scene = board().scenes[0]; scene.visuals = [{ ...visual(1), documentId: document.id, figureId: verified.figures[0].id }];
  const assets = await createCompositionAssetLoader(directory)(scene);
  assert.match(assets['visual-1'], /^data:image\/png;base64,/);
  const decoded = await loadImage(Buffer.from(assets['visual-1'].split(',')[1], 'base64'));
  const canvas = createCanvas(decoded.width, decoded.height), ctx = canvas.getContext('2d'); ctx.drawImage(decoded, 0, 0);
  const pixel = ctx.getImageData(Math.floor(decoded.width/2), Math.floor(decoded.height/2), 1, 1).data;
  assert.ok(pixel[0] > 230 && pixel[1] < 20);
});


test("two caption lines persist in the composition and dark title cards escape user text", async () => {
  const board = generateDemo(sample, defaults);
  const scene = { ...board.scenes[0], title: '<제목 & 검토>', subtitle: "가".repeat(40) + "\n" + "나".repeat(40), visuals: [] };
  assert.deepEqual(compositionSubtitle(scene)?.lines, scene.subtitle.split("\n"));
  assert.match(compositionPlaceholderSvg(scene), /&lt;제목 &amp; 검토&gt;/);
  const png = await renderCompositionOverlay(scene, {}, true);
  const canvas = createCanvas(1600, 900), context = canvas.getContext("2d");
  context.drawImage(await loadImage(png), 0, 0);
  assert.deepEqual([...context.getImageData(1, 1, 1, 1).data], [17, 17, 19, 255]);
  const restored = readDraft(serializeDraft({ manuscript: sample, settings: defaults, board: { ...board, scenes: [scene] } }));
  assert.equal(restored?.board?.scenes[0].subtitle, scene.subtitle);
});
