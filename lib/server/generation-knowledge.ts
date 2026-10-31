import "server-only";
import { GenerationError, type GenerationInput } from "../generation-contract";
import type { KnowledgeSearchStatus, RetrievedReference } from "../knowledge";
import { manuscriptSource } from "../storyboard";
import type { PdfAttachment } from "./pdf-input";
import { indexPdfSource } from "./pdf-source-index";
import { searchKnowledge } from "./knowledge-base";
import { citedPdfPage } from "../pdf-source";

export type KnowledgeSearchContext = { pdf?: PdfAttachment; signal: AbortSignal };
export type KnowledgeRetriever = (input: GenerationInput, context: KnowledgeSearchContext) => RetrievedReference[] | Promise<RetrievedReference[]>;

/** RAG is optional enrichment; cancellation still stops the entire request. */
export async function retrieveGenerationKnowledge(input: GenerationInput, context: KnowledgeSearchContext,
  retrieve?: KnowledgeRetriever, timeoutMs = 10000,
): Promise<{ references: RetrievedReference[]; status: KnowledgeSearchStatus }> {
  if (context.signal.aborted) throw new GenerationError("CANCELLED");
  if (!retrieve) return { references: [], status: "not_used" };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  context.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  let onAbort: () => void = () => {};
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("KNOWLEDGE_SEARCH_ABORTED"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const references = await Promise.race([
      Promise.resolve().then(() => { controller.signal.throwIfAborted(); return retrieve(input, { ...context, signal: controller.signal }); }),
      aborted,
    ]);
    if (context.signal.aborted) throw new GenerationError("CANCELLED");
    return { references, status: references.length ? "retrieved" : "no_match" };
  } catch {
    if (context.signal.aborted) throw new GenerationError("CANCELLED");
    return { references: [], status: "unavailable" };
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** Search only the attached selection. Text is a retrieval query, never a replacement for the source PDF. */
export async function generationKnowledgeQuery(input: GenerationInput, context: KnowledgeSearchContext) {
  context.signal.throwIfAborted();
  let pageTexts: string[] = [];
  if (input.pdfSource && context.pdf) {
    try {
      const index = await indexPdfSource(context.pdf.data, input.pdfSource.pages, context.signal);
      const citedPage = input.sceneSourceScope === "citation" ? citedPdfPage(input.pdfSource, input.scene) : null;
      pageTexts = index.pages.filter(page => !citedPage || page.page === Number(citedPage))
        .map(page => page.text.trim()).filter(Boolean);
    } catch {
      context.signal.throwIfAborted();
      // Scanned or unreadable PDFs can still be searched by the supplied topic and filename.
    }
  }
  const perPage = Math.max(1, Math.floor(20000 / Math.max(1, pageTexts.length)));
  const topic = input.sourceRequest?.trim() || input.settings.keywords.join(" ") ||
    (!input.pdfSource && input.manuscript.trim() ? manuscriptSource(input.manuscript).title : "");
  return {
    query: [input.manuscript, input.sourceRequest ?? "", ...input.settings.keywords,
      ...(input.scene ? [input.scene.title, input.scene.purpose, input.scene.visual, input.scene.assets, input.scene.narration] : []),
      ...(pageTexts.length ? pageTexts.map(text => text.slice(0, perPage)) : [input.pdfSource?.name ?? ""])]
      .join(" ").normalize("NFC"),
    topic: topic.normalize("NFC"),
  };
}

export async function searchGenerationKnowledge(input: GenerationInput, context: KnowledgeSearchContext) {
  const { query, topic } = await generationKnowledgeQuery(input, context);
  context.signal.throwIfAborted();
  return searchKnowledge(query, topic);
}
