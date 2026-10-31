import assert from "node:assert/strict";
import test from "node:test";
import { PDFParse } from "pdf-parse";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { defaults, generateDemo, sample, sceneSchema, visualPlacementSchema } from "./storyboard";
import type { VisualRecommendation } from "./knowledge-structure";
import { clampVisualPlacement, compositionLayouts, compositionOverlaySvg, compositionStickers, defaultVisualPlacements, sceneVisualPlacements } from "./scene-composition";
import { sceneImageInput } from "./scene-image";
import { sceneImagePrompt } from "./server/scene-image";
import { readDraft, serializeDraft } from "./studio-state";
import { editScene, moveScene, replaceScene } from "./board-edit";
import { exportStoryboardPdf } from "./server/pdf-export";

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
  const bytes = await exportStoryboardPdf({ board: value });
  const parser = new PDFParse({ data: bytes });
  try {
    const text = (await parser.getText()).text.replace(/\s/g, "");
    assert.match(text, /추천시각자료1·그림/); assert.match(text, /추천시각자료2·표/);
    assert.match(text, /안전모착용그림\(7페이지\)/); assert.match(text, /점검항목표\(7페이지\)/);
  } finally { await parser.destroy(); }
});
