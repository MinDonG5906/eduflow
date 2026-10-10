import "server-only";
import { assertLocalAIRequest } from "./ai-config";
import { readPdfGenerationRequest } from "./pdf-input";
import { GenerationError } from "../generation-contract";
import { renderPdfPages } from "./pdf-render";

export async function previewPdfRequest(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    assertLocalAIRequest(request);
    const { pdf, input } = await readPdfGenerationRequest(request);
    if (input.pdfSource!.pages.length !== 1) throw new GenerationError("INVALID_PDF_PAGES");
    const [image] = await renderPdfPages(pdf.data, request.signal, true);
    return new Response(new Uint8Array(image), { headers: { ...headers, "Content-Type": "image/png" } });
  } catch (error) {
    const failure = error instanceof GenerationError ? error : new GenerationError("INVALID_PDF");
    return Response.json({ error: failure.message }, { status: failure.status, headers });
  }
}
