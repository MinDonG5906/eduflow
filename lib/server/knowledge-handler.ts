import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { knowledgeMetadataSchema, knowledgeSourceSchema } from "../knowledge";
import { GenerationError } from "../generation-contract";
import { assertLocalAIRequest } from "./ai-config";
import { DocumentImportError } from "./document-import-error";
import { extractDocument } from "./document-import";
import { KnowledgeBase } from "./knowledge-base";
import { analyzeKnowledgePdf, normalizeKnowledgeFile } from "./knowledge-ingest";
import { selectPdfPages } from "../pdf-source";

const headers = { "Cache-Control": "no-store" };
const updateSchema = z.object({ id: z.string().uuid(), active: z.boolean() });
const searchSchema = z.object({ query: z.string().trim().min(3).max(20000) });
const reviewSchema = z.object({ id: z.string().uuid(), page: z.number().int().positive(),
  action: z.enum(["approve", "exclude"]), text: z.string().max(20000).optional() });
let ingesting = false;

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
  if (error instanceof Error && error.message === "KNOWLEDGE_REVIEW_TEXT")
    return Response.json({ error: "승인할 글은 10자 이상 입력해 주세요." }, { status: 400, headers });
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
    const metadata = knowledgeMetadataSchema.parse({
      title: String(form.get("title") ?? ""), origin: String(form.get("origin") ?? ""),
      ...(String(form.get("url") ?? "").trim() ? { url: String(form.get("url")).trim() } : {}),
      published: String(form.get("published") ?? ""), revision: String(form.get("revision") ?? ""),
    });
    if (file instanceof File && file.size) {
      if (file.size > 50 * 1024 * 1024) throw new DocumentImportError("파일은 50MB 이하로 올려 주세요.", 413);
      if (!/\.(pdf|docx|txt|hwp|hwpx|ppt|pptx)$/i.test(file.name))
        throw new DocumentImportError("PDF, DOCX, TXT, 한글 또는 PPT 파일을 선택해 주세요.");
      const bytes = Buffer.from(await file.arrayBuffer());
      const pdfPages = String(form.get("pdfPages") ?? "").trim();
      if (/\.txt$/i.test(file.name)) {
        if (pdfPages) throw new DocumentImportError("페이지 범위는 페이지가 있는 파일에만 지정할 수 있습니다.");
        text = (await extractDocument(file.name, bytes)).text;
      } else {
        if (ingesting) throw new DocumentImportError("다른 자료를 읽는 중입니다. 완료 후 다시 시도해 주세요.", 429);
        ingesting = true;
        try {
          const pdf = await normalizeKnowledgeFile(file.name, bytes, request.signal);
          if (pdf.length > 50 * 1024 * 1024) throw new DocumentImportError("변환된 PDF는 50MB 이하이어야 합니다.", 413);
          const { pages, total } = await analyzeKnowledgePdf(pdf, pdfPages, request.signal);
          let storedPdf = pdf;
          if (pages.length !== total || pages.some((page, index) => page.page !== index + 1)) {
            try { storedPdf = Buffer.from(await selectPdfPages(pdf, pages.map((page) => page.page))); }
            catch { throw new DocumentImportError("선택한 페이지를 보관하지 못했습니다."); }
          }
          const document = withBase((base) => base.addImported(metadata, createHash("sha256").update(bytes).digest("hex"), storedPdf, pages), directory);
          return Response.json({ document }, { status: 201, headers });
        } finally { ingesting = false; }
      }
    }
    const source = knowledgeSourceSchema.parse({ ...metadata, text });
    return Response.json({ document: withBase((base) => base.add(source), directory) }, { status: 201, headers });
  } catch (error) { return failure(error); }
}

export async function listKnowledgeReview(request: Request, directory?: string) {
  try {
    localRead(request);
    const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id"));
    return Response.json({ pages: withBase((base) => base.reviewPages(id), directory) }, { headers });
  } catch (error) { return failure(error); }
}

export async function reviewKnowledgePage(request: Request, directory?: string) {
  try {
    assertLocalAIRequest(request);
    const { id, page, action, text } = reviewSchema.parse(await request.json());
    const changed = withBase((base) => base.resolvePage(id, page, action, text), directory);
    if (!changed) return Response.json({ error: "검토 대기 중인 페이지를 찾지 못했습니다." }, { status: 404, headers });
    return Response.json({ ok: true }, { headers });
  } catch (error) { return failure(error); }
}

export async function readKnowledgePdf(request: Request, directory?: string) {
  try {
    localRead(request);
    const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id"));
    const pdf = withBase((base) => base.pdf(id), directory);
    if (!pdf) return Response.json({ error: "원본 보기를 찾지 못했습니다." }, { status: 404, headers });
    return new Response(new Uint8Array(pdf), { headers: { ...headers, "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=source.pdf", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return failure(error); }
}

export async function renderKnowledgePage(request: Request, directory?: string) {
  try {
    localRead(request);
    const params = new URL(request.url).searchParams;
    const id = z.string().uuid().parse(params.get("id"));
    const page = z.coerce.number().int().positive().max(200).parse(params.get("page"));
    const pdf = withBase((base) => base.pdf(id), directory);
    if (!pdf) return Response.json({ error: "원본 페이지를 찾지 못했습니다." }, { status: 404, headers });
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(pdf), isEvalSupported: false });
    try {
      const screenshot = await parser.getScreenshot({ partial: [page], desiredWidth: 1300, imageDataUrl: false });
      if (!screenshot.pages.length) return Response.json({ error: "원본 페이지를 찾지 못했습니다." }, { status: 404, headers });
      return new Response(new Uint8Array(screenshot.pages[0].data), { headers: { ...headers,
        "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" } });
    } finally { await parser.destroy(); }
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
