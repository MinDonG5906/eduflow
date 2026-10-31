import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFPage, rgb } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { createCanvas } from "@napi-rs/canvas";
import { execFileSync } from "node:child_process";
import { exportStoryboardPdf } from "./server/pdf-export";
import type { Board } from "./storyboard";
import { moveScene } from "./board-edit";
import { serializeDraft, restoreBrowserDraft } from "./studio-state";
import { POST } from "../app/api/export/pdf/route";

// Helper to create dummy PNG image buffers with specified dimensions
function createDummyImage(width: number, height: number, color: string): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.font = "14px sans-serif";
  ctx.fillText(`${width}x${height}`, 10, 30);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

const sampleBoard: Board = {
  title: "안전 작업 절차 및 심폐소생술 교육",
  summary: "산업현장 근로자를 위한 필수 안전 절차 및 응급처치 교육",
  objectives: ["작업 전 안전점검 수칙을 숙지한다", "응급상황 발생 시 심폐소생술을 실시한다"],
  settings: {
    audience: "산업현장 근무자",
    difficulty: "보통",
    minutes: 3,
    count: 3,
    tone: "차분한 교육",
    keywords: ["안전", "응급처치", "CPR"],
    language: "한국어",
    instructions: "현장감 있게 구성해 주세요.",
  },
  mode: "demo",
  scenes: [
    {
      id: "scene-1",
      title: "작업장 안전사고의 위험성",
      purpose: "작업 전 보호구 착용의 중요성을 일깨운다.",
      evidence: "산업안전보건법 제38조 안전조치 의무",
      sourceId: "p.12",
      visual: "보호구를 착용하지 않은 작업자가 위험 구역에 진입하는 애니메이션",
      assets: "안전모 미착용 경고 그래픽",
      narration: "작업장에 들어서기 전, 올바른 보호구 착용은 나와 동료의 생명을 지키는 첫걸음입니다.",
      subtitle: "올바른 보호구 착용은 생명을 지키는 첫걸음입니다.",
      duration: 30,
      review: false,
      reviewReason: "",
      edited: [],
      phase: "intro",
      image: {
        id: "img-scene-1-test",
        sourceType: "upload",
        sourceText: "안전보건공단 2025 가이드북 p.15",
        name: "landscape-safety.png",
      },
    },
    {
      id: "scene-2",
      title: "심폐소생술(CPR) 5단계 실행 절차",
      purpose: "의식 확인부터 흉부 압박까지 정확한 행동 요령을 설명한다.",
      evidence: "질병관리청 심폐소생술 표준 가이드라인 2025",
      sourceId: "guide-cpr-p4",
      visual: "환자의 어깨를 두드리며 의식을 확인하고 119 신고를 요청하는 모습",
      assets: "분당 100~120회 압박 템포 인디케이터",
      narration: "환자의 어깨를 가볍게 두드려 반응을 살피고, 주변 사람을 정확히 지목하여 119 신고와 자동심장충격기(AED)를 요청하세요.",
      subtitle: "환자의 반응을 살피고, 즉시 119 신고와 AED를 요청하세요.",
      duration: 60,
      review: true,
      reviewReason: "압박 깊이(5cm) 문구 추가 필요",
      edited: ["narration"],
      phase: "body",
      image: {
        id: "img-scene-2-test",
        sourceType: "upload",
        sourceText: "대한응급의학회 포스터 세로형",
        name: "portrait-cpr.png",
      },
      references: [
        {
          id: "ref-1",
          title: "대한심폐소생협회 심폐소생술 가이드",
          url: "https://example.com/cpr",
          excerpt: "가슴 한가운데를 5~6cm 깊이로 강하고 빠르게 압박합니다.",
          published: "2024-01-15",
          origin: "official",
        },
      ],
    },
    {
      id: "scene-3",
      title: "안전한 하루, 우리의 실천으로 완성됩니다",
      purpose: "핵심 안전수칙 3가지를 되새기고 실천을 다짐한다.",
      evidence: "사내 안전 매뉴얼 제5장",
      sourceId: "manual-5",
      visual: "모든 근로자가 보호구를 바르게 착용하고 안전 구호를 외치는 모습",
      assets: "오늘의 안전 수칙 요약 카드",
      narration: "안전은 타협할 수 없는 최고의 가치입니다. 오늘의 안전 점검으로 행복한 일터를 만듭시다.",
      subtitle: "안전은 타협할 수 없는 가치! 오늘의 안전 점검을 실천합시다.",
      duration: 30,
      review: false,
      reviewReason: "",
      edited: [],
      phase: "outro",
    },
  ],
};

