import "server-only";
import { z } from "zod";
import { PDFDocument } from "pdf-lib";
import { knowledgeMetadataSchema } from "../knowledge";
import { parsePdfPages } from "../pdf-source";
import { assertLocalAIRequest } from "./ai-config";
import { ValidationStore, validationDirectory, contentHash } from "./knowledge-validation-store";
import { publishValidation, validationSummary } from "./knowledge-validation-service";
import { knowledgePageImage, knowledgeVisionConfig } from "./knowledge-vision";
import { RAGFlowClient, serviceConfig } from "./knowledge-services";
import { knowledgeMode } from "./knowledge-backend";
import { localModelReady } from "./knowledge-local-index";
import { enqueueExisting, ensureValidationWorker } from "./knowledge-validation-queue";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function errorResponse(error: unknown) {
  return Response.json({ error: error instanceof z.ZodError ? "입력한 제목·출처·페이지를 확인해 주세요." :
    error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "처리 요청을 처리하지 못했습니다. 연결과 입력을 확인해 주세요." }, { status: 400, headers });
}
function settings(directory: string) {
  let parser = false, retrieval = false, model = false, perPageCeiling = 0;
  const mode = knowledgeMode();
  if (mode === "local") { parser = true; retrieval = localModelReady(directory); }
  else {
    try { serviceConfig("PARSEFIXER"); parser = true; } catch { /* Not configured. */ }
    try { RAGFlowClient.fromEnv(); retrieval = true; } catch { /* Not configured. */ }
  }
  try { const config = knowledgeVisionConfig(directory); model = true; perPageCeiling = config.attemptCost / 1_000_000; } catch { /* Not configured. */ }
  return { parser, retrieval, model, perPageCeiling, mode };
}
export async function readValidation(request: Request, directory = validationDirectory()) {
  let store: ValidationStore | undefined;
  try {
    const url = new URL(request.url);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return Response.json({ error: "이 PC에서 열어 주세요." }, { status: 403, headers });
    store = new ValidationStore(directory);
    const id = url.searchParams.get("id");
    if (id) {
      z.string().uuid().parse(id);
      const run = store.get(id);
      if (!run) return Response.json({ error: "처리 자료를 찾지 못했습니다." }, { status: 404, headers });
      if (url.searchParams.has("page")) {
        const page = z.coerce.number().int().positive().parse(url.searchParams.get("page"));
        if (!run.pages.some(item => item.page === page)) throw new Error("선택한 페이지가 아닙니다.");
        const image = await knowledgePageImage(store.pdf(id), run.filePages?.[page] ?? page, request.signal);
        return new Response(new Uint8Array(image), { headers: { ...headers, "Content-Type": "image/png" } });
      }
      if (url.searchParams.get("file") === "1") return new Response(new Uint8Array(store.pdf(id)), {
        headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=source.pdf" },
      });
      return Response.json({ run }, { headers: { ...headers,
        ...(url.searchParams.get("download") === "1" ? { "Content-Disposition": `attachment; filename=validation-${id}.json` } : {}) } });
    }
    return Response.json({ runs: store.list().map(validationSummary), jobs: store.jobs(), workerAlive: store.workerAlive(), settings: settings(directory) }, { headers });
  } catch (error) { return errorResponse(error); } finally { store?.close(); }
}
export async function writeValidation(request: Request, directory = validationDirectory()) {
  try {
    assertLocalAIRequest(request);
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await request.formData(); const file = form.get("file");
      if (!(file instanceof File) || !/\.pdf$/i.test(file.name) || !file.size || file.size > 50 * 1024 * 1024)
        throw new Error("50MB 이하 PDF 파일을 선택해 주세요.");
      const url = String(form.get("url") ?? "").trim();
      const metadata = knowledgeMetadataSchema.parse({ title: form.get("title") || file.name.replace(/\.pdf$/i, "").slice(0, 160), origin: url ? "official" : "internal", ...(url ? { url } : {}),
        published: String(form.get("published") ?? ""), revision: String(form.get("revision") ?? "") });
      const pdf = Buffer.from(await file.arrayBuffer());
      const document = await PDFDocument.load(pdf, { updateMetadata: false });
      const total = document.getPageCount();
      const selected = parsePdfPages(String(form.get("pages") ?? ""), total);
      const pages = selected.length ? selected : Array.from({ length: total }, (_, i) => i + 1);
      if (total > 200 || pages.length > 200) throw new Error("현재 시험 단계에서는 200페이지 이하 문서를 사용해 주세요.");
      const store = new ValidationStore(directory);
      try {
        const previous = store.list().find(run => !run.testOnly && !run.sourceDocumentId && !run.quarantine && run.sha256 === contentHash(pdf) &&
          JSON.stringify(run.metadata) === JSON.stringify(metadata) && JSON.stringify(run.pages.map(page => page.page)) === JSON.stringify(pages));
        const run = previous ?? store.create(metadata, pdf, pages);
        if (form.get("auto") === "true") { store.enqueue(run.id); ensureValidationWorker(directory); }
        return Response.json({ run: validationSummary(run) }, { status: 201, headers });
      }
      finally { store.close(); }
    }
    const input = await request.json();
    if (input.action === "enqueue-existing") {
      const { documentIds } = z.object({ documentIds: z.array(z.string().uuid()).min(1).max(50) }).parse(input);
      const results = await enqueueExisting(documentIds, directory); ensureValidationWorker(directory);
      return Response.json({ results }, { headers });
    }
    if (["queue", "pause", "resume", "wake"].includes(input.action)) {
      const body = z.object({ action: z.enum(["queue", "pause", "resume", "wake"]), ids: z.array(z.string().uuid()).max(50).default([]) }).parse(input);
      const store = new ValidationStore(directory);
      try {
        for (const id of body.ids) {
          if (body.action === "pause") {
            const job = store.job(id); if (job && job.state !== "complete") store.putJob({ ...job, state: "paused", reason: "사용자 일시 중지 · 현재 페이지 처리 후 멈춤", updatedAt: new Date().toISOString() });
          } else store.enqueue(id);
        }
      } finally { store.close(); }
      if (body.action !== "pause") ensureValidationWorker(directory);
      return Response.json({ ok: true }, { headers });
    }
    const body = z.object({ id: z.string().uuid(), action: z.enum(["check", "publish"]), page: z.number().int().positive().optional() }).parse(input);
    if (body.action === "publish") return Response.json({ run: validationSummary(await publishValidation(body.id, directory, request.signal)) }, { headers });
    return Response.json({ error: "개별 페이지 검수 기능이 제거되었습니다. 자동 처리를 사용해 주세요." }, { status: 410, headers });
  } catch (error) { return errorResponse(error); }
}
