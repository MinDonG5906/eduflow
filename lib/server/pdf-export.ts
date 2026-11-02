import "server-only";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Board } from "../storyboard";
import { citedPdfPage, sourceUnit, type PdfSource } from "../pdf-source";
import { officeFontCandidates } from "./office-fonts";
import { renderPdfPages } from "./pdf-render";
import { compositionBackgroundRect, compositionStickers, type CompositionAssets } from "../scene-composition";
import { createCompositionAssetLoader } from "./composition-assets";
import { createCanvas } from "@napi-rs/canvas";
import { renderCompositionOverlay } from "./composition-render";
import { graphemes, needsShaping, wrapLines } from "../text-segment";
import { bundledFontBytes, canvasFont, measureCanvasText, registerCanvasFonts } from "./script-fonts";

// A4 Landscape dimensions in points (297mm x 210mm)
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN_X = 36;
const MARGIN_TOP = 26;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2; // 769.89


interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  covers: (codePoint: number) => boolean;
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
  const bold = boldBytes ? await doc.embedFont(boldBytes) : regular;
  const font = fontkit.create(regularBytes);
  return { regular, bold, covers: point => font.hasGlyphForCodePoint(point) };
}

// Fonts for languages the Korean system font lacks, embedded only when the board
// uses them. Fully embedded: pdf-lib subsetting drops Vietnamese letters.
const fallbackFiles: { regular: string; bold?: string }[] = [{ regular: "inter-regular.ttf", bold: "inter-semibold.ttf" }, { regular: "noto-sans-sc-regular-gb2312.otf" }];
async function loadFallbackFonts(doc: PDFDocument, korean: FontSet, text: string): Promise<FontSet[]> {
  const candidates = fallbackFiles.map(files => ({ files, bytes: bundledFontBytes(files.regular) }))
    .map(item => ({ ...item, font: fontkit.create(item.bytes) }));
  const needed = new Set<number>();
  for (const point of new Set(Array.from(text, char => char.codePointAt(0)!))) {
    if (point <= 0x20 || korean.covers(point)) continue;
    const index = candidates.findIndex(item => item.font.hasGlyphForCodePoint(point));
    if (index >= 0) needed.add(index);
  }
  return Promise.all([...needed].sort().map(async index => {
    const { files, bytes, font } = candidates[index];
    const regular = await doc.embedFont(bytes, { subset: false });
    const bold = files.bold ? await doc.embedFont(bundledFontBytes(files.bold), { subset: false }) : regular;
    return { regular, bold, covers: (point: number) => font.hasGlyphForCodePoint(point) };
  }));
}

type TextStyle = { x: number; y: number; size: number; bold?: boolean; color: RGB };
// Picks a font per run of text; complex scripts become canvas-shaped images
// because pdf-lib cannot reorder or stack their glyphs.
class Typesetter {
  private images = new Map<string, Promise<PDFImage>>();
  constructor(private doc: PDFDocument, private faces: FontSet[]) {}
  private runs(text: string, bold = false) {
    const coveredBy = (face: FontSet, part: string) => Array.from(part).every(char => char.codePointAt(0)! <= 0x20 || face.covers(char.codePointAt(0)!));
    let current = this.faces.find(face => coveredBy(face, text)) ?? this.faces[0];
    const runs: { text: string; font: PDFFont }[] = [];
    for (const part of graphemes(text)) {
      if (!coveredBy(current, part)) current = this.faces.find(face => coveredBy(face, part)) ?? current;
      const font = bold ? current.bold : current.regular, last = runs.at(-1);
      if (last?.font === font) last.text += part; else runs.push({ text: part, font });
    }
    return runs;
  }
  measure(text: string, size: number, bold = false) {
    if (needsShaping(text)) return measureCanvasText(text, size, bold);
    return this.runs(text, bold).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0);
  }
  wrap(text: string, size: number, width: number, bold = false) {
    return text.replace(/\r/g, "").split("\n").flatMap(paragraph => paragraph.trim() ? wrapLines(paragraph, width, part => this.measure(part, size, bold)) : [""]);
  }
  async draw(page: PDFPage, text: string, { x, y, size, bold = false, color }: TextStyle) {
    if (!text) return;
    if (!needsShaping(text)) {
      for (const run of this.runs(text, bold)) {
        page.drawText(run.text, { x, y, size, font: run.font, color });
        x += run.font.widthOfTextAtSize(run.text, size);
      }
      return;
    }
    const scale = 4, ascent = size * 1.2, height = size * 1.7;
    const key = JSON.stringify([text, size, bold, color]);
    if (!this.images.has(key)) this.images.set(key, (async () => {
      registerCanvasFonts();
      const canvas = createCanvas(Math.ceil(measureCanvasText(text, size, bold) * scale) + 8, Math.ceil(height * scale)), context = canvas.getContext("2d");
      context.font = canvasFont(text, size * scale, bold);
      context.fillStyle = `rgb(${[color.red, color.green, color.blue].map(value => Math.round(value * 255)).join(",")})`;
      context.fillText(text, 0, ascent * scale);
      return this.doc.embedPng(canvas.toBuffer("image/png"));
    })());
    const image = await this.images.get(key)!;
    page.drawImage(image, { x, y: y - (height - ascent), width: image.width / scale, height: image.height / scale });
  }
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

