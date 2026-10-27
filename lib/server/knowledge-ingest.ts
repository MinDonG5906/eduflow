import "server-only";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { createWorker } from "tesseract.js";
import type { KnowledgeImportPage } from "../knowledge";
import { DocumentImportError } from "./document-import-error";
import { convertHangul } from "./hangul-import";
import { convertPresentation, findOfficeConverter } from "./presentation-import";
import { prepareOfficeFonts } from "./office-fonts";
import { runDocumentConversion } from "./document-conversion";

export function knowledgePageSelection(value: string, total: number): number[] {
  if (!value.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const range of value.split(",")) {
    const match = /^\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*$/.exec(range);
    if (!match) throw new DocumentImportError("페이지 범위를 확인해 주세요.");
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end > total || end < start || end - start > 199)
      throw new DocumentImportError(`페이지는 1~${total} 사이에서 선택해 주세요.`);
    for (let page = start; page <= end; page++) pages.add(page);
  }
  if (!pages.size || pages.size > 200) throw new DocumentImportError("최대 200페이지를 선택할 수 있습니다.");
  return [...pages].sort((a, b) => a - b);
}

async function convertWordToPdf(data: Buffer, signal: AbortSignal): Promise<Buffer> {
  let directory: string | undefined;
  try {
    const binary = await findOfficeConverter();
    directory = await mkdtemp(join(tmpdir(), "eduflow-word-"));
    const profile = join(directory, "profile"), output = join(directory, "output");
    await mkdir(join(profile, "user"), { recursive: true });
    await mkdir(output);
    await prepareOfficeFonts(profile);
    await writeFile(join(profile, "user", "registrymodifications.xcu"), `<oor:items xmlns:oor="http://openoffice.org/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>`, { mode: 0o600 });
    const input = join(directory, "source.docx");
    await writeFile(input, data, { mode: 0o600 });
    await runDocumentConversion(binary, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--nologo", "--nodefault", "--norestore",
      "--convert-to", "pdf:writer_pdf_Export", "--outdir", output, input,
    ], signal, 120_000, "Word");
    return await readFile(join(output, "source.pdf"));
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError("Word를 PDF로 변환하지 못했습니다. 파일을 확인하거나 PDF로 저장해 올려 주세요.");
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

export async function normalizeKnowledgeFile(name: string, data: Buffer, signal: AbortSignal): Promise<Buffer> {
  if (/\.pdf$/i.test(name)) return data;
  if (/\.docx$/i.test(name)) return convertWordToPdf(data, signal);
  if (/\.hwpx?$/i.test(name)) return (await convertHangul(name, data, signal)).pdf;
  if (/\.pptx?$/i.test(name)) return (await convertPresentation(name, data, signal)).pdf;
  throw new DocumentImportError("PDF, Word(.docx), 한글(HWP/HWPX), PPT/PPTX 파일을 선택해 주세요.");
}

export type OcrResult = { text: string; confidence: number };
export type OcrPage = (image: Buffer, signal: AbortSignal) => Promise<OcrResult>;

export async function createKoreanOcr(): Promise<{ recognize: OcrPage; close: () => Promise<void> }> {
  const cachePath = join(process.cwd(), ".eduflow-private", "ocr-cache");
  await mkdir(cachePath, { recursive: true, mode: 0o700 });
  const worker = await createWorker(["kor", "eng"], 1, { cachePath });
  return {
    recognize: async (image, signal) => {
      signal.throwIfAborted();
      const result = await worker.recognize(image);
      signal.throwIfAborted();
      return { text: result.data.text, confidence: result.data.confidence };
    },
    close: async () => { await worker.terminate(); },
  };
}

const clean = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
const suspicious = (text: string) => /[\ufffd\ue000-\uf8ff]/u.test(text);
function readablePdfText(raw: string): string {
  // pdf-parse inserts tabs for ordinary word gaps (its default cell threshold
  // is 7), so a tab alone cannot identify a table. U+F000 is an empty bullet
  // glyph in some converted PDFs; keep all other unknown glyphs for review.
  const bullets = (raw.match(/\uf000/gu) ?? []).length;
  const withoutBullets = bullets && bullets <= Math.max(3, Math.floor(raw.length * 0.02))
    ? raw.replace(/\uf000/gu, "") : raw;
  return clean(withoutBullets.replace(/\t+/g, " ").replace(/ {2,}/g, " "));
}

function structuredTables(tables: string[][][]): { text: string; reason: string } {
  const sections: string[] = [];
  for (const [tableIndex, rows] of tables.entries()) {
    const columns = rows[0]?.length ?? 0;
    const label = `이 페이지의 다열 표 ${tableIndex + 1}`;
    if (!rows.length || columns > 20 || rows.length > 100)
      return { text: "", reason: `${label}의 행·열 수를 안정적으로 읽지 못했습니다.` };
    const mismatch = rows.findIndex((row) => row.length !== columns);
    if (mismatch >= 0)
      return { text: "", reason: `${label}: 첫 행은 ${columns}열, ${mismatch + 1}행은 ${rows[mismatch].length}열로 읽혔습니다.` };
    if (columns < 2)
      return { text: "", reason: `${label}의 열 구조를 읽지 못했습니다.` };
    const empty = rows.findIndex((row) => !row.some((cell) => cell.trim()));
    if (empty >= 0)
      return { text: "", reason: `${label}의 ${empty + 1}행에서 글자를 읽지 못했습니다.` };
    const lines = rows.map((row, rowIndex) => {
      const cells = row.flatMap((cell, columnIndex) => {
        const text = readablePdfText(cell);
        return text ? [`열 ${columnIndex + 1}: ${text}`] : [];
      });
      return `행 ${rowIndex + 1} | ${cells.join(" | ")}`;
    });
    if (lines.some((line) => suspicious(line)))
      return { text: "", reason: `${label}에 판독되지 않은 글자가 있습니다.` };
    sections.push(`[표 ${tableIndex + 1}]\n${lines.join("\n")}`);
  }
  return { text: sections.join("\n\n"), reason: "" };
}

export async function analyzeKnowledgePdf(
  pdf: Buffer, range: string, signal: AbortSignal,
  makeOcr = createKoreanOcr,
): Promise<{ pages: KnowledgeImportPage[]; total: number }> {
  if (!pdf.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new DocumentImportError("올바른 PDF 파일을 선택해 주세요.");
  const document = await PDFDocument.load(pdf, { updateMetadata: false }).catch(() => { throw new DocumentImportError("PDF를 열지 못했습니다."); });
  const total = document.getPageCount();
  if (!total || (!range.trim() && total > 200))
    throw new DocumentImportError("200페이지가 넘는 PDF는 필요한 페이지 범위를 지정해 주세요.", 413);
  const selected = knowledgePageSelection(range, total);
  const parser = new PDFParse({ data: new Uint8Array(pdf), isEvalSupported: false });
  let ocr: Awaited<ReturnType<typeof createKoreanOcr>> | undefined;
  let ocrUnavailable = false;
  const pages: KnowledgeImportPage[] = [];
  try {
    const extracted = await parser.getText({ partial: selected, pageJoiner: "" });
    const tables = await parser.getTable({ partial: selected });
    const tablePages = new Map(tables.pages.filter((page) => page.tables.length).map((page) => [page.num, page.tables]));
    for (const page of extracted.pages) {
      signal.throwIfAborted();
      const raw = clean(page.text);
      const readable = readablePdfText(raw);
      // A single column is a text box or ordered list, not a cell relation to
      // verify. Only multi-column tables need structural validation.
      const pageTables = (tablePages.get(page.num) ?? []).filter((rows) => rows.some((row) => row.length > 1));
      if (pageTables.length) {
        const structure = structuredTables(pageTables);
        const safe = Boolean(structure.text) && !suspicious(readable);
        const text = safe ? `${readable}\n\n${structure.text}` : raw;
        pages.push({ page: page.num, text, method: "text", confidence: null,
          reviewReason: safe ? "" : structure.reason || "글자 판독이 불확실합니다.",
          needsReview: !safe });
        continue;
      }
      if (readable.length >= 40 && !suspicious(readable)) {
        pages.push({ page: page.num, text: readable, method: "text", confidence: null, reviewReason: "", needsReview: false });
        continue;
      }
      let recognized: OcrResult | undefined;
      let reason = "";
      try {
        if (ocrUnavailable) throw new Error("OCR_UNAVAILABLE");
        ocr ??= await makeOcr();
        const screenshot = await parser.getScreenshot({ partial: [page.num], desiredWidth: 1800, imageDataUrl: false });
        recognized = await ocr.recognize(Buffer.from(screenshot.pages[0].data), signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!ocr) ocrUnavailable = true;
        reason = "OCR을 실행하지 못했습니다. 원본을 확인해 주세요.";
      }
      const ocrText = clean(recognized?.text ?? "");
      const confidence = recognized?.confidence ?? null;
      // A few extra OCR characters do not make it more accurate than the PDF's
      // readable text. Low-confidence OCR remains available only when the PDF
      // has no usable text of its own.
      const useOcr = Boolean(ocrText) && (!readable || suspicious(readable) ||
        (confidence !== null && confidence >= 90 && !suspicious(ocrText) && ocrText.length > readable.length));
      const text = useOcr ? ocrText : readable;
      const safe = useOcr && ocrText.length >= 40 && confidence !== null && confidence >= 90 && !suspicious(ocrText);
      const reviewReason = reason || (readable && !useOcr
        ? "PDF에서 읽힌 글이 적고 OCR 판독도 불확실합니다. 원본에서 빠진 글자를 확인해 주세요."
        : "글자 판독이 불확실합니다.");
      pages.push({ page: page.num, text, method: useOcr ? "ocr" : raw ? "text" : "unreadable",
        confidence: useOcr ? confidence : null, reviewReason: safe ? "" : reviewReason,
        needsReview: !safe });
    }
  } finally { await ocr?.close(); await parser.destroy(); }
  if (pages.length !== selected.length) throw new DocumentImportError("선택한 페이지를 모두 읽지 못했습니다.");
  if (pages.reduce((size, page) => size + page.text.length, 0) > 200000)
    throw new DocumentImportError("추출된 글이 200,000자를 넘습니다. 페이지 범위를 나눠 등록해 주세요.", 413);
  return { pages, total };
}
