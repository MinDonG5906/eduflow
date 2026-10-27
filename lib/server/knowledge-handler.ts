import "server-only";
import { z } from "zod";
import { knowledgeSourceSchema } from "../knowledge";
import { GenerationError } from "../generation-contract";
import { assertLocalAIRequest } from "./ai-config";
import { DocumentImportError } from "./document-import-error";
import { extractDocument } from "./document-import";
import { KnowledgeBase } from "./knowledge-base";

const headers = { "Cache-Control": "no-store" };
const updateSchema = z.object({ id: z.string().uuid(), active: z.boolean() });
const searchSchema = z.object({ query: z.string().trim().min(3).max(20000) });

function selectedPages(value: string, total: number): number[] {
  const pages = new Set<number>();
  for (const range of value.split(",")) {
    const match = /^\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*$/.exec(range);
    if (!match) throw new DocumentImportError("PDF 페이지 범위를 확인해 주세요.");
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end > total || end < start || end - start > 199)
      throw new DocumentImportError(`PDF 페이지는 1~${total} 사이에서 선택해 주세요.`);
    for (let page = start; page <= end; page++) pages.add(page);
  }
  if (!pages.size || pages.size > 200) throw new DocumentImportError("PDF는 최대 200페이지를 선택할 수 있습니다.");
  return [...pages].sort((a, b) => a - b);
}

async function extractSelectedPdf(data: Buffer, range: string): Promise<string> {
  if (!data.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new DocumentImportError("올바른 PDF 파일을 선택해 주세요.");
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false });
  try {
    const total = (await parser.getInfo()).total;
    const pages = selectedPages(range, total);
    const result = await parser.getText({ partial: pages, pageJoiner: "" });
    if (!result.pages.some((page) => page.text.trim()))
      throw new DocumentImportError("선택한 PDF 페이지에서 글자를 찾지 못했습니다. OCR 후 등록해 주세요.");
    return result.pages.map((page) => `[PDF ${page.num}페이지]\n\n${page.text.replace(/\n/g, "\n\n")}`).join("\n\n");
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError("PDF 페이지를 읽지 못했습니다. 파일과 페이지 범위를 확인해 주세요.");
  } finally { await parser.destroy(); }
}

function localRead(request: Request) {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("KNOWLEDGE_ACCESS");
}

function failure(error: unknown) {
  if (error instanceof DocumentImportError) return Response.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof z.ZodError) return Response.json({ error: "자료의 제목·출처·본문 입력을 확인해 주세요." }, { status: 400, headers });
  if (error instanceof Error && error.message === "KNOWLEDGE_DUPLICATE")
    return Response.json({ error: "같은 내용의 활성 자료가 이미 등록되어 있습니다." }, { status: 409, headers });
  if (error instanceof Error && error.message === "KNOWLEDGE_SIZE")
    return Response.json({ error: "자료가 너무 커서 색인할 수 없습니다." }, { status: 413, headers });
  if (error instanceof GenerationError || error instanceof Error && error.message === "KNOWLEDGE_ACCESS")
    return Response.json({ error: "이 PC의 에듀플로우 화면에서 요청해 주세요." }, { status: 403, headers });
  return Response.json({ error: "지식베이스를 처리하지 못했습니다." }, { status: 500, headers });
}

function withBase<T>(operation: (base: KnowledgeBase) => T, directory?: string): T {
  const base = new KnowledgeBase(directory);
  try { return operation(base); } finally { base.close(); }
}

export async function listKnowledge(request: Request, directory?: string) {
  try {
    localRead(request);
    return Response.json({ documents: withBase((base) => base.list(), directory) }, { headers });
  } catch (error) { return failure(error); }
}

export async function addKnowledge(request: Request, directory?: string) {
  try {
    assertLocalAIRequest(request);
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) throw new DocumentImportError("자료를 다시 선택해 주세요.");
    const form = await request.formData();
    const file = form.get("file");
    let text = String(form.get("text") ?? "");
    if (file instanceof File && file.size) {
      if (file.size > 50 * 1024 * 1024) throw new DocumentImportError("파일은 50MB 이하로 올려 주세요.", 413);
      if (!/\.(pdf|docx|txt)$/i.test(file.name)) throw new DocumentImportError("지식베이스에는 PDF, DOCX, TXT 파일을 올릴 수 있습니다.");
      const bytes = Buffer.from(await file.arrayBuffer());
      const pdfPages = String(form.get("pdfPages") ?? "").trim();
      if (pdfPages && !/\.pdf$/i.test(file.name)) throw new DocumentImportError("페이지 범위는 PDF 파일에만 지정할 수 있습니다.");
      text = pdfPages ? await extractSelectedPdf(bytes, pdfPages) : (await extractDocument(file.name, bytes)).text;
    }
    const source = knowledgeSourceSchema.parse({
      title: String(form.get("title") ?? ""), origin: String(form.get("origin") ?? ""),
      ...(String(form.get("url") ?? "").trim() ? { url: String(form.get("url")).trim() } : {}),
      published: String(form.get("published") ?? ""), revision: String(form.get("revision") ?? ""), text,
    });
    return Response.json({ document: withBase((base) => base.add(source), directory) }, { status: 201, headers });
  } catch (error) { return failure(error); }
}

export async function updateKnowledge(request: Request, directory?: string) {
  try {
    assertLocalAIRequest(request);
    const update = updateSchema.parse(await request.json());
    const changed = withBase((base) => base.setActive(update.id, update.active), directory);
    if (!changed) return Response.json({ error: "해당 자료를 찾지 못했습니다." }, { status: 404, headers });
    return Response.json({ ok: true }, { headers });
  } catch (error) { return failure(error); }
}

export async function searchKnowledgeRequest(request: Request, directory?: string) {
  try {
    assertLocalAIRequest(request);
    const { query } = searchSchema.parse(await request.json());
    return Response.json({ references: withBase((base) => base.search(query), directory) }, { headers });
  } catch (error) { return failure(error); }
}
