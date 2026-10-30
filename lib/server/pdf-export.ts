import "server-only";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Board, Scene } from "../storyboard";
import { citedPdfPage, sourceUnit, type PdfSource } from "../pdf-source";
import { officeFontCandidates } from "./office-fonts";
import { renderPdfPages } from "./pdf-render";

// A4 Landscape dimensions in points (297mm x 210mm)
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN_X = 36;
const MARGIN_TOP = 26;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2; // 769.89
const CONTENT_MAX_HEIGHT = PAGE_HEIGHT - MARGIN_TOP - 44 - 26; // ~500pt

// Pastel background colors for scene card headers
const SCENE_PASTELS = [
  rgb(0.96, 0.92, 0.94), // pastel pink / rose
  rgb(0.92, 0.96, 0.92), // pastel green / mint
  rgb(0.98, 0.96, 0.88), // pastel yellow / cream
  rgb(0.91, 0.94, 0.98), // pastel blue / sky
  rgb(0.95, 0.92, 0.98), // pastel lavender
];

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
function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  if (!text) return [];
  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push("");
      continue;
    }

    let current = "";
    for (let i = 0; i < para.length; i++) {
      const char = para[i];
      const test = current + char;
      const width = font.widthOfTextAtSize(test, fontSize);

      if (width <= maxWidth) {
        current = test;
      } else {
        if (current) lines.push(current);
        current = char;
      }
    }
    if (current) lines.push(current);
  }

  return lines;
}

function fitText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 0 && font.widthOfTextAtSize(trimmed + "...", fontSize) > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed + "...";
}

interface FormattedSceneContent {
  scene: Scene;
  index: number;
  image?: PDFImage;
  imageSourceText?: string;
  imageError?: string;
  purposeLines: string[];
  subLines: string[];
  narrLines: string[];
  visLines: string[];
  assetLines: string[];
  evLines: string[];
  refLines: string[];
  reviewReasonLines: string[];
  isContinuation?: boolean;
}

