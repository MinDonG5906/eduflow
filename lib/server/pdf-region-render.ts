import "server-only";
import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import type { Box, PageLayout } from "./pdf-layout";

export type PageImage = { id: string; page: number; kind: "context" | "figure"; data: Uint8Array; width: number; height: number };

async function renderRegion(page: PDFPageProxy, bounds: Box, scale: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil((bounds[2] - bounds[0]) * scale));
  const height = Math.max(1, Math.ceil((bounds[3] - bounds[1]) * scale));
  const canvas = createCanvas(width, height);
  const task = page.render({ canvas: null, canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
    viewport, transform: [1, 0, 0, 1, -bounds[0] * scale, -bounds[1] * scale], background: "rgb(255,255,255)" });
  const abort = () => task.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) task.cancel();
    await task.promise;
    signal.throwIfAborted();
    return { data: new Uint8Array(canvas.toBuffer("image/png")), width, height };
  } finally { signal.removeEventListener("abort", abort); canvas.width = 1; canvas.height = 1; }
}

export async function renderLayoutImages(page: PDFPageProxy, layout: PageLayout, signal: AbortSignal): Promise<PageImage[]> {
  // Keep the whole-page context for cross-cell relationships, color and notes.
  // Figure crops retain the pixel density of a 2048-pixel-wide original page.
  const context = await renderRegion(page, [0, 0, layout.width, layout.height], Math.min(640 / layout.width, 896 / layout.height), signal);
  const result: PageImage[] = [{ id: layout.contextImage, page: layout.page, kind: "context", ...context }];
  for (const figure of layout.figures) {
    const pad = 10;
    const box: Box = [Math.max(0, figure.bounds[0] - pad), Math.max(0, figure.bounds[1] - pad), Math.min(layout.width, figure.bounds[2] + pad), Math.min(layout.height, figure.bounds[3] + pad)];
    const rendered = await renderRegion(page, box, Math.min(2048 / layout.width, 2048 / layout.height), signal);
    result.push({ id: figure.id, page: layout.page, kind: "figure", ...rendered });
  }
  return result;
}
