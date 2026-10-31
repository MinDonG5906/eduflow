import { useEffect, useState } from "react";
import type { Scene } from "@/lib/storyboard";
import { compositionStickers, type CompositionAssets } from "@/lib/scene-composition";
import { loadCompositionAssets } from "@/lib/composition-assets";

export function useCompositionAssets(scene: Scene) {
  const key = JSON.stringify(compositionStickers(scene).filter(item => item.visual.kind !== "table").map(item => [item.visualId, item.visual.documentId, item.visual.page, item.visual.figureId]));
  const [state, setState] = useState<{ key: string; assets: CompositionAssets; missing: string[] }>();
  useEffect(() => {
    const controller = new AbortController();
    loadCompositionAssets(scene, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setState({ key, ...result }); });
    return () => controller.abort();
  }, [key]);
  return state?.key === key ? state : { assets: {}, missing: [], loading: true };
}