export async function exportStoryboardPdf({
  board,
  pdfBuffer,
  attachedPdfSource,
  sceneImages,
}: {
  board: Board;
  pdfBuffer?: Uint8Array;
  attachedPdfSource?: PdfSource;
  sceneImages?: Map<string, Uint8Array>;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = await loadKoreanFonts(doc);

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

  // 3. Measure and break scene content into chunks that won't truncate
  const totalDuration = board.scenes.reduce((sum, s) => sum + s.duration, 0);
  const rightWidth = CONTENT_WIDTH - 295 - 16; // ~458 pt
  const leftWidth = 275;

  const cardsToRender: { content: FormattedSceneContent; fullPage: boolean }[] = [];

  for (let idx = 0; idx < board.scenes.length; idx++) {
    const scene = board.scenes[idx];
    let image: PDFImage | undefined;
    let imageSourceText = "";

    // A. Priority 1: User directly attached image
    if (embeddedSceneImages.has(scene.id)) {
      image = embeddedSceneImages.get(scene.id);
      if (scene.image?.sourceText?.trim()) {
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

    const purposeLines = wrapText(scene.purpose || "", fonts.regular, 8, leftWidth - 50);
    const subLines = wrapText(scene.subtitle || "", fonts.bold, 8, rightWidth - 36);
    const narrLines = wrapText(scene.narration || "", fonts.regular, 8, rightWidth - 52);
    const visLines = wrapText(scene.visual || "", fonts.regular, 8, rightWidth - 52);
    const assetLines = wrapText(scene.assets || "", fonts.regular, 8, rightWidth - 52);
    const evLines = wrapText(
      (scene.sourceId ? `(${scene.sourceId}) ` : "") + (scene.evidence || ""),
      fonts.regular,
      7.5,
      rightWidth - 52
    );
    const refLines: string[] = [];
    if (scene.references) {
      for (const ref of scene.references) {
        refLines.push(...wrapText(`• ${ref.title}: ${ref.excerpt}`, fonts.regular, 7.5, rightWidth - 52));
      }
    }
    const reviewReasonLines = scene.review && scene.reviewReason
      ? wrapText(`[검토 사유] ${scene.reviewReason}`, fonts.bold, 7.5, rightWidth)
      : [];

    const totalRightLines =
      subLines.length +
      narrLines.length +
      visLines.length +
      assetLines.length +
      evLines.length +
      refLines.length +
      reviewReasonLines.length;

    // A normal half-page slot fits around 12-14 lines comfortably.
    if (totalRightLines <= 13) {
      cardsToRender.push({
        fullPage: false,
        content: {
          scene,
          index: idx,
          image,
          imageSourceText,
          imageError: image ? undefined : imageRenderError ?? undefined,
          purposeLines,
          subLines,
          narrLines,
          visLines,
          assetLines,
          evLines,
          refLines,
          reviewReasonLines,
        },
      });
    } else if (totalRightLines <= 32) {
      cardsToRender.push({
        fullPage: true,
        content: {
          scene,
          index: idx,
          image,
          imageSourceText,
          imageError: image ? undefined : imageRenderError ?? undefined,
          purposeLines,
          subLines,
          narrLines,
          visLines,
          assetLines,
          evLines,
          refLines,
          reviewReasonLines,
        },
      });
    } else {
      const firstChunkNarr = narrLines.slice(0, 15);
      const secondChunkNarr = narrLines.slice(15);

      cardsToRender.push({
        fullPage: true,
        content: {
          scene,
          index: idx,
          image,
          imageSourceText,
          imageError: image ? undefined : imageRenderError ?? undefined,
          purposeLines,
          subLines,
          narrLines: firstChunkNarr,
          visLines,
          assetLines,
          evLines: [],
          refLines: [],
          reviewReasonLines: [],
        },
      });

      cardsToRender.push({
        fullPage: true,
        content: {
          scene,
          index: idx,
          image: undefined,
          imageSourceText: "",
          purposeLines: [],
          subLines: [],
          narrLines: secondChunkNarr,
          visLines: [],
          assetLines,
          evLines,
          refLines,
          reviewReasonLines,
          isContinuation: true,
        },
      });
    }
  }

  // 4. Group cards into physical pages
  const pages: { cards: FormattedSceneContent[]; isFull: boolean }[] = [];
  let pendingHalf: FormattedSceneContent[] = [];

  for (const item of cardsToRender) {
    if (item.fullPage) {
      if (pendingHalf.length > 0) {
        pages.push({ cards: [...pendingHalf], isFull: false });
        pendingHalf = [];
      }
      pages.push({ cards: [item.content], isFull: true });
    } else {
      pendingHalf.push(item.content);
      if (pendingHalf.length === 2) {
        pages.push({ cards: [...pendingHalf], isFull: false });
        pendingHalf = [];
      }
    }
  }
  if (pendingHalf.length > 0) {
    pages.push({ cards: [...pendingHalf], isFull: false });
  }

  if (pages.length === 0) {
    pages.push({ cards: [], isFull: false });
  }

  const totalPages = pages.length;

  // 5. Render each physical page
  for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const pageGroup = pages[pageIdx];

    renderPageHeader(page, board, pageIdx, totalPages, totalDuration, fonts);

    if (pageGroup.isFull) {
      const cardHeight = CONTENT_MAX_HEIGHT;
      const cardY = PAGE_HEIGHT - MARGIN_TOP - 44 - cardHeight;
      if (pageGroup.cards[0]) {
        renderSceneCard(page, pageGroup.cards[0], MARGIN_X, cardY, CONTENT_WIDTH, cardHeight, fonts, true);
      }
    } else {
      const slotHeight = 232;
      const slotY1 = PAGE_HEIGHT - MARGIN_TOP - 44 - slotHeight;
      const slotY2 = slotY1 - 12 - slotHeight;

      if (pageGroup.cards[0]) {
        renderSceneCard(page, pageGroup.cards[0], MARGIN_X, slotY1, CONTENT_WIDTH, slotHeight, fonts, false);
      }
      if (pageGroup.cards[1]) {
        renderSceneCard(page, pageGroup.cards[1], MARGIN_X, slotY2, CONTENT_WIDTH, slotHeight, fonts, false);
      }
    }
  }

  return doc.save();
}

function renderPageHeader(
  page: PDFPage,
  board: Board,
  pageIndex: number,
  totalPages: number,
  totalDuration: number,
  fonts: FontSet
) {
  const y = PAGE_HEIGHT - MARGIN_TOP - 20;

  // Left Title badge: "[영상/교육] 스토리보드"
  page.drawRectangle({
    x: MARGIN_X,
    y: y - 5,
    width: 140,
    height: 26,
    color: rgb(0.12, 0.15, 0.2),
  });
  page.drawText("EDUFLOW STORYBOARD", {
    x: MARGIN_X + 10,
    y: y + 4,
    size: 9,
    font: fonts.bold,
    color: rgb(1, 1, 1),
  });

  // Content title
  const titleText = fitText(board.title || "무제 스토리보드", fonts.bold, 13, 260);
  page.drawText(titleText, {
    x: MARGIN_X + 152,
    y: y + 2,
    size: 13,
    font: fonts.bold,
    color: rgb(0.1, 0.12, 0.18),
  });

  // Meta fields on the right
  const mins = Math.floor(totalDuration / 60);
  const secs = totalDuration % 60;
  const timeStr = `총 예상 시간: ${mins > 0 ? `${mins}분 ` : ""}${secs}초`;
  const audienceStr = `대상: ${board.settings.audience}`;
  const pageStr = `페이지: ${pageIndex + 1} / ${totalPages}`;

  const rightText = `${audienceStr}   |   ${timeStr}   |   ${pageStr}`;
  const rightWidth = fonts.regular.widthOfTextAtSize(rightText, 8.5);

  page.drawText(rightText, {
    x: PAGE_WIDTH - MARGIN_X - rightWidth,
    y: y + 4,
    size: 8.5,
    font: fonts.regular,
    color: rgb(0.35, 0.38, 0.44),
  });

  // Divider line
  page.drawLine({
    start: { x: MARGIN_X, y: y - 14 },
    end: { x: PAGE_WIDTH - MARGIN_X, y: y - 14 },
    thickness: 1.5,
    color: rgb(0.2, 0.25, 0.35),
  });
}

function renderSceneCard(
  page: PDFPage,
  content: FormattedSceneContent,
  x: number,
  y: number,
  width: number,
  height: number,
  fonts: FontSet,
  expanded: boolean
) {
  const { scene, index, image, imageSourceText, isContinuation } = content;
  const pastelColor = SCENE_PASTELS[index % SCENE_PASTELS.length];

  // Outer border & background
  page.drawRectangle({
    x,
    y,
    width,
    height,
    borderColor: rgb(0.75, 0.78, 0.84),
    borderWidth: 1,
    color: rgb(0.99, 0.99, 1.0),
  });

  // Card Header bar
  const headerHeight = 24;
  page.drawRectangle({
    x,
    y: y + height - headerHeight,
    width,
    height: headerHeight,
    color: pastelColor,
    borderColor: rgb(0.75, 0.78, 0.84),
    borderWidth: 1,
  });

  // Scene Number & Title
  const sceneNumText = `SCENE ${String(index + 1).padStart(2, "0")}${isContinuation ? " (이어짐)" : ""}`;
  page.drawText(sceneNumText, {
    x: x + 10,
    y: y + height - 16,
    size: 10,
    font: fonts.bold,
    color: rgb(0.12, 0.15, 0.25),
  });

  // Phase tag
  let phaseX = x + (isContinuation ? 120 : 80);
  if (scene.phase && !isContinuation) {
    const phaseLabel = scene.phase === "intro" ? "도입부" : scene.phase === "body" ? "정보전달부" : "마무리";
    page.drawRectangle({
      x: phaseX,
      y: y + height - 18,
      width: 42,
      height: 14,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.65, 0.7, 0.78),
      borderWidth: 0.5,
    });
    page.drawText(phaseLabel, {
      x: phaseX + 4,
      y: y + height - 15,
      size: 7.5,
      font: fonts.regular,
      color: rgb(0.2, 0.25, 0.35),
    });
    phaseX += 48;
  }

  // Scene Title
  const maxTitleWidth = 320;
  const titleText = fitText(scene.title || "장면 제목 없음", fonts.bold, 10, maxTitleWidth);
  page.drawText(titleText, {
    x: phaseX,
    y: y + height - 16,
    size: 10,
    font: fonts.bold,
    color: rgb(0.1, 0.12, 0.18),
  });

  // Right Header: Duration and Review status
  const durationSec = scene.duration;
  const timeFormatted = `00:${String(Math.floor(durationSec / 60)).padStart(2, "0")}:${String(durationSec % 60).padStart(2, "0")} (${durationSec}초)`;
  const reviewText = scene.review ? "검토 필요" : "검토 완료";
  const statusStr = `${timeFormatted}  ·  [${reviewText}]`;
  const statusWidth = fonts.bold.widthOfTextAtSize(statusStr, 8.5);

  page.drawText(statusStr, {
    x: x + width - statusWidth - 10,
    y: y + height - 16,
    size: 8.5,
    font: fonts.bold,
    color: scene.review ? rgb(0.8, 0.2, 0.1) : rgb(0.1, 0.5, 0.2),
  });

  // Internal division: Left 40% (width 295), Right 60% (width 455)
  const leftWidth = 295;
  const rightWidth = width - leftWidth - 16;

  // Middle vertical divider
  page.drawLine({
    start: { x: x + leftWidth + 8, y },
    end: { x: x + leftWidth + 8, y: y + height - headerHeight },
    thickness: 0.5,
    color: rgb(0.82, 0.85, 0.9),
  });

  // ----------------------------------------------------
  // LEFT COLUMN: Visual & Reference Image (approx 40%)
  // ----------------------------------------------------
  const leftX = x + 10;
  let curLeftY = y + height - headerHeight - 16;

  page.drawText("★ 화면 / 참고 이미지", {
    x: leftX,
    y: curLeftY,
    size: 8.5,
    font: fonts.bold,
    color: rgb(0.2, 0.25, 0.35),
  });
  curLeftY -= (expanded ? 160 : 130);

  // 16:9 Frame Box (width 275, height 120 or 150)
  const frameWidth = 275;
  const frameHeight = expanded ? 150 : 120;
  const frameX = leftX;
  const frameY = curLeftY;

  page.drawRectangle({
    x: frameX,
    y: frameY,
    width: frameWidth,
    height: frameHeight,
    color: rgb(0.96, 0.97, 0.98),
    borderColor: rgb(0.8, 0.83, 0.88),
    borderWidth: 0.8,
  });

  if (image) {
    // Maintain aspect ratio fit & center
    const imgRatio = image.width / image.height;
    const boxRatio = frameWidth / frameHeight;
    let drawW = frameWidth;
    let drawH = frameHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (imgRatio > boxRatio) {
      drawH = frameWidth / imgRatio;
      offsetY = (frameHeight - drawH) / 2;
    } else {
      drawW = frameHeight * imgRatio;
      offsetX = (frameWidth - drawW) / 2;
    }

    page.drawImage(image, {
      x: frameX + offsetX,
      y: frameY + offsetY,
      width: drawW,
      height: drawH,
    });

    if (imageSourceText) {
      page.drawText(fitText(imageSourceText, fonts.regular, 7.5, frameWidth), {
        x: frameX + 4,
        y: frameY - 12,
        size: 7.5,
        font: fonts.regular,
        color: rgb(0.4, 0.45, 0.55),
      });
    }
  } else {
    page.drawText("[ 참고 이미지 미등록 ]", {
      x: frameX + (frameWidth - fonts.bold.widthOfTextAtSize("[ 참고 이미지 미등록 ]", 9)) / 2,
      y: frameY + frameHeight / 2 + 10,
      size: 9,
      font: fonts.bold,
      color: rgb(0.5, 0.55, 0.65),
    });

    const fallbackVisual = scene.assets || scene.visual || "시각 자료 제안이 등록되지 않았습니다.";
    const fallbackLines = wrapText(fallbackVisual, fonts.regular, 7.5, frameWidth - 16).slice(0, expanded ? 5 : 3);
    let fallY = frameY + frameHeight / 2 - 8;
    for (const line of fallbackLines) {
      page.drawText(line, {
        x: frameX + 8,
        y: fallY,
        size: 7.5,
        font: fonts.regular,
        color: rgb(0.45, 0.5, 0.6),
      });
      fallY -= 11;
    }
  }

  // Purpose under image frame
  const purposeY = frameY - 26;
  if (content.purposeLines.length > 0) {
    page.drawText("장면 목적:", {
      x: leftX,
      y: purposeY,
      size: 8,
      font: fonts.bold,
      color: rgb(0.25, 0.3, 0.4),
    });
    let py = purposeY;
    for (const pl of content.purposeLines) {
      if (py < y + 8) break;
      page.drawText(pl, {
        x: leftX + 45,
        y: py,
        size: 8,
        font: fonts.regular,
        color: rgb(0.3, 0.35, 0.45),
      });
      py -= 11;
    }
  }

  // ----------------------------------------------------
  // RIGHT COLUMN: Audio / Narration / Guide (approx 60%)
  // ----------------------------------------------------
  const rightX = x + leftWidth + 18;
  let curRightY = y + height - headerHeight - 16;

  // 1. Audio Section (Subtitle & Narration)
  if (content.subLines.length > 0 || content.narrLines.length > 0) {
    page.drawText("● 오디오 / 자막 & 내레이션", {
      x: rightX,
      y: curRightY,
      size: 8.5,
      font: fonts.bold,
      color: rgb(0.15, 0.2, 0.3),
    });
    curRightY -= 13;

    if (content.subLines.length > 0) {
      page.drawText("[자막]", {
        x: rightX,
        y: curRightY,
        size: 8,
        font: fonts.bold,
        color: rgb(0.1, 0.35, 0.7),
      });
      let subY = curRightY;
      for (const sl of content.subLines) {
        if (subY < y + 8) break;
        page.drawText(sl, {
          x: rightX + 32,
          y: subY,
          size: 8,
          font: fonts.bold,
          color: rgb(0.12, 0.15, 0.22),
        });
        subY -= 11;
      }
      curRightY = subY - 2;
    }

    if (content.narrLines.length > 0) {
      page.drawText("[내레이션]", {
        x: rightX,
        y: curRightY,
        size: 8,
        font: fonts.bold,
        color: rgb(0.3, 0.35, 0.45),
      });
      let narrY = curRightY;
      for (const nl of content.narrLines) {
        if (narrY < y + 8) break;
        page.drawText(nl, {
          x: rightX + 48,
          y: narrY,
          size: 8,
          font: fonts.regular,
          color: rgb(0.2, 0.22, 0.28),
        });
        narrY -= 11;
      }
      curRightY = narrY - 4;
    }

    page.drawLine({
      start: { x: rightX, y: curRightY + 2 },
      end: { x: rightX + rightWidth, y: curRightY + 2 },
      thickness: 0.5,
      color: rgb(0.88, 0.9, 0.94),
    });
    curRightY -= 10;
  }

  // 2. Production Guide Section (Visual & Assets)
  if (content.visLines.length > 0 || content.assetLines.length > 0) {
    page.drawText("● 연출 / 제작 가이드", {
      x: rightX,
      y: curRightY,
      size: 8.5,
      font: fonts.bold,
      color: rgb(0.15, 0.2, 0.3),
    });
    curRightY -= 13;

    if (content.visLines.length > 0) {
      page.drawText("[화면 연출]", {
        x: rightX,
        y: curRightY,
        size: 8,
        font: fonts.bold,
        color: rgb(0.4, 0.25, 0.6),
      });
      let visY = curRightY;
      for (const vl of content.visLines) {
        if (visY < y + 8) break;
        page.drawText(vl, {
          x: rightX + 48,
          y: visY,
          size: 8,
          font: fonts.regular,
          color: rgb(0.25, 0.28, 0.35),
        });
        visY -= 11;
      }
      curRightY = visY - 2;
    }

    if (content.assetLines.length > 0) {
      page.drawText("[시각 제안]", {
        x: rightX,
        y: curRightY,
        size: 8,
        font: fonts.bold,
        color: rgb(0.2, 0.45, 0.4),
      });
      let astY = curRightY;
      for (const al of content.assetLines) {
        if (astY < y + 8) break;
        page.drawText(al, {
          x: rightX + 48,
          y: astY,
          size: 8,
          font: fonts.regular,
          color: rgb(0.25, 0.28, 0.35),
        });
        astY -= 11;
      }
      curRightY = astY - 4;
    }

    page.drawLine({
      start: { x: rightX, y: curRightY + 2 },
      end: { x: rightX + rightWidth, y: curRightY + 2 },
      thickness: 0.5,
      color: rgb(0.88, 0.9, 0.94),
    });
    curRightY -= 10;
  }

  // 3. Evidence & References / Review
  if (content.evLines.length > 0 || content.refLines.length > 0 || content.reviewReasonLines.length > 0) {
    if (content.evLines.length > 0) {
      page.drawText("[원문 근거]", {
        x: rightX,
        y: curRightY,
        size: 7.5,
        font: fonts.bold,
        color: rgb(0.45, 0.48, 0.55),
      });
      let evY = curRightY;
      for (const el of content.evLines) {
        if (evY < y + 8) break;
        page.drawText(el, {
          x: rightX + 48,
          y: evY,
          size: 7.5,
          font: fonts.regular,
          color: rgb(0.45, 0.48, 0.55),
        });
        evY -= 10;
      }
      curRightY = evY - 2;
    }

    if (content.refLines.length > 0) {
      page.drawText("[보강 자료]", {
        x: rightX,
        y: curRightY,
        size: 7.5,
        font: fonts.bold,
        color: rgb(0.3, 0.45, 0.55),
      });
      let rfY = curRightY;
      for (const rl of content.refLines) {
        if (rfY < y + 8) break;
        page.drawText(rl, {
          x: rightX + 48,
          y: rfY,
          size: 7.5,
          font: fonts.regular,
          color: rgb(0.35, 0.4, 0.5),
        });
        rfY -= 10;
      }
      curRightY = rfY - 2;
    }

    if (content.reviewReasonLines.length > 0) {
      let rvrY = curRightY;
      for (const rvl of content.reviewReasonLines) {
        if (rvrY < y + 8) break;
        page.drawText(rvl, {
          x: rightX,
          y: rvrY,
          size: 7.5,
          font: fonts.bold,
          color: rgb(0.85, 0.2, 0.1),
        });
        rvrY -= 10;
      }
      curRightY = rvrY;
    }
  }
}