test("exportStoryboardPdf handles landscape and portrait user-attached images with sources", async () => {
  // 1. Create landscape (400x200) and portrait (200x450) images
  const landscapeImg = createDummyImage(400, 200, "#2b6cb0");
  const portraitImg = createDummyImage(200, 450, "#c53030");

  const sceneImages = new Map<string, Uint8Array>();
  sceneImages.set("scene-1", landscapeImg);
  sceneImages.set("scene-2", portraitImg);

  const pdfBytes = await exportStoryboardPdf({
    board: sampleBoard,
    sceneImages,
  });

  assert.ok(pdfBytes instanceof Uint8Array);
  assert.ok(pdfBytes.byteLength > 1000);

  const parser = new PDFParse(new Uint8Array(pdfBytes));
  const parsed = await parser.getText();
  const text = parsed.text;

  // Verify text content
  assert.ok(text.includes("안전 작업 절차"), "Should include board title");
  assert.ok(text.includes("작업장 안전사고의 위험성"), "Should include scene 1 title");
  assert.ok(text.includes("심폐소생술(CPR)"), "Should include scene 2 title");

  // Verify user-attached image source labels
  assert.ok(text.includes("안전보건공단 2025 가이드북 p.15"), "Should include landscape image source");
  assert.ok(text.includes("대한응급의학회 포스터 세로형"), "Should include portrait image source");

  // Scene 3 has no image, should show fallback
  assert.ok(text.includes("참고 이미지 미등록"), "Should show fallback for scene 3");
});

test("scene reordering retains image attachment when generating PDF", async () => {
  // Move scene 0 down by 1 (scene-1 and scene-2 swap)
  const reordered = moveScene(sampleBoard, 0, 1);
  assert.ok(reordered !== null);
  assert.equal(reordered.scenes[0].id, "scene-2");
  assert.equal(reordered.scenes[1].id, "scene-1");

  // Scene images mapped by scene ID
  const landscapeImg = createDummyImage(400, 200, "#2b6cb0");
  const portraitImg = createDummyImage(200, 450, "#c53030");

  const sceneImages = new Map<string, Uint8Array>();
  sceneImages.set("scene-1", landscapeImg);
  sceneImages.set("scene-2", portraitImg);

  const pdfBytes = await exportStoryboardPdf({
    board: reordered,
    sceneImages,
  });

  assert.ok(pdfBytes instanceof Uint8Array);
  const parser = new PDFParse(new Uint8Array(pdfBytes));
  const parsed = await parser.getText();

  // Both image source texts must still be present even after reordering
  assert.ok(parsed.text.includes("대한응급의학회 포스터 세로형"));
  assert.ok(parsed.text.includes("안전보건공단 2025 가이드북 p.15"));
});

test("browser draft serialization preserves scene image metadata across refresh", () => {
  const serialized = serializeDraft({
    manuscript: "테스트 원고 텍스트입니다.",
    settings: sampleBoard.settings,
    board: sampleBoard,
  });

  // Verify JSON serialization doesn't bloat (no raw binary in localStorage)
  assert.ok(serialized.length < 10000, "Serialized draft should be lightweight JSON without large binary");

  // Simulate restore from localStorage
  const mockStorage = {
    data: new Map<string, string>(),
    getItem(k: string) { return this.data.get(k) ?? null; },
    setItem(k: string, v: string) { this.data.set(k, v); },
  };

  const { draft } = restoreBrowserDraft(serialized, mockStorage);
  assert.ok(draft !== null);
  assert.ok(draft.board !== null);

  // Check scene 1 image metadata
  const restoredScene1 = draft.board.scenes[0];
  assert.ok(restoredScene1.image !== undefined);
  assert.equal(restoredScene1.image.id, "img-scene-1-test");
  assert.equal(restoredScene1.image.sourceText, "안전보건공단 2025 가이드북 p.15");
  assert.equal(restoredScene1.image.sourceType, "upload");

  // Check scene 2 image metadata
  const restoredScene2 = draft.board.scenes[1];
  assert.ok(restoredScene2.image !== undefined);
  assert.equal(restoredScene2.image.id, "img-scene-2-test");
  assert.equal(restoredScene2.image.sourceText, "대한응급의학회 포스터 세로형");

  // Check scene 3 without image
  const restoredScene3 = draft.board.scenes[2];
  assert.equal(restoredScene3.image, undefined);
});

