import type { Scene } from "./storyboard";
import type { RetrievedReference } from "./knowledge";
import { assessCandidate } from "./grounding";
import { visualRelevance, visualSearchTerms } from "./knowledge-visual-search";

/** Visual usefulness has its own ranking; narrative similarity cannot consume its slots. */
export function rankSceneVisuals(scene: Pick<Scene, "title" | "visual" | "assets" | "evidence" | "narration">,
  references: RetrievedReference[], limit = 2) {
  const text = [scene.visual, scene.assets, scene.title].join("\n");
  const terms = visualSearchTerms(text);
  const context = [scene.title, scene.evidence, scene.narration].join("\n");
  const seen = new Set<string>();
  const candidates = references.flatMap(reference => (reference.visuals ?? []).flatMap(visual => {
    const scope = assessCandidate(text, { ...reference, excerpt: visual.quote }, context);
    if (!scope.situation || !scope.conditions) return [];
    const score = visualRelevance(visual, { blocks: [{ id: visual.blockId, text: visual.quote }] }, terms);
    return score ? [{ reference, visual, score }] : [];
  })).sort((a, b) => b.score - a.score || a.visual.id.localeCompare(b.visual.id)).filter(item => {
    const key = `${item.visual.documentId}:${item.visual.page}:${item.visual.kind ?? "figure"}:${item.visual.figureId}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const firstFigure = candidates.find(item => item.visual.kind !== "table");
  const firstTable = candidates.find(item => item.visual.kind === "table");
  const preferred = limit > 1 ? [firstFigure, firstTable].filter(item => item !== undefined) : [];
  return [...preferred, ...candidates.filter(item => !preferred.includes(item))].slice(0, limit);
}
