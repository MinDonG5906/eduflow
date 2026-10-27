import "server-only";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { GenerationError } from "../generation-contract";
import { selectPdfPages } from "../pdf-source";
import type { PdfAttachment } from "./pdf-input";
import { preparePdfInput } from "./prepare-pdf";
import { analyzePdfTable, type PageLayout } from "./pdf-layout";
import { renderLayoutImages, type PageImage } from "./pdf-region-render";
import { MAX_AI_PDF_BYTES } from "../pdf-source";

export type PdfContent = {
  textPages: { page: number; text: string }[];
  visualPages: number[];
  layoutPages: PageLayout[];
  images: PageImage[];
  pdf?: PdfAttachment;
};

// Only simple, visible text qualifies. Unknown operators, vectors, images,
// clipping, transparency and complex layouts retain the full visual fallback.
const textOperators = new Set<number>([
  OPS.dependency, OPS.save, OPS.restore, OPS.transform,
  OPS.beginText, OPS.endText, OPS.setCharSpacing, OPS.setWordSpacing,
  OPS.setHScale, OPS.setLeading, OPS.setFont, OPS.setTextRenderingMode,
  OPS.setTextRise, OPS.moveText, OPS.setLeadingMoveText, OPS.setTextMatrix,
  OPS.nextLine, OPS.showText, OPS.showSpacedText, OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText, OPS.setFillRGBColor, OPS.setFillGray,
  OPS.setFillCMYKColor, OPS.setFillColorSpace, OPS.setFillColor,
  OPS.markPoint, OPS.markPointProps, OPS.beginMarkedContent, OPS.endMarkedContent,
]);

function readableText(items: TextItem[], view: number[]): string | null {
  let previous: TextItem | undefined;
  let text = "";
  for (const item of items) {
    if (!item.str.trim()) continue;
    const [a, b, c, d, x, y] = item.transform;
    // Keep rotated/vertical text, cropped text and uncertain Unicode visual.
    if (item.dir !== "ltr" || b !== 0 || c !== 0 || a <= 0 || d <= 0 ||
        x < view[0] || x + item.width > view[2] + 1 || y < view[1] || y + item.height > view[3] + 1 ||
        /[\u0000-\u0008\u000b-\u001f\ufffd\ue000-\uf8ff]/u.test(item.str)) return null;
    if (previous) {
      const sameLine = Math.abs(y - previous.transform[5]) < Math.max(1, item.height * 0.25);
      const gap = x - (previous.transform[4] + previous.width);
      // Widely separated cells and changing reading order may encode a table
      // or columns even when the PDF has no drawn grid.
      if (sameLine ? gap > Math.max(item.height, previous.height) * 1.5 || gap < -1
        : y > previous.transform[5] + 1) return null;
      text += sameLine ? (gap > Math.max(item.height, previous.height) * 0.15 ? " " : "") : "\n";
    }
    text += item.str;
    previous = item;
  }
  return text.trim() || null;
}

/** Original page numbers are kept separately from positions in the attachment. */
export async function preparePdfContent(
  pdf: PdfAttachment, pages: number[], signal: AbortSignal,
): Promise<PdfContent> {
  signal.throwIfAborted();
  const loading = getDocument({ data: new Uint8Array(pdf.data), isEvalSupported: false, verbosity: 0, stopAtErrors: true });
  const result: PdfContent = { textPages: [], visualPages: [], layoutPages: [], images: [] };
  const visualPositions: number[] = [];
  let imageBytes = 0;
  try {
    const document = await loading.promise;
    if (document.numPages !== pages.length) throw new GenerationError("INVALID_PDF_PAGES");
    for (const [index, originalPage] of pages.entries()) {
      signal.throwIfAborted();
      const page = await document.getPage(index + 1);
      let text: string | null = null;
      let layout: PageLayout | null = null;
      try {
        const operators = await page.getOperatorList();
        const simple = page.rotate === 0 && !page.isPureXfa && operators.fnArray.every((op, i) =>
          textOperators.has(op) && (op !== OPS.setTextRenderingMode || operators.argsArray[i][0] === 0));
        if (simple && (await page.getAnnotations()).every((annotation) => annotation.subtype === "Link")) {
          const content = await page.getTextContent();
          text = readableText(content.items.filter((item): item is TextItem => "str" in item), page.view);
        }
        if (!text) {
          layout = await analyzePdfTable(page, originalPage);
          if (layout && result.images.length + layout.figures.length + 1 > 400) layout = null;
          if (layout) {
            const images = await renderLayoutImages(page, layout, signal);
            imageBytes += images.reduce((n, image) => n + image.data.byteLength, 0);
            if (imageBytes >= MAX_AI_PDF_BYTES) throw new GenerationError("PDF_RENDER_TOO_LARGE");
            result.images.push(...images);
            result.layoutPages.push(layout);
          }
        }
      } catch (error) {
        // Extraction failures must not silently discard page content.
        signal.throwIfAborted();
        if (error instanceof GenerationError) throw error;
        layout = null;
      } finally { page.cleanup(); }
      if (text) result.textPages.push({ page: originalPage, text });
      else if (!layout) { result.visualPages.push(originalPage); visualPositions.push(index + 1); }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GenerationError) throw error;
    // If the strict extraction parser cannot inspect this document, preserve
    // the previous rendering path instead of losing otherwise readable pages.
    result.textPages = [];
    result.layoutPages = [];
    result.images = [];
    result.visualPages = [...pages];
    visualPositions.splice(0, visualPositions.length, ...pages.map((_, i) => i + 1));
  } finally { await loading.destroy(); }
  signal.throwIfAborted();
  if (visualPositions.length) {
    const data = visualPositions.length === pages.length ? pdf.data : await selectPdfPages(pdf.data, visualPositions);
    result.pdf = await preparePdfInput({ filename: pdf.filename, data }, signal);
    if (result.pdf.data.byteLength + result.images.reduce((n, image) => n + image.data.byteLength, 0) >= MAX_AI_PDF_BYTES)
      throw new GenerationError("PDF_RENDER_TOO_LARGE");
  }
  return result;
}
