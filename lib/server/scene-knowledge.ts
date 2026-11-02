import "server-only";
import type { Scene } from "../storyboard";
import type { KnowledgeSearchStatus, RetrievedReference } from "../knowledge";
import { rankCandidates } from "../grounding";
import { searchHybridKnowledge } from "./knowledge-hybrid-search";
import { groundingFailure } from "./grounding-failure";
import type { GroundingFailure } from "../grounding-failure";
import { rankSceneVisuals } from "../scene-visual-candidates";

export type SceneKnowledge = { references: RetrievedReference[]; visualReferences?: RetrievedReference[]; status: KnowledgeSearchStatus; retrievedCount?: number; failure?: GroundingFailure };
export type SceneKnowledgeRetriever = (scenes: Scene[], signal: AbortSignal) => Promise<SceneKnowledge[]>;

/** Search the finished scene, not the entire PDF. Each scene owns its candidates. */
export async function searchSceneKnowledge(scenes: Scene[], signal: AbortSignal,
  search = searchHybridKnowledge, timeoutMs = 10000): Promise<SceneKnowledge[]> {
  signal.throwIfAborted();
  const started = Date.now();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  const cache = new Map<string, Promise<RetrievedReference[]>>();
  const results: SceneKnowledge[] = scenes.map(() => ({ references: [], status: "unavailable" }));
  let cursor = 0;
  const worker = async () => {
    while (cursor < scenes.length && !controller.signal.aborted) {
      const index = cursor++, scene = scenes[index];
      const text = [scene.narration, scene.subtitle].join("\n");
      // The quoted source provides conditions/phase that a short caption can omit.
      const query = [scene.title, scene.visual, scene.assets, text, scene.evidence].filter(Boolean).join("\n").normalize("NFC");
      try {
        let pending = cache.get(query);
        if (!pending) {
          pending = search(query, "", undefined, controller.signal, undefined, 24);
          cache.set(query, pending);
        }
        const candidates = await pending;
        if (controller.signal.aborted) return;
        const references = rankCandidates(text, candidates, 2, [scene.title, scene.evidence].join("\n")).map(item => item.reference);
        const visualReferences = rankSceneVisuals(scene, candidates).map(item => item.reference);
        results[index] = { references, visualReferences, retrievedCount: candidates.length, status: references.length || visualReferences.length ? "retrieved" : "no_match" };
      } catch (error) {
        if (!controller.signal.aborted) results[index] = { references: [], status: "unavailable",
          failure: groundingFailure("scene_search", error, started) };
      }
    }
  };
  let aborted: (() => void) | undefined;
  try {
    const deadline = new Promise<void>(resolve => {
      aborted = () => resolve();
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    // Bounded concurrency; the local embedding runtime already serializes inference.
    await Promise.race([Promise.all([worker(), worker()]), deadline]);
    signal.throwIfAborted();
    return results.map(result => result.status === "unavailable" && !result.failure
      ? { ...result, failure: groundingFailure("scene_search", undefined, started, { timeoutMs }) } : result);
  } finally {
    clearTimeout(timer);
    if (aborted) controller.signal.removeEventListener("abort", aborted);
    signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}
