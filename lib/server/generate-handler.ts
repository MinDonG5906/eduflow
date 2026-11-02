import { NextResponse } from "next/server";
import { GenerationError, generationRequestSchema } from "../generation-contract";
import { runGeneration, type GenerationAdapter } from "./generation-service";
import { protectPaidGeneration } from "./ai-protection";
import { assertLocalAIRequest } from "./ai-config";
import { readPdfGenerationRequest, type PdfAttachment } from "./pdf-input";
import { retrieveGenerationKnowledge, type KnowledgeRetriever } from "./generation-knowledge";
import type { SceneKnowledgeRetriever } from "./scene-knowledge";

export function createGenerateHandler(adapterOrFactory: GenerationAdapter | (() => GenerationAdapter), options: {
  timeoutMs?: number;
  budgetDirectory?: string;
  knowledge?: KnowledgeRetriever;
  sceneKnowledge?: SceneKnowledgeRetriever;
} = {}) {
  return async (request: Request) => {
    try {
      if (request.signal.aborted) throw new GenerationError("CANCELLED");
      let input, pdf: PdfAttachment | undefined;
      if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
        assertLocalAIRequest(request);
        const parsed = await readPdfGenerationRequest(request);
        input = parsed.input; pdf = parsed.pdf;
      } else {
        const raw = await request.text();
        if (raw.length > 150000) throw new GenerationError("REQUEST_TOO_LARGE");
        let body: unknown;
        try { body = JSON.parse(raw); } catch { throw new GenerationError("INVALID_REQUEST"); }
        const parsed = generationRequestSchema.safeParse(body);
        if (!parsed.success) throw new GenerationError("INVALID_REQUEST");
        input = parsed.data;
        if (input.pdfSource) throw new GenerationError("PDF_NOT_ATTACHED");
      }
      const adapter = typeof adapterOrFactory === "function" ? adapterOrFactory() : adapterOrFactory;
      if (pdf && adapter.mode !== "ai") throw new GenerationError("PDF_AI_REQUIRED");
      if (adapter.mode === "ai") assertLocalAIRequest(request);
      const knowledge = adapter.mode === "ai" ? await retrieveGenerationKnowledge(input, { pdf, signal: request.signal }, options.knowledge) : undefined;
      // Every paid adapter is protected automatically; selecting one cannot bypass admission.
      const protectedRun = adapter.mode === "ai"
        ? protectPaidGeneration(request, adapter, { ...(adapter.billing ? { config: adapter.billing.config } : {}), directory: options.budgetDirectory })
        : null;
      let board;
      try { board = await runGeneration(input, protectedRun?.adapter ?? adapter, { timeoutMs: options.timeoutMs,
        signal: request.signal, pdf, retrieveSceneKnowledge: options.sceneKnowledge,
        ...(knowledge ? { references: knowledge.references, knowledgeStatus: knowledge.status, knowledgeFailure: knowledge.failure } : {}) }); }
      finally { protectedRun?.finish(); }
      return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const failure = request.signal.aborted ? new GenerationError("CANCELLED") :
        error instanceof GenerationError ? error : new GenerationError("INTERNAL_ERROR");
      return NextResponse.json({ code: failure.code, error: failure.message, retryable: failure.retryable,
        ...(failure.inputUsage ? { inputUsage: failure.inputUsage } : {}),
      }, {
        status: failure.status, headers: { "Cache-Control": "no-store" },
      });
    }
  };
}
