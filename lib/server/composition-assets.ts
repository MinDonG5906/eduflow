import "server-only";
import { loadCompositionAssets } from "../composition-assets";
import type { Scene } from "../storyboard";
import { createKnowledgeStructureHandlers } from "./knowledge-structure-handler";

// Reuse the local, exclusion-aware crop reader. No HTTP or paid AI request.
export function createCompositionAssetLoader(directory?: string) {
  const handler = createKnowledgeStructureHandlers({ directory });
  const cache = new Map<string, Promise<Response>>();
  return async (scene: Scene) => (await loadCompositionAssets(scene, { fetch: async (input, init) => {
    const url = new URL(String(input), "http://127.0.0.1:3000");
    if (!cache.has(url.href)) cache.set(url.href, handler.figure(new Request(url, { signal: init?.signal })));
    return (await cache.get(url.href)!).clone();
  } })).assets;
}
