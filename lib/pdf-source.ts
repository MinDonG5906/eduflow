import { z } from "zod";

export const MAX_AI_PDF_BYTES = 50_000_000;
export const pdfSourceSchema = z.object({
  // Display metadata uses the original filename; the attachment is always a PDF.
  name: z.string().min(1).max(255).regex(/\.(pdf|pptx?|hwpx?)$/i),
  pages: z.array(z.number().int().min(1).max(200)).min(1).max(200)
    .refine((pages) => pages.every((page, i) => i === 0 || page > pages[i - 1])),
});
export type PdfSource = z.infer<typeof pdfSourceSchema>;

/** Attachment order can differ from both printed folios and original file order. */
export function pdfPageLocations(pages: number[]) {
  return pages.map((page, index) => ({ attachmentPage: index + 1, originalPage: page, sourceId: `pdf-page:${page}` }));
}

export function citedPdfPage(source?: PdfSource, scene?: { sourceId: string; pdfSource?: PdfSource }): number | null {
  const match = /^pdf-page:(\d+)$/.exec(scene?.sourceId ?? "");
  const page = match ? Number(match[1]) : 0;
  return source && scene?.pdfSource?.name === source.name &&
    scene.pdfSource.pages.includes(page) && source.pages.includes(page) ? page : null;
}

export const isPresentation = (name: string) => /\.pptx?$/i.test(name);
export const isHangul = (name: string) => /\.hwpx?$/i.test(name);
export const sourceUnit = (name: string) => isPresentation(name) ? "슬라이드" : "페이지";
export type SourceFormat = "PDF" | "PPT" | "HWP" | "HWPX";
export const sourceFormat = (name: string): SourceFormat => isPresentation(name) ? "PPT" : isHangul(name) ? /\.hwpx$/i.test(name) ? "HWPX" : "HWP" : "PDF";
export const sourceNote = (source: PdfSource) => `원본 ${sourceFormat(source.name)}: ${source.name}\n선택 ${sourceUnit(source.name)}: ${source.pages.join(", ")}\n\n`;

export function parsePdfPages(value: string, total: number): number[] {
  if (!value.trim()) return [];
  const pages = new Set<number>();
  for (const part of value.split(/[,，]/)) {
    const match = /^\s*(\d+)\s*(?:[-~–]\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error("페이지는 ‘3-5, 8’처럼 입력해 주세요.");
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > total) throw new Error(`1~${total}페이지 안에서 선택해 주세요.`);
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Compact an already sorted selection for the range field and saved summary. */
export function formatPdfPages(pages: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    const end = pages[i];
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(", ");
}

export async function selectPdfPages(data: Uint8Array, pages: number[]) {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(data, { updateMetadata: false });
  if (!pdfSourceSchema.shape.pages.safeParse(pages).success || pages.some((page) => page > source.getPageCount()))
    throw new Error("선택한 PDF 페이지를 확인해 주세요.");
  const selected = await PDFDocument.create();
  for (const page of await selected.copyPages(source, pages.map((page) => page - 1))) selected.addPage(page);
  const bytes = await selected.save({ useObjectStreams: false });
  if (bytes.length >= MAX_AI_PDF_BYTES) throw new Error("선택한 PDF가 50MB 이상입니다. 보낼 페이지 수를 줄여 주세요.");
  return bytes;
}
