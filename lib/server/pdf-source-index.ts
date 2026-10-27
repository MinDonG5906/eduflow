import "server-only";
import { getDocument, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import { assertLocalAIRequest } from "./ai-config";
import { readPdfGenerationRequest } from "./pdf-input";
import { GenerationError } from "../generation-contract";
import type { SourceBox, SourcePage } from "../source-location";

/** Local text index of the selected original PDF. This never invokes a provider. */
export async function indexPdfSource(data: Uint8Array, originalPages: number[], signal: AbortSignal) {
  signal.throwIfAborted();
  const loading = getDocument({ data: new Uint8Array(data), isEvalSupported: false, verbosity: 0 });
  const abort = () => { void loading.destroy().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const pages: SourcePage[] = [];
  let characters = 0, runCount = 0;
  try {
    const pdf = await loading.promise;
    if (pdf.numPages !== originalPages.length) throw new GenerationError("INVALID_PDF_PAGES");
    for (const [index, originalPage] of originalPages.entries()) {
      signal.throwIfAborted();
      const page = await pdf.getPage(index + 1);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        let text = "";
        let previous: { x: number; y: number; height: number } | undefined;
        const runs: SourcePage["runs"] = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          if (!item.str.trim() || /^[·ㆍ\s]+$/.test(item.str)) {
            if (item.hasEOL && text && !text.endsWith("\n")) { text += "\n"; previous = undefined; }
            else if (/\s/.test(item.str) && text && !/\s$/.test(text)) text += " ";
            continue;
          }
          const tx = Util.transform(viewport.transform, item.transform);
          let angle = Math.atan2(tx[1], tx[0]);
          if (item.dir === "ttb") angle += Math.PI / 2;
          const height = Math.hypot(tx[2], tx[3]);
          const width = item.dir === "ttb" ? item.height : item.width;
          const ascent = (content.styles[item.fontName]?.ascent ?? 0.85) * height;
          const x = tx[4] + ascent * Math.sin(angle), y = tx[5] - ascent * Math.cos(angle);
          const points = [[x, y], [x + width * Math.cos(angle), y + width * Math.sin(angle)],
            [x - height * Math.sin(angle), y + height * Math.cos(angle)],
            [x + width * Math.cos(angle) - height * Math.sin(angle), y + width * Math.sin(angle) + height * Math.cos(angle)]];
          const raw = [Math.min(...points.map(p => p[0])) / viewport.width, Math.min(...points.map(p => p[1])) / viewport.height,
            Math.max(...points.map(p => p[0])) / viewport.width, Math.max(...points.map(p => p[1])) / viewport.height];
          if (raw.some(value => !Number.isFinite(value)) || raw[2] <= 0 || raw[3] <= 0 || raw[0] >= 1 || raw[1] >= 1) continue;
          const box = raw.map(value => Math.max(0, Math.min(1, value))) as SourceBox;
          if (previous && text && !/\s$/.test(text)) {
            const dx = tx[4] - previous.x, dy = tx[5] - previous.y;
            const cross = Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle));
            const gap = dx * Math.cos(angle) + dy * Math.sin(angle);
            if (cross > Math.max(height, previous.height) * 0.5) text += "\n";
            else if (gap > Math.max(1, Math.max(height, previous.height) * 0.14)) text += " ";
          }
          const start = text.length;
          text += item.str;
          runs.push({ start, end: text.length, box });
          previous = { x: tx[4] + width * Math.cos(angle), y: tx[5] + width * Math.sin(angle), height };
          if (item.hasEOL) { text += "\n"; previous = undefined; }
          if (text.length > 100000 || runs.length > 30000) throw new GenerationError("REQUEST_TOO_LARGE");
        }
        characters += text.length; runCount += runs.length;
        if (characters > 1000000 || runCount > 100000) throw new GenerationError("REQUEST_TOO_LARGE");
        pages.push({ page: originalPage, text, runs });
      } finally { page.cleanup(); }
    }
    signal.throwIfAborted();
    return { pages };
  } finally {
    signal.removeEventListener("abort", abort);
    await loading.destroy();
  }
}

export async function pdfSourceIndexRequest(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    assertLocalAIRequest(request);
    const { input, pdf } = await readPdfGenerationRequest(request);
    return Response.json(await indexPdfSource(pdf.data, input.pdfSource!.pages, request.signal), { headers });
  } catch (error) {
    const failure = error instanceof GenerationError ? error : new GenerationError("INVALID_PDF");
    return Response.json({ error: failure.message }, { status: failure.status, headers });
  }
}