const ink = rgb(23/255,23/255,23/255);
const body = rgb(96/255,100/255,108/255);
const lineColor = rgb(220/255,222/255,224/255);
const soft = rgb(250/255,250/255,250/255);
const warning = rgb(146/255,96/255,0);
type Row = { text: string; heading: boolean; warning?: boolean };
function section(label: string, text: string, type: Typesetter, width: number, warn = false): Row[] {
  if (!text.trim()) return [];
  return [{text:label,heading:true,warning:warn}, ...type.wrap(text,10,width).map(text=>({text,heading:false,warning:warn})), {text:"",heading:false}];
}
// Consume measured rows, repeat the section heading when a section spans pages.
async function drawRows(page: PDFPage, rows: Row[], x: number, top: number, bottom: number, type: Typesetter): Promise<void> {
  let y = top;
  let heading: Row | undefined;
  while (rows.length && y - 14 >= bottom) {
    if (rows[0].heading && rows.length > 1 && y - 32 < bottom) break;
    const row = rows.shift()!;
    if (row.heading) heading = row;
    await type.draw(page, row.text, {x,y:y-10,size:10,bold:row.heading,color:row.warning?warning:row.heading?ink:body});
    y -= row.heading ? 18 : 14;
  }
  while (rows.length && !rows[0].text.trim()) rows.shift();
  if (rows.length && !rows[0].heading && heading) rows.unshift({...heading,text:heading.text.replace(/ \(계속\)$/, "")+" (계속)"});
}
export async function exportStoryboardPdf({
  board,
  pdfBuffer,
  attachedPdfSource,
  sceneImages,
  compositionAssets,
  language,
}: {
  board: Board;
  // Set when the board is a translation: its label and the Korean master text per scene.
  language?: { label: string; master: Record<string, { narration: string; subtitle: string }> };
  pdfBuffer?: Uint8Array;
  attachedPdfSource?: PdfSource;
  sceneImages?: Map<string, Uint8Array>;
  compositionAssets?: CompositionAssets;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = await loadKoreanFonts(doc);
  const type = new Typesetter(doc, [fonts, ...await loadFallbackFonts(doc, fonts, JSON.stringify(board))]);
  const loadAssets = createCompositionAssetLoader();

  // 1. Prepare PDF page screenshots if pdfBuffer is supplied
  const pageImageMap = new Map<number, PDFImage>();
  let imageRenderError: string | null = null;

  if (pdfBuffer && pdfBuffer.byteLength > 0) {
    try {
      const renderedScreenshots = await renderPdfPages(pdfBuffer, undefined, true);
      for (let i = 0; i < renderedScreenshots.length; i++) {
        try {
          const embedded = await doc.embedPng(renderedScreenshots[i]);
          pageImageMap.set(i + 1, embedded);
        } catch (embedError) {
          console.warn(`Failed to embed PNG for page ${i + 1}:`, embedError);
        }
      }
    } catch (err) {
      console.warn("PDF screenshot rendering failed, proceeding with fallback copy:", err);
      imageRenderError = "문서 미리보기 이미지를 가져오지 못했습니다.";
    }
  }

  // 2. Prepare embedded images for each scene (directly attached sceneImages take precedence)
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


  const fullTitleLines = type.wrap(board.title || "무제 스토리보드", 14, CONTENT_WIDTH, true);
  // A long edited title must not consume the scene's entire body area and
  // leave the continuation loop unable to consume any rows.
  const titleLines = fullTitleLines.length <= 4 ? fullTitleLines : ["스토리보드 (전체 제목은 앞장 참조)"];
  if (fullTitleLines.length > 4) {
    const linesPerPage = Math.floor((PAGE_HEIGHT - MARGIN_TOP - 32 - 42) / 19);
    for (let start = 0; start < fullTitleLines.length; start += linesPerPage) {
      const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      page.drawText("EDUFLOW / STORYBOARD", { x: MARGIN_X, y: PAGE_HEIGHT - MARGIN_TOP - 8, size: 9, font: fonts.bold, color: ink });
      for (const [i, text] of fullTitleLines.slice(start, start + linesPerPage).entries())
        await type.draw(page, text, { x: MARGIN_X, y: PAGE_HEIGHT - MARGIN_TOP - 32 - i * 19, size: 14, bold: true, color: ink });
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

    // A. Priority 1: User directly attached image
    if (embeddedSceneImages.has(scene.id)) {
      image = embeddedSceneImages.get(scene.id);
      if (scene.image?.sourceType === "generated") {
        imageSourceText = `출처: AI 생성${scene.image.generated ? ` · ${scene.image.generated.model}` : ""}`;
      } else if (scene.image?.sourceText?.trim()) {
        imageSourceText = `출처: ${scene.image.sourceText.trim()}`;
      } else if (scene.image?.name) {
        imageSourceText = `출처: ${scene.image.name}`;
      } else {
        imageSourceText = "출처: 등록된 참고 이미지";
      }
    }
    // B. Priority 2: PDF source document page screenshot
    else {
      const pdfSource = attachedPdfSource;
      if (pdfSource && pdfBuffer) {
        const pageNum = citedPdfPage(pdfSource, scene);
        if (pageNum !== null) {
          const position = pdfSource.pages.indexOf(pageNum);
          if (position !== -1) {
            image = pageImageMap.get(position + 1);
            imageSourceText = `출처: 원본 ${pageNum}${sourceUnit(pdfSource.name)}`;
          }
        }
      }
    }


    if (!image && imageRenderError) imageSourceText = "원본 참고 이미지를 표시하지 못했습니다. 제목 카드로 표시합니다.";
    const overlay = await doc.embedPng(await renderCompositionOverlay(scene, assets, !image));
    const leftRows = [
      ...section("이미지 출처", imageSourceText, type, leftWidth),
      ...section("추천 자료 배치", stickers.map(item => `${item.label} · ${item.kind} · ${item.visual.title} (${item.visual.page}페이지)`).join("\n"), type, leftWidth),
      ...section("장면 제목", scene.title, type, leftWidth),
      ...section("장면 목적", scene.purpose, type, leftWidth),
    ];
    const rightRows = [
      ...section(language ? `자막 (${language.label})` : "자막", scene.subtitle, type, rightWidth),
      ...section(language ? `내레이션 (${language.label})` : "내레이션", scene.narration, type, rightWidth),
      ...(language ? [
        ...section("한국어 자막", language.master[scene.id]?.subtitle ?? "", type, rightWidth),
        ...section("한국어 내레이션", language.master[scene.id]?.narration ?? "", type, rightWidth),
      ] : []),
      ...section("연출 가이드", scene.visual, type, rightWidth),
      ...section("시각 자료 제안", scene.assets, type, rightWidth),
      ...section("원문 근거", (scene.sourceId ? "("+scene.sourceId+") " : "")+scene.evidence, type, rightWidth),
      ...section("보강 자료", (scene.references??[]).map(r=>r.title+"\n"+r.excerpt+(r.url?"\n"+r.url:"")).join("\n\n"), type, rightWidth),
      ...section("검토 사유", scene.reviewReason || "", type, rightWidth, scene.review),
    ];
    let part = 0;
    do {
      const page = doc.addPage([PAGE_WIDTH,PAGE_HEIGHT]);
      page.drawText("EDUFLOW / STORYBOARD",{x:MARGIN_X,y:PAGE_HEIGHT-MARGIN_TOP-8,size:9,font:fonts.bold,color:ink});
      for (const [i,text] of titleLines.entries()) await type.draw(page,text,{x:MARGIN_X,y:PAGE_HEIGHT-MARGIN_TOP-32-i*19,size:14,bold:true,color:ink});
      page.drawRectangle({x:MARGIN_X,y:top-28,width:CONTENT_WIDTH,height:28,color:rgb(240/255,240/255,243/255)});
      const phase = scene.phase ? {intro:"도입부",body:"정보전달부",outro:"마무리"}[scene.phase] : "";
      page.drawText("SCENE "+String(idx+1).padStart(2,"0")+"   "+phase+(part?" / 이어짐 "+part:""),{x:MARGIN_X+12,y:top-18,size:10,font:fonts.bold,color:ink});
      const status=scene.duration+"초  /  "+(scene.review?"검토 필요":"검토 완료");
      page.drawText(status,{x:PAGE_WIDTH-MARGIN_X-12-fonts.bold.widthOfTextAtSize(status,10),y:top-18,size:10,font:fonts.bold,color:scene.review?warning:rgb(36/255,112/255,68/255)});
      const bodyTop=top-44;
      page.drawText("화면 / 참고 이미지",{x:MARGIN_X,y:bodyTop-10,size:10,font:fonts.bold,color:ink});
      const frameTop=bodyTop-24, frameHeight=leftWidth*9/16, frameY=frameTop-frameHeight;
      page.drawRectangle({x:MARGIN_X,y:frameY,width:leftWidth,height:frameHeight,color:rgb(17/255,17/255,19/255),borderColor:lineColor,borderWidth:0.6});
      if(image){const rect=compositionBackgroundRect(image.width,image.height,leftWidth,frameHeight);page.drawImage(image,{x:MARGIN_X+rect.x,y:frameY+rect.y,width:rect.width,height:rect.height});}
      page.drawImage(overlay, { x: MARGIN_X, y: frameY, width: leftWidth, height: frameHeight });
      page.drawLine({start:{x:rightX-16,y:bodyTop},end:{x:rightX-16,y:42},color:lineColor,thickness:0.6});
      await drawRows(page,leftRows,MARGIN_X,frameY-12,42,type);
      await drawRows(page,rightRows,rightX,bodyTop,42,type);
      part++;
    } while(leftRows.length || rightRows.length);
  }
  if(!doc.getPageCount()) doc.addPage([PAGE_WIDTH,PAGE_HEIGHT]);
  for (const [i,page] of doc.getPages().entries()) {
    page.drawLine({start:{x:MARGIN_X,y:32},end:{x:PAGE_WIDTH-MARGIN_X,y:32},color:lineColor,thickness:0.6});
    await type.draw(page,"대상: "+board.settings.audience+(language?"  /  언어: "+language.label:"")+"  /  총 예상 시간: "+totalDuration+"초",{x:MARGIN_X,y:19,size:8,color:body});
    const number=(i+1)+" / "+doc.getPageCount();page.drawText(number,{x:PAGE_WIDTH-MARGIN_X-fonts.regular.widthOfTextAtSize(number,8),y:19,size:8,font:fonts.regular,color:body});
  }
  return doc.save();
}
