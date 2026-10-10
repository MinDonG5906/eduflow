import "server-only";
import { PDFDocument } from "pdf-lib";
import { GenerationError, generationRequestSchema } from "../generation-contract";
import { MAX_AI_PDF_BYTES } from "../pdf-source";

export type PdfAttachment = { filename: string; data: Uint8Array };

export async function readPdfGenerationRequest(request: Request) {
  const ceiling = MAX_AI_PDF_BYTES + 160000;
  if (Number(request.headers.get("content-length")) > ceiling) throw new GenerationError("PDF_TOO_LARGE");
  if (!request.body) throw new GenerationError("PDF_NOT_ATTACHED");
  const chunks: Uint8Array[] = [], reader = request.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ceiling) { await reader.cancel(); throw new GenerationError("PDF_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type")! } }).formData(); }
  catch { throw new GenerationError("INVALID_REQUEST"); }
  const raw = form.get("input"), file = form.get("pdf");
  if (typeof raw !== "string" || raw.length > 150000) throw new GenerationError("INVALID_REQUEST");
  let input;
  try { input = generationRequestSchema.parse(JSON.parse(raw)); } catch { throw new GenerationError("INVALID_REQUEST"); }
  if (!input.pdfSource || !file || typeof file === "string" || !file.size) throw new GenerationError("PDF_NOT_ATTACHED");
  if (file.size >= MAX_AI_PDF_BYTES) throw new GenerationError("PDF_TOO_LARGE");
  const data = new Uint8Array(await file.arrayBuffer());
  if (!Buffer.from(data.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new GenerationError("INVALID_PDF");
  try {
    const pdf = await PDFDocument.load(data, { updateMetadata: false });
    if (pdf.getPageCount() !== input.pdfSource.pages.length) throw new GenerationError("INVALID_PDF_PAGES");
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError("INVALID_PDF");
  }
  return { input, pdf: { filename: "selected-pages.pdf", data } satisfies PdfAttachment };
}
