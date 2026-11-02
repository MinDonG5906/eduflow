import { sceneReferenceLocations } from "../reference-location";
import { sceneMemo } from "../scene-memo";
import { evidenceReviewText } from "../evidence-review";
import "server-only";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Board } from "../storyboard";
import type { PdfSource } from "../pdf-source";
import { officeFontCandidates } from "./office-fonts";
import { compositionBackgroundRect, compositionStickers, type CompositionAssets } from "../scene-composition";
import { createCompositionAssetLoader } from "./composition-assets";
import { GlobalFonts } from "@napi-rs/canvas";
import { renderCompositionOverlay } from "./composition-render";

// A4 Landscape dimensions in points (297mm x 210mm)
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN_X = 36;
const MARGIN_TOP = 26;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2; // 769.89


interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
}

async function loadKoreanFonts(doc: PDFDocument): Promise<FontSet> {
  doc.registerFontkit(fontkit);

  const candidates = [
    ...officeFontCandidates().filter(file => !file.endsWith(".ttc")),
    "C:\\Windows\\Fonts\\malgun.ttf",
    "C:\\Windows\\Fonts\\malgunbd.ttf",
  ];

  let regularBytes: Buffer | null = null;
  let boldBytes: Buffer | null = null;

  for (const file of candidates) {
    try {
      await access(file, constants.R_OK);
      regularBytes = await readFile(file);
      break;
    } catch {
      // try next candidate
    }
  }

  if (process.platform === "win32") {
    try {
      const boldPath = "C:\\Windows\\Fonts\\malgunbd.ttf";
      await access(boldPath, constants.R_OK);
      boldBytes = await readFile(boldPath);
    } catch {
      // ignore
    }
  }

  if (!regularBytes) {
    throw new Error("시스템에서 한글 글꼴을 찾을 수 없습니다. 한글 글꼴이 설치되어 있는지 확인해 주세요.");
  }

  const regular = await doc.embedFont(regularBytes);
  GlobalFonts.register(regularBytes, "EduFlow Korean");
  const bold = boldBytes ? await doc.embedFont(boldBytes) : regular;

  return { regular, bold };
}

// Safely embeds any PNG or JPEG, with canvas fallback for unusual encodings
async function embedImageSafely(doc: PDFDocument, buffer: Uint8Array): Promise<PDFImage | null> {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    try {
      return await doc.embedJpg(buffer);
    } catch {
      // fallback below
    }
  }

  if (buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    try {
      return await doc.embedPng(buffer);
    } catch {
      // fallback below
    }
  }

  // Fallback using @napi-rs/canvas to convert to standard PNG
  try {
    const { loadImage, createCanvas } = await import("@napi-rs/canvas");
    const img = await loadImage(Buffer.from(buffer));
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const pngBuf = canvas.toBuffer("image/png");
    return await doc.embedPng(new Uint8Array(pngBuf));
  } catch (err) {
    console.warn("Failed to embed image via canvas fallback:", err);
    return null;
  }
}

// Text wrapping utility considering Korean syllables and English words

