import "server-only";
import { MAX_DOCUMENT_CHARS, documentSchema, type SourceDocument } from "../documents";

export class DocumentImportError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function inspectPdf(name: string, data: Buffer): Promise<SourceDocument> {
  if (!name || name.length > 255 || !data.length || !data.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new DocumentImportError("올바른 PDF 파일을 선택해 주세요.");
  try {
    const { PDFDocument } = await import("pdf-lib");
    const pages = (await PDFDocument.load(data, { updateMetadata: false })).getPageCount();
    if (pages > 200) throw new DocumentImportError("PDF는 최대 200페이지까지 선택할 수 있습니다. 필요한 부분을 나눠 올려 주세요.", 413);
    return documentSchema.parse({ name, kind: "pdf", pages, text: "", query: "", selectedPages: [] });
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError("PDF를 열지 못했습니다. 손상되었거나 암호로 잠겨 있는지 확인해 주세요.");
  }
}

function checkDocxExpansion(data: Buffer) {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new DocumentImportError("올바른 DOCX 파일이 아닙니다.");
  const entries = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16), expanded = 0;
  // Allow large files with embedded media while still rejecting extreme ZIP expansion.
  const expansionLimit = Math.max(30 * 1024 * 1024, data.length * 4);
  if (entries > 2000) throw new DocumentImportError("Word 문서가 너무 큽니다. 필요한 부분을 별도 파일로 저장해 주세요.", 413);
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50)
      throw new DocumentImportError("Word 파일 구조를 읽을 수 없습니다.");
    expanded += data.readUInt32LE(offset + 24);
    if (expanded > expansionLimit) throw new DocumentImportError("Word 문서의 압축 데이터가 비정상적으로 큽니다. 문서를 다시 저장해 올려 주세요.", 413);
    offset += 46 + data.readUInt16LE(offset + 28) + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
  }
}

export async function extractDocument(name: string, data: Buffer): Promise<SourceDocument> {
  if (!name || name.length > 255) throw new DocumentImportError("파일 이름을 확인해 주세요.");
  if (!data.length) throw new DocumentImportError("빈 파일입니다. 내용이 있는 파일을 선택해 주세요.");
  const extension = name.split(".").pop()?.toLowerCase();
  let text = "", pages: number | undefined;
  try {
    if (extension === "txt") {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (text.includes("\0")) throw new DocumentImportError("텍스트 파일 내용을 확인해 주세요.");
    } else if (extension === "docx") {
      checkDocxExpansion(data);
      const mammoth = await import("mammoth");
      text = (await mammoth.extractRawText({ buffer: data })).value;
    } else if (extension === "pdf") {
      if (!data.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new DocumentImportError("올바른 PDF 파일이 아닙니다.");
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false });
      try {
        pages = (await parser.getInfo()).total;
        if (pages > 200) throw new DocumentImportError("PDF는 최대 200페이지까지 읽을 수 있습니다. 필요한 부분을 나눠 올려 주세요.", 413);
        const result = await parser.getText({ pageJoiner: "" });
        text = result.pages.map((page) => `[PDF ${page.num}페이지]\n\n${page.text.replace(/\n/g, "\n\n")}`).join("\n\n");
        if (!result.pages.some((page) => page.text.trim()))
          throw new DocumentImportError("PDF에서 글자를 찾지 못했습니다. 스캔·이미지 PDF는 문자 인식(OCR) 후 올리거나 내용을 붙여 넣어 주세요.");
      } finally { await parser.destroy(); }
    } else {
      throw new DocumentImportError("PDF, Word(.docx), UTF-8 TXT 파일을 지원합니다. HWP·DOC 파일은 PDF 또는 DOCX로 저장해 주세요.");
    }
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    if (error instanceof Error && error.name === "PasswordException")
      throw new DocumentImportError("암호로 잠긴 PDF입니다. 암호를 해제한 파일을 올려 주세요.");
    throw new DocumentImportError(extension === "txt" ? "UTF-8로 저장한 TXT 파일을 올려 주세요." : "문서를 읽을 수 없습니다. 파일이 손상되었거나 암호로 잠겨 있는지 확인해 주세요.");
  }
  text = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!text) throw new DocumentImportError("문서에서 읽을 수 있는 글자를 찾지 못했습니다.");
  if (text.length > MAX_DOCUMENT_CHARS)
    throw new DocumentImportError("문서는 최대 200,000자까지 읽을 수 있습니다. 필요한 부분을 별도 파일로 저장해 주세요.", 413);
  return documentSchema.parse({ name, text, ...(pages ? { pages } : {}), query: "" });
}

export async function importDocumentRequest(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const url = new URL(request.url);
    const browserURL = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`);
    if (browserURL.port !== url.port || browserURL.username || browserURL.password || browserURL.pathname !== "/" ||
        browserURL.search || browserURL.hash || !["localhost", "127.0.0.1", "[::1]"].includes(browserURL.hostname) ||
        request.headers.get("origin") !== browserURL.origin ||
        (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin"))
      throw new DocumentImportError("현재 에듀플로우 화면에서 파일을 다시 올려 주세요.", 403);
    if (!request.body) throw new DocumentImportError("파일을 선택해 주세요.");
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let name: string;
    try { name = decodeURIComponent(request.headers.get("x-document-name") ?? ""); }
    catch { throw new DocumentImportError("파일 이름을 읽을 수 없습니다."); }
    const data = Buffer.concat(chunks);
    return Response.json(await (/\.pdf$/i.test(name) ? inspectPdf(name, data) : extractDocument(name, data)), { headers });
  } catch (error) {
    const failure = error instanceof DocumentImportError ? error : new DocumentImportError("파일을 읽지 못했습니다. 다시 올려 주세요.");
    return Response.json({ error: failure.message }, { status: failure.status, headers });
  }
}
