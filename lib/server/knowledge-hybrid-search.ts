import "server-only";
import type { RetrievedReference } from "../knowledge";
import { recommendationsForBlocks, tableRecommendationsForBlocks } from "../knowledge-structure";
import { KnowledgeBase } from "./knowledge-base";
import { ValidationStore, contentHash, validationDirectory } from "./knowledge-validation-store";
import { knowledgeIndex } from "./knowledge-backend";
import type { SearchIndex } from "./knowledge-local-index";
import { processedStructure, isProcessedPage } from "../knowledge-validation";
import { withKnowledgeContext } from "./knowledge-context";

export async function searchHybridKnowledge(query: string, topic = "", directory = validationDirectory(),
  signal = AbortSignal.timeout(10000), client?: SearchIndex, candidateLimit = 6): Promise<RetrievedReference[]> {
  const limit = Math.max(1, Math.min(30, Math.floor(candidateLimit) || 6));
  const base = new KnowledgeBase(directory); const store = new ValidationStore(directory);
  try {
    let runs = store.list();
    let documents = base.list();
    let unpublished = new Set(runs.filter(run => run.status !== "published").map(run => run.localDocumentId));
    const structures = new Map<string, ReturnType<KnowledgeBase["structures"]>>();
    const documentStructures = (id: string) => {
      if (!structures.has(id)) structures.set(id, base.structures(id));
      return structures.get(id)!;
    };
    const refresh = () => {
      runs = store.list(); documents = base.list(); structures.clear();
      unpublished = new Set(runs.filter(run => run.status !== "published").map(run => run.localDocumentId));
    };
    const permitted = (ref: RetrievedReference) => {
      // Existing originals enrolled for replacement cannot bypass the new checks through the legacy index.
      if (runs.some(run => run.sourceDocumentId === ref.documentId)) return false;
      if (unpublished.has(ref.documentId) || !documents.some(doc => doc.id === ref.documentId && doc.active)) return false;
      const managed = runs.find(run => run.localDocumentId === ref.documentId);
      if (!managed) return true;
      if (managed.testOnly || managed.quarantine) return false;
      const page = managed.pages.find(page => page.page === ref.page && isProcessedPage(page));
      if (!page) return false;
      try { processedStructure(page, 1); } catch { return false; }
      const structure = documentStructures(ref.documentId).find(page => page.page === ref.page);
      return !!structure && !!managed.remoteChunks?.some(chunk => chunk.page === ref.page && chunk.structureHash === contentHash(JSON.stringify(structure)));
    };
    const local = base.search(query, limit, topic).filter(permitted).map(ref => withKnowledgeContext(ref,
      documentStructures(ref.documentId).find(page => page.page === ref.page)));
    if (!runs.some(run => !run.testOnly && run.status === "published" && run.localDocumentId)) return local;
    client ??= knowledgeIndex(directory);
    const eligible = runs.filter(run => !run.testOnly && !run.quarantine && run.status === "published" && run.backendIdentity === client!.identity &&
      run.remoteDocumentId && documents.some(doc => doc.id === run.localDocumentId && doc.active));
    if (!eligible.length) return local;
    // A vector service failure does not make already-verified keyword evidence disappear.
    let remote: Awaited<ReturnType<SearchIndex["retrieve"]>>;
    try { remote = await client.retrieve(query, eligible.map(run => run.remoteDocumentId!), signal); }
    catch { signal.throwIfAborted(); refresh(); return local.filter(permitted); }
    refresh(); // Recheck edits, deletion and deactivation after asynchronous retrieval.
    const references: RetrievedReference[] = [];
    for (const chunk of remote) {
      const run = eligible.find(run => run.remoteDocumentId === chunk.document_id);
      const saved = run?.remoteChunks?.find(saved => saved.id === chunk.id && saved.text === chunk.content);
      if (!run || !saved) continue;
      // Re-read after the network request: delete, deactivate and edits must take effect immediately.
      const doc = documents.find(doc => doc.id === run.localDocumentId && doc.active);
      if (!doc) continue;
      const structure = documentStructures(doc.id).find(page => page.page === saved.page);
      if (!structure || contentHash(JSON.stringify(structure)) !== saved.structureHash) continue;
      references.push(withKnowledgeContext({ id: `${doc.id}:ragflow:${saved.id}`, documentId: doc.id, title: doc.title,
        origin: doc.origin, url: doc.url ?? "", published: doc.published, revision: doc.revision,
        excerpt: saved.text, page: saved.page, blockIds: saved.blockIds,
        visuals: [...recommendationsForBlocks(doc.id, structure, saved.blockIds), ...tableRecommendationsForBlocks(doc.id, structure, saved.blockIds)] }, structure));
    }
    const fused = new Map<string, { ref: RetrievedReference; score: number }>();
    for (const ranked of [references, local]) ranked.forEach((ref, rank) => {
      // A text hit must not swallow a picture/table with the same source caption.
      const key = `${ref.documentId}:${ref.page}:${ref.excerpt}:${(ref.visuals ?? []).map(visual => visual.id).sort().join(",")}`;
      const entry = fused.get(key) ?? { ref, score: 0 };
      entry.score += 1 / (60 + rank + 1); fused.set(key, entry);
    });
    return [...fused.values()].sort((a, b) => b.score - a.score).map(item => item.ref).filter(permitted).slice(0, limit);
  } finally { store.close(); base.close(); }
}