// Prefer word boundaries, falling back to Unicode characters for long URLs/words.
function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/u)) {
      if (!word) continue;
      if (font.widthOfTextAtSize(line + word, size) <= width) { line += word; continue; }
      if (line.trim()) { lines.push(line.trimEnd()); line = ""; }
      for (const char of word.trimStart()) {
        if (line && font.widthOfTextAtSize(line + char, size) > width) { lines.push(line); line = ""; }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
const ink = rgb(23/255,23/255,23/255);
const body = rgb(96/255,100/255,108/255);
const lineColor = rgb(220/255,222/255,224/255);
const soft = rgb(250/255,250/255,250/255);
const warning = rgb(146/255,96/255,0);
type Row = { text: string; heading: boolean; warning?: boolean };
function section(label: string, text: string, fonts: FontSet, width: number, warn = false): Row[] {
  if (!text.trim()) return [];
  return [{text:label,heading:true,warning:warn}, ...wrapText(text,fonts.regular,10,width).map(text=>({text,heading:false,warning:warn})), {text:"",heading:false}];
}
// Consume measured rows, repeat the section heading when a section spans pages.
function drawRows(page: PDFPage, rows: Row[], x: number, top: number, bottom: number, fonts: FontSet): void {
  let y = top;
  let heading: Row | undefined;
  while (rows.length && y - 14 >= bottom) {
    if (rows[0].heading && rows.length > 1 && y - 32 < bottom) break;
    const row = rows.shift()!;
    if (row.heading) heading = row;
    page.drawText(row.text, {x,y:y-10,size:10,font:row.heading?fonts.bold:fonts.regular,color:row.warning?warning:row.heading?ink:body});
    y -= row.heading ? 18 : 14;
  }
  while (rows.length && !rows[0].text.trim()) rows.shift();
  if (rows.length && !rows[0].heading && heading) rows.unshift({...heading,text:heading.text.replace(/ \(계속\)$/, "")+" (계속)"});
}
export async function exportStoryboardPdf({
  board,
  sceneImages,
  compositionAssets,
}: {
  board: Board;
  pdfBuffer?: Uint8Array;
  attachedPdfSource?: PdfSource;
  sceneImages?: Map<string, Uint8Array>;
  compositionAssets?: CompositionAssets;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = await loadKoreanFonts(doc);
  const loadAssets = createCompositionAssetLoader();

  // Only scene images are backgrounds, matching the editor composition.
  const embeddedSceneImages = new Map<string, PDFImage>();
  if (sceneImages && sceneImages.size > 0) {
    for (const [sceneId, imgBuf] of sceneImages.entries()) {
      try {
        const embedded = await embedImageSafely(doc, imgBuf);
        if (embedded) {
          embeddedSceneImages.set(sceneId, embedded);
        }
      } catch (err) {
        console.warn(`Failed to embed user attached image for scene ${sceneId}:`, err);
      }
    }
  }


  const fullTitleLines = wrapText(board.title || "무제 스토리보드", fonts.bold, 14, CONTENT_WIDTH);
  // A long edited title must not consume the scene's entire body area and
  // leave the continuation loop unable to consume any rows.
  const titleLines = fullTitleLines.length <= 4 ? fullTitleLines : ["스토리보드 (전체 제목은 앞장 참조)"];
  if (fullTitleLines.length > 4) {
    const linesPerPage = Math.floor((PAGE_HEIGHT - MARGIN_TOP - 32 - 42) / 19);
    for (let start = 0; start < fullTitleLines.length; start += linesPerPage) {
      const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      page.drawText("EDUFLOW / STORYBOARD", { x: MARGIN_X, y: PAGE_HEIGHT - MARGIN_TOP - 8, size: 9, font: fonts.bold, color: ink });
      fullTitleLines.slice(start, start + linesPerPage).forEach((text, i) => {
        page.drawText(text, { x: MARGIN_X, y: PAGE_HEIGHT - MARGIN_TOP - 32 - i * 19, size: 14, font: fonts.bold, color: ink });
      });
    }
  }
  const top = PAGE_HEIGHT - MARGIN_TOP - 42 - titleLines.length * 19;
  const leftWidth = 280;
  const rightX = MARGIN_X + leftWidth + 32;
  const rightWidth = PAGE_WIDTH - MARGIN_X - rightX;
  const totalDuration = board.scenes.reduce((n,s)=>n+s.duration,0);
  for (let idx = 0; idx < board.scenes.length; idx++) {
    const scene = board.scenes[idx];
    const stickers = compositionStickers(scene);
    const assets = compositionAssets ?? await loadAssets(scene);
    let image: PDFImage | undefined;
    let imageSourceText = "";

    // Generated or uploaded scene image; otherwise render the editor title card.
    if (embeddedSceneImages.has(scene.id)) {
      image = embeddedSceneImages.get(scene.id);
      if (scene.image?.sourceText?.trim()) {
        imageSourceText = `출처: ${scene.image.sourceText.trim()}`;
      } else if (scene.image?.name) {
        imageSourceText = `출처: ${scene.image.name}`;
      } else {
        imageSourceText = "출처: 등록된 참고 이미지";
      }
      if (scene.image?.sourceType === "generated") {
        imageSourceText = `AI 생성 스토리보드 (원본 증거 아님)${scene.image.generated ? ` · ${scene.image.generated.model}` : ""}\n${imageSourceText}`;
      }
    }
    const overlay = await doc.embedPng(await renderCompositionOverlay(scene, assets, !image));
    const leftRows = [
      ...section("이미지 출처", imageSourceText, fonts, leftWidth),
      ...section("추천 자료 배치", stickers.map(item => `${item.label} · ${item.kind} · ${item.visual.title} (${item.visual.page}페이지)`).join("\n"), fonts, leftWidth),
      ...section("장면 제목", scene.title, fonts, leftWidth),
      ...section("장면 목적", scene.purpose, fonts, leftWidth),
    ];
    const rightRows = [
      ...section("자막", scene.subtitle, fonts, rightWidth),
      ...section("내레이션", scene.narration, fonts, rightWidth),
      ...section("연출 가이드", scene.visual, fonts, rightWidth),
      ...section("시각 자료 제안", scene.assets, fonts, rightWidth),
      ...section("원문 근거", (scene.sourceId ? "("+scene.sourceId+") " : "")+scene.evidence, fonts, rightWidth),
      ...section("보강 자료", sceneReferenceLocations(scene), fonts, rightWidth),
      ...section("문장별 근거 분류와 검토", evidenceReviewText(scene), fonts, rightWidth),
      ...section("검토 메모", sceneMemo(scene), fonts, rightWidth),
    ];
    let part = 0;
    do {
      const page = doc.addPage([PAGE_WIDTH,PAGE_HEIGHT]);
      page.drawText("EDUFLOW / STORYBOARD",{x:MARGIN_X,y:PAGE_HEIGHT-MARGIN_TOP-8,size:9,font:fonts.bold,color:ink});
      titleLines.forEach((text,i)=>page.drawText(text,{x:MARGIN_X,y:PAGE_HEIGHT-MARGIN_TOP-32-i*19,size:14,font:fonts.bold,color:ink}));
      page.drawRectangle({x:MARGIN_X,y:top-28,width:CONTENT_WIDTH,height:28,color:rgb(240/255,240/255,243/255)});
      const phase = scene.phase ? {intro:"도입부",body:"정보전달부",outro:"마무리"}[scene.phase] : "";
      page.drawText("SCENE "+String(idx+1).padStart(2,"0")+"   "+phase+(part?" / 이어짐 "+part:""),{x:MARGIN_X+12,y:top-18,size:10,font:fonts.bold,color:ink});
      const status=scene.duration+"초";
      page.drawText(status,{x:PAGE_WIDTH-MARGIN_X-12-fonts.bold.widthOfTextAtSize(status,10),y:top-18,size:10,font:fonts.bold,color:ink});
      const bodyTop=top-44;
      page.drawText("화면 / 참고 이미지",{x:MARGIN_X,y:bodyTop-10,size:10,font:fonts.bold,color:ink});
      const frameTop=bodyTop-24, frameHeight=leftWidth*9/16, frameY=frameTop-frameHeight;
      page.drawRectangle({x:MARGIN_X,y:frameY,width:leftWidth,height:frameHeight,color:rgb(17/255,17/255,19/255),borderColor:lineColor,borderWidth:0.6});
      if(image){const rect=compositionBackgroundRect(image.width,image.height,leftWidth,frameHeight);page.drawImage(image,{x:MARGIN_X+rect.x,y:frameY+rect.y,width:rect.width,height:rect.height});}
      page.drawImage(overlay, { x: MARGIN_X, y: frameY, width: leftWidth, height: frameHeight });
      page.drawLine({start:{x:rightX-16,y:bodyTop},end:{x:rightX-16,y:42},color:lineColor,thickness:0.6});
      drawRows(page,leftRows,MARGIN_X,frameY-12,42,fonts);
      drawRows(page,rightRows,rightX,bodyTop,42,fonts);
      part++;
    } while(leftRows.length || rightRows.length);
  }
  if(!doc.getPageCount()) doc.addPage([PAGE_WIDTH,PAGE_HEIGHT]);
  doc.getPages().forEach((page,i)=>{
    page.drawLine({start:{x:MARGIN_X,y:32},end:{x:PAGE_WIDTH-MARGIN_X,y:32},color:lineColor,thickness:0.6});
    page.drawText("대상: "+board.settings.audience+"  /  총 예상 시간: "+totalDuration+"초",{x:MARGIN_X,y:19,size:8,font:fonts.regular,color:body});
    const number=(i+1)+" / "+doc.getPageCount();page.drawText(number,{x:PAGE_WIDTH-MARGIN_X-fonts.regular.widthOfTextAtSize(number,8),y:19,size:8,font:fonts.regular,color:body});
  });
  return doc.save();
}