test("PDF export maps scene citations against the attached selection and rejects different documents", async (t) => {
  const original = await PDFDocument.create();
  original.addPage([400, 200]).drawRectangle({ x: 0, y: 0, width: 400, height: 200, color: rgb(1, 0, 0) });
  original.addPage([200, 400]).drawRectangle({ x: 0, y: 0, width: 200, height: 400, color: rgb(0, 0, 1) });
  const pdfBuffer = await original.save();
  const attachedPdfSource = { name: "manual.pdf", pages: [22, 24] };
  const board: Board = { ...sampleBoard, pdfSource: attachedPdfSource, scenes: [{ ...sampleBoard.scenes[0],
    image: undefined, sourceId: "pdf-page:24", pdfSource: { name: "manual.pdf", pages: [24] } }] };
  const draw = t.mock.method(PDFPage.prototype, "drawImage");
  const result = await exportStoryboardPdf({ board, pdfBuffer, attachedPdfSource });
  assert.equal(draw.mock.callCount(), 1);
  const selectedImage = draw.mock.calls[0].arguments[0];
  assert.ok(selectedImage.height > selectedImage.width, "citation must use second attached page, not first scene-selected page");
  const parser = new PDFParse({ data: result });
  try { assert.ok((await parser.getText()).text.includes("원본 24페이지")); }
  finally { await parser.destroy(); }

  await exportStoryboardPdf({ board, pdfBuffer, attachedPdfSource: { ...attachedPdfSource, name: "different.pdf" } });
  assert.equal(draw.mock.callCount(), 1, "a different attached document cannot become this scene's source image");
});

test("PDF export API validates origin, size, JSON and attached page metadata before rendering", async () => {
  const url = "http://localhost:3000/api/export/pdf";
  const headers = { Origin: "http://localhost:3000", "Content-Type": "application/json" };
  assert.equal((await POST(new Request(url, { method: "POST", headers: { ...headers, Origin: "https://other.test" }, body: "{}" }))).status, 403);
  assert.equal((await POST(new Request(url, { method: "POST", headers: { ...headers, "Content-Length": "70000001" }, body: "{}" }))).status, 413);
  assert.equal((await POST(new Request(url, { method: "POST", headers, body: "bad-json" }))).status, 400);
  const pdf = await PDFDocument.create(); pdf.addPage();
  const form = new FormData();
  form.set("board", JSON.stringify(sampleBoard));
  form.set("pdf", new Blob([new Uint8Array(await pdf.save())], { type: "application/pdf" }));
  form.set("pdfSource", JSON.stringify({ name: "manual.pdf", pages: [22, 24] }));
  assert.equal((await POST(new Request(url, { method: "POST", headers: { Origin: headers.Origin }, body: form }))).status, 400);
  const response = await POST(new Request(url, { method: "POST", headers, body: JSON.stringify({ board: sampleBoard }) }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
});


test("long production fields and image sources survive unlimited continuation pages", async () => {
  const board = structuredClone(sampleBoard);
  board.scenes = [board.scenes[0]];
  const scene = board.scenes[0];
  const fields = ["title", "purpose", "subtitle", "narration", "visual", "assets", "evidence", "reviewReason"] as const;
  scene.review = true;
  for (const field of fields) scene[field] = ("긴 제작 정보는 생략 없이 다음 페이지에 이어서 표시합니다. ").repeat(field === "title" ? 4 : 25) + field + "END";
  scene.image!.sourceText = "https://example.com/" + "long-source/".repeat(80) + "SOURCEEND";
  scene.references = [{id:"reference",title:"보강 자료",excerpt:"자료 설명 ".repeat(120)+"REFERENCEEND",url:"https://example.com/reference",published:"2026-10-31",origin:"official"}];
  const pdf = await exportStoryboardPdf({board,sceneImages:new Map([[scene.id,createDummyImage(200,450,"#171717")]])});
  const document = await PDFDocument.load(pdf);
  assert.ok(document.getPageCount() > 2);
  const parser = new PDFParse({data:pdf});
  try {
    const text = (await parser.getText()).text.replace(/\s/g, "");
    for (const marker of [...fields.map(f=>f+"END"),"SOURCEEND","REFERENCEEND"]) assert.ok(text.includes(marker),marker);
  } finally { await parser.destroy(); }
});

test("a document title longer than a page cannot stall PDF export or hide scene content", () => {
  const board = structuredClone(sampleBoard);
  board.scenes = [board.scenes[0]];
  const markers = Array.from({ length: 40 }, (_, index) => `제목부분${index}끝`);
  board.title = markers.join("\n");
  // A separate process bounds the failure even if pagination stops making progress.
  const result = execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "-e", `
    const { exportStoryboardPdf } = require('./lib/server/pdf-export.ts');
    const { PDFDocument } = require('pdf-lib');
    const { PDFParse } = require('pdf-parse');
    (async () => {
      const data = await exportStoryboardPdf({board: JSON.parse(process.argv[1])});
      const document = await PDFDocument.load(data);
      const parser = new PDFParse({data});
      try { console.log(JSON.stringify({pages: document.getPageCount(), text: (await parser.getText()).text})); }
      finally { await parser.destroy(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, JSON.stringify(board)], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  const { pages, text } = JSON.parse(result) as { pages: number; text: string };
  assert.ok(pages >= 3 && pages < 10);
  const compact = text.replace(/\s/g, "");
  for (const marker of markers) assert.ok(compact.includes(marker), marker);
  assert.ok(compact.includes(board.scenes[0].narration.replace(/\s/g, "")));
  assert.ok(compact.includes(board.scenes[0].purpose.replace(/\s/g, "")));
});
