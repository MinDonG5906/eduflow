import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import fontkit from "@pdf-lib/fontkit";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, rgb } from "pdf-lib";
import { selectPdfPages } from "./pdf-source";
import { preparePdfContent } from "./server/pdf-content";
import { renderPdfPages } from "./server/pdf-render";

// A self-contained fixture with the same dependency as the LOTO document:
// Identity-H text, Adobe-Korea1 CIDSystemInfo, and no embedded ToUnicode map.
// Its embedded test glyphs are Latin, so no OS-specific Korean font is needed.
async function koreanCMapPdf() {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(readFileSync(join(root, "standard_fonts/LiberationSans-Regular.ttf")));
  const page = pdf.addPage([400, 150]);
  page.drawText("LOTO SAFETY", { font, size: 36, x: 30, y: 60 });
  // Keep the real image-based AI input path, rather than prose-only extraction.
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 10, color: rgb(1, 0, 0) });
  await pdf.flush();
  const type0 = pdf.context.lookup(font.ref, PDFDict);
  const descendant = type0.lookup(PDFName.of("DescendantFonts"), PDFArray).lookup(0, PDFDict);
  type0.delete(PDFName.of("ToUnicode"));
  descendant.set(PDFName.of("CIDSystemInfo"), pdf.context.obj({
    Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Korea1"), Supplement: 2,
  }));
  return selectPdfPages(await pdf.save(), [1]);
}

async function assertVisibleGlyphs(png: Uint8Array) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  // Only the text area: the colored graphic cannot make a blank page pass.
  const pixels = ctx.getImageData(Math.floor(image.width * 0.05), Math.floor(image.height * 0.25),
    Math.floor(image.width * 0.9), Math.floor(image.height * 0.4)).data;
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80 && pixels[i + 3] > 200) ink++;
  assert.ok(ink > 1000, `Text glyphs disappeared: ${ink} dark pixels`);
}

test("Korean CID fonts remain visible in page previews and the PDF prepared for AI", async () => {
  const data = await koreanCMapPdf();
  await assertVisibleGlyphs((await renderPdfPages(data, undefined, true))[0]);
  const result = await preparePdfContent({ filename: "cmap.pdf", data }, [7], AbortSignal.timeout(30000));
  assert.deepEqual(result.visualPages, [7]);
  assert.ok(result.pdf);
  await assertVisibleGlyphs((await renderPdfPages(result.pdf.data, undefined, true))[0]);
});
