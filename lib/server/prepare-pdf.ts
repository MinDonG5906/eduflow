import "server-only";
import { PDFDocument } from "pdf-lib";
import { GenerationError } from "../generation-contract";
import { MAX_AI_PDF_BYTES } from "../pdf-source";
import type { PdfAttachment } from "./pdf-input";
import { renderPdfPages } from "./pdf-render";

// Some file-processing paths expose embedded pictures but omit vector artwork.
// Bake each selected page into one image-backed PDF page, keeping page order
// and the visible crop/rotation. The browser's original selection stays intact.
// No separate input_image content is sent to the model.
export async function preparePdfInput(pdf: PdfAttachment, signal: AbortSignal): Promise<PdfAttachment> {
  signal.throwIfAborted();
  const source = await PDFDocument.load(pdf.data, { updateMetadata: false });
  const images = await renderPdfPages(pdf.data, signal);
  const prepared = await PDFDocument.create();
  prepared.setProducer("EduFlow selected PDF compatibility");
  for (const [index, original] of source.getPages().entries()) {
    signal.throwIfAborted();
    const { width, height } = original.getCropBox();
    const rotated = Math.abs(original.getRotation().angle % 180) === 90;
    const size: [number, number] = rotated ? [height, width] : [width, height];
    const page = prepared.addPage(size);
    const image = await prepared.embedPng(images[index]);
    page.drawImage(image, { x: 0, y: 0, width: size[0], height: size[1] });
  }
  signal.throwIfAborted();
  const data = await prepared.save({ useObjectStreams: false });
  signal.throwIfAborted();
  if (data.byteLength >= MAX_AI_PDF_BYTES) throw new GenerationError("PDF_TOO_LARGE");
  return { filename: pdf.filename, data };
}
