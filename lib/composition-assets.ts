import type { Scene } from "./storyboard";
import { recommendationImageUrl } from "./knowledge-structure";
import { compositionStickers, type CompositionAssets } from "./scene-composition";

// Uses only the existing local figure endpoint; never sends source pixels to AI.
export async function loadCompositionAssets(scene: Scene, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  const assets: CompositionAssets = {}, missing: string[] = [];
  await Promise.all(compositionStickers(scene).filter(item => item.visual.kind !== "table").map(async item => {
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const response = await (options.fetch ?? fetch)(recommendationImageUrl(item.visual), { signal, cache: "no-store" });
      const type = response.headers.get("content-type")?.split(";")[0];
      if (!response.ok || !type || !["image/png", "image/jpeg", "image/webp"].includes(type)) throw new Error();
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error();
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      assets[item.visualId] = `data:${type};base64,${btoa(binary)}`;
    } catch { missing.push(item.visualId); }
  }));
  return { assets, missing };
}
