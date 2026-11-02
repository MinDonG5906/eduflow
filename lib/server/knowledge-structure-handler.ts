import "server-only";
import { join } from "node:path";
import { z } from "zod";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfResources } from "./pdf-resources";
import { GenerationError } from "../generation-contract";
import { knowledgeTableSchema, makeKnowledgeStructure, preserveKnowledgeReview, tableBlocks } from "../knowledge-structure";
import { assertLocalAIRequest } from "./ai-config";
import { KnowledgeBase } from "./knowledge-base";
import { analyzePdfTable } from "./pdf-layout";
import { knowledgeFigureCandidates } from "./knowledge-figures";
import { analyzeKnowledgeVision, cropKnowledgeFigure, knowledgePageImage, knowledgeVisionConfig } from "./knowledge-vision";

const headers = { "Cache-Control": "no-store" };
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), id: z.string().uuid() }),
  z.object({ action: z.literal("analyze"), id: z.string().uuid(), page: z.number().int().positive() }),
  z.object({ action: z.literal("link"), id: z.string().uuid(), page: z.number().int().positive(), linkId: z.string().max(300), approve: z.boolean() }),
  z.object({ action: z.literal("table"), id: z.string().uuid(), page: z.number().int().positive(), tableId: z.string().max(120), approve: z.boolean() }),
  z.object({ action: z.literal("cell"), id: z.string().uuid(), page: z.number().int().positive(), tableId: z.string().max(120), row: z.number().int().positive(), col: z.number().int().positive(), text: z.string().max(4000) }),
]);
let analyzing = false;
const ok = (body: unknown) => Response.json(body, { headers });
const missing = () => Response.json({ error: "등록된 원본이나 분석할 페이지를 찾지 못했습니다." }, { status: 404, headers });
const changed = () => Response.json({ error: "자료가 변경되었습니다. 다시 열어 주세요." }, { status: 409, headers });
function failure(error: unknown) {
  if (error instanceof GenerationError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
  if (error instanceof z.ZodError) return Response.json({ error: "분석할 자료와 페이지를 확인해 주세요." }, { status: 400, headers });
  if (error instanceof Error && error.message === "KNOWLEDGE_SIZE") return Response.json({ error: "표·문장 색인 한도를 넘었습니다. 등록 페이지 범위를 나눠 주세요." }, { status: 413, headers });
  return Response.json({ error: "표·그림 분석을 처리하지 못했습니다. 저장된 자료는 유지됩니다." }, { status: 500, headers });
}
function localRead(request: Request) {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new GenerationError("AI_ACCESS_DENIED");
}

export function createKnowledgeStructureHandlers(options: { directory?: string; env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}) {
  const directory = () => options.directory ?? join(process.cwd(), ".eduflow-private");
  const withBase = <T>(operation: (base: KnowledgeBase) => T): T => {
    const base = new KnowledgeBase(directory());
    try { return operation(base); } finally { base.close(); }
  };
  const snapshot = (id: string) => withBase(base => ({ pages: base.structures(id), pdf: base.pdf(id),
    excluded: base.reviewPages(id).filter(page => page.status === "excluded").map(page => page.page) }));
  return {
    async GET(request: Request) {
      try {
        localRead(request);
        const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id"));
        const source = snapshot(id);
        if (!source.pdf) return missing();
        let ai: { available: boolean; error?: string; perPageCeilingUSD?: number; reservationUSD?: number };
        try {
          const config = knowledgeVisionConfig(directory(), options.env);
          ai = { available: true, perPageCeilingUSD: config.attemptCost / 1_000_000, reservationUSD: config.reservationCost / 1_000_000 };
        } catch (error) { ai = { available: false, error: error instanceof GenerationError ? error.message : "OpenAI 연결을 확인해 주세요." }; }
        return ok({ pages: source.pages.filter(page => !source.excluded.includes(page.page)), ai });
      } catch (error) { return failure(error); }
    },
    async POST(request: Request) {
      let ownsLock = false;
      try {
        assertLocalAIRequest(request);
        const raw = await request.text();
        if (raw.length > 5000) throw new GenerationError("REQUEST_TOO_LARGE");
        const action = actionSchema.parse(JSON.parse(raw));
        if (analyzing) throw new GenerationError("RATE_LIMITED");
        analyzing = true; ownsLock = true;
        const source = snapshot(action.id);
        if (!source.pdf) return missing();
        if (action.action === "prepare") {
          const loading = getDocument({ ...pdfResources, data: new Uint8Array(source.pdf), isEvalSupported: false, verbosity: 0 });
          let updated = 0;
          try {
            const document = await loading.promise;
            for (const current of source.pages) {
              request.signal.throwIfAborted();
              if (source.excluded.includes(current.page)) continue;
              const expected = JSON.stringify(current);
              const proxy = await document.getPage(current.filePage);
              const figureCandidates = await knowledgeFigureCandidates(proxy);
              const layout = await analyzePdfTable(proxy, current.page, { tableOnly: true }).catch(() => null);
              proxy.cleanup();
              const tables = layout?.tables.map(table => knowledgeTableSchema.safeParse(table));
              const valid = tables?.length && tables.every(table => table.success);
              const next = valid ? preserveKnowledgeReview(makeKnowledgeStructure(current.page, current.filePage,
                [layout!.text, ...layout!.panels.map(panel => panel.text)].filter(Boolean).join("\n\n"), current.searchable,
                tables.map(table => table.data!)), current) : current;
              next.figureCandidates = figureCandidates;
              if (next.text === current.text && JSON.stringify(next.blocks) === JSON.stringify(current.blocks) &&
                JSON.stringify(next.tables) === JSON.stringify(current.tables)) next.analyzed = current.analyzed;
              if (!withBase(base => base.saveStructure(action.id, next, expected))) return changed();
              updated++;
            }
          } finally { await loading.destroy(); }
          return ok({ updated });
        }
        const current = source.pages.find(page => page.page === action.page);
        if (!current || source.excluded.includes(action.page)) return missing();
        const expected = JSON.stringify(current);
        if (action.action === "analyze") {
          if (current.analyzed) return ok({ cached: true });
          if (!current.figureCandidates) {
            const loading = getDocument({ ...pdfResources, data: new Uint8Array(source.pdf), isEvalSupported: false, verbosity: 0 });
            try { current.figureCandidates = await knowledgeFigureCandidates(await (await loading.promise).getPage(current.filePage)); }
            finally { await loading.destroy(); }
          }
          const config = knowledgeVisionConfig(directory(), options.env);
          const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]);
          const image = await knowledgePageImage(source.pdf, current.filePage, signal);
          const result = await analyzeKnowledgeVision(current, image, config, directory(), signal, { fetch: options.fetch });
          if (!withBase(base => base.saveStructure(action.id, result.structure, expected))) return changed();
          return ok({ cached: false, usage: result.usage });
        }
        if (action.action === "link") {
          const link = current.links.find(link => link.id === action.linkId);
          if (!link) return missing();
          if (action.approve && !current.searchable && !current.approvedBlockIds?.includes(link.blockId)) {
            const blockId = `p${current.page}-approved${(current.approvedBlockIds?.length ?? 0) + 1}`;
            current.blocks.push({ id: blockId, text: link.quote });
            (current.approvedBlockIds ??= []).push(blockId);
            link.blockId = blockId;
          }
          link.status = action.approve ? "verified" : "rejected";
          link.reviewed = true;
          if (!withBase(base => base.saveStructure(action.id, current, expected))) return changed();
          return ok({ ok: true });
        }
        if (action.action === "cell") {
          const table = current.tables.find(table => table.id === action.tableId);
          const cell = table?.cells.find(cell => cell.row === action.row && cell.col === action.col);
          if (!table || !cell) return missing();
          cell.text = action.text;
          current.reviewedTableIds = [...new Set([...(current.reviewedTableIds ?? []), table.id])];
          const oldIds = current.blocks.filter(block => block.tableId === table.id).map(block => block.id);
          current.blocks = [...current.blocks.filter(block => block.tableId !== table.id), ...tableBlocks(table, current.page)];
          current.links = current.links.filter(link => !oldIds.includes(link.blockId));
          current.analyzed = false;
          if (!withBase(base => base.saveStructure(action.id, current, expected))) return changed();
          return ok({ ok: true });
        }
        const proposal = current.proposedTables.find(table => table.id === action.tableId);
        if (!proposal) return missing();
        current.proposedTables = current.proposedTables.filter(table => table.id !== action.tableId);
        if (action.approve) {
          current.tables.push(proposal);
          current.reviewedTableIds = [...new Set([...(current.reviewedTableIds ?? []), proposal.id])];
          current.blocks.push(...tableBlocks(proposal, current.page));
          // Table approval never approves the surrounding OCR. structureChunks
          // indexes only table blocks while the page's text remains pending.
          current.analyzed = false;
        }
        if (!withBase(base => base.saveStructure(action.id, current, expected))) return changed();
        return ok({ ok: true });
      } catch (error) { return failure(error); }
      finally { if (ownsLock) analyzing = false; }
    },
    async figure(request: Request) {
      try {
        localRead(request);
        const params = new URL(request.url).searchParams;
        const id = z.string().uuid().parse(params.get("id"));
        const page = z.coerce.number().int().positive().parse(params.get("page"));
        const figureId = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/).parse(params.get("figure"));
        const source = snapshot(id);
        const structure = source.pages.find(item => item.page === page);
        const figure = structure?.figures.find(item => item.id === figureId);
        if (!source.pdf || !structure || !figure || source.excluded.includes(page)) return missing();
        const png = await cropKnowledgeFigure(await knowledgePageImage(source.pdf, structure.filePage, request.signal), figure);
        return new Response(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" } });
      } catch (error) { return failure(error); }
    },
  };
}
