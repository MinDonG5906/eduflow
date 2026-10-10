import "server-only";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { GenerationError } from "../generation-contract";
import { MAX_AI_PDF_BYTES } from "../pdf-source";

// Render only the supplied selection, for local previews or compatibility PDF
// preparation. Images are never attached separately to the provider request.
export async function renderPdfPages(data: Uint8Array, signal?: AbortSignal, preview = false) {
  signal?.throwIfAborted();
  const document = await PDFDocument.load(data, { updateMetadata: false });
  const parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false });
  const images: Uint8Array[] = [];
  let bytes = data.byteLength;
  try {
    for (const [i, page] of document.getPages().entries()) {
      signal?.throwIfAborted();
      const crop = page.getCropBox();
      const rotated = Math.abs(page.getRotation().angle % 180) === 90;
      const width = rotated ? crop.height : crop.width;
      const height = rotated ? crop.width : crop.height;
      if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) throw new GenerationError("INVALID_PDF");
      const result = await parser.getScreenshot({ partial: [i + 1], desiredWidth: Math.max(1, Math.min(preview ? 1024 : 1536, 2048 * width / height)), imageDataUrl: false });
      signal?.throwIfAborted();
      const image = result.pages[0]?.data;
      if (!image) throw new GenerationError("INVALID_PDF");
      bytes += image.byteLength;
      if (bytes >= MAX_AI_PDF_BYTES) throw new GenerationError("PDF_RENDER_TOO_LARGE");
      images.push(new Uint8Array(image));
    }
    return images;
  } finally { await parser.destroy(); }
}
