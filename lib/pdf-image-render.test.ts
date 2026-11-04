import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, PDFName } from "pdf-lib";
import { renderPdfPages } from "./server/pdf-render";
import { preparePdfContent } from "./server/pdf-content";
import { knowledgePageImage, cropKnowledgeFigure } from "./server/knowledge-vision";
import { selectPdfPages } from "./pdf-source";

// Self-authored 32x32 green JPEG 2000 image, encoded losslessly with OpenJPEG.
// JPXDecode is also used by the missing illustrations in the forklift PDF.
const jpx = Buffer.from("AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAIAAAACAAAwcHAAAAAAAPY29scgEAAAAAABAAAACzanAyY/9P/1EALwAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAALAAB/5PPtAgIH8fUBAG/z7QIBy+AgICAgICAgICAgICAgID/2Q==", "base64");

async function imagePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  const image = pdf.context.register(pdf.context.stream(jpx, {
    Type: "XObject", Subtype: "Image", Width: 32, Height: 32,
    ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "JPXDecode",
  }));
  page.node.set(PDFName.of("Resources"), pdf.context.obj({ XObject: { Picture: image } }));
  page.node.set(PDFName.of("Contents"), pdf.context.register(pdf.context.stream("q 100 0 0 100 50 50 cm /Picture Do Q")));
  return selectPdfPages(await pdf.save(), [1]);
}

async function assertGreenPicture(png: Uint8Array) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  try {
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const [r, g, b, a] = ctx.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;
    assert.ok(r < 50 && g > 150 && g < 210 && b < 90 && a > 240,
      `JPEG 2000 picture disappeared or changed color: ${[r, g, b, a]}`);
  } finally { canvas.width = 1; canvas.height = 1; }
}

test("JPEG 2000 illustrations survive page-selection previews", async () => {
  await assertGreenPicture((await renderPdfPages(await imagePdf(), undefined, true))[0]);
});

test("JPEG 2000 illustrations survive PDF preparation for AI without a provider call", async () => {
  const result = await preparePdfContent({ filename: "jpx.pdf", data: await imagePdf() }, [3], AbortSignal.timeout(30000));
  assert.deepEqual(result.visualPages, [3]);
  assert.ok(result.pdf);
  await assertGreenPicture((await renderPdfPages(result.pdf.data, undefined, true))[0]);
});

test("recommended figure crops retain JPEG 2000 illustrations", async () => {
  const page = await knowledgePageImage(Buffer.from(await imagePdf()), 1, AbortSignal.timeout(30000));
  const crop = await cropKnowledgeFigure(page, { id: "image1", title: "Illustration", bounds: [0.25, 0.25, 0.75, 0.75] });
  await assertGreenPicture(crop);
});
