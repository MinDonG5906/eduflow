import "server-only";
import type { GeneratedScene } from "../generation-contract";
import { exactSentences } from "../grounding";
import type { Scene } from "../storyboard";
import type { RetrievedReference } from "../knowledge";

type Addition = { field: "narration" | "subtitle"; text: string; referenceId: string; start: number; end: number };

/** Proposals are private to the pipeline until the independent judge accepts them. */
export function stageSupplements(scenes: Scene[], proposals: NonNullable<GeneratedScene["supplements"]>[],
  resolve: (id: string) => RetrievedReference | undefined) {
  const additions: Addition[][] = scenes.map(() => []);
  const staged = scenes.map((scene, index) => {
    const draft = { ...scene };
    for (const proposal of proposals[index] ?? []) {
      const reference = resolve(proposal.referenceId);
      if (!reference || exactSentences(proposal.text).length !== 1 || draft[proposal.field].includes(proposal.text)) continue;
      const start = draft[proposal.field].length + 1, end = start + proposal.text.length;
      if (end > (proposal.field === "narration" ? 24000 : 2000)) continue;
      draft[proposal.field] += `\n${proposal.text}`;
      additions[index].push({ ...proposal, referenceId: reference.id, start, end });
    }
    return draft;
  });
  return { staged, additions };
}

export function commitSupplements(originals: Scene[], verified: Scene[], additions: Addition[][]): Scene[] {
  return verified.map((scene, index) => {
    const draft = { ...scene, narration: originals[index].narration, subtitle: originals[index].subtitle };
    const links = (scene.grounding?.links ?? []).filter(link =>
      !additions[index].some(a => a.field === link.field && link.start >= a.start));
    const suggestions: NonNullable<NonNullable<Scene["grounding"]>["suggestions"]> = [];
    let added = 0;
    for (const addition of additions[index]) {
      const accepted = scene.grounding?.links.filter(link => link.field === addition.field &&
        link.start === addition.start && link.end === addition.end && link.referenceId === addition.referenceId);
      if (!accepted?.length) continue;
      if (!accepted.some(link => link.applicability === "direct")) {
        suggestions.push(accepted[0]);
        continue;
      }
      const start = draft[addition.field].length + 1;
      draft[addition.field] += `\n${addition.text}`;
      links.push(...accepted.map(link => ({ ...link, start, end: start + addition.text.length })));
      added++;
    }
    const ids = new Set([...links, ...suggestions].filter(l => l.field === "narration" || l.field === "subtitle").map(l => l.referenceId));
    draft.references = scene.references?.filter(ref => ids.has(ref.id));
    const removed = additions[index].length - added - suggestions.length;
    if (removed) draft.reviewReason += " 근거를 확인하지 못한 보충 문장은 제외했습니다.";
    const needsReview = suggestions.length || links.some(link => link.applicability === "transfer" && link.review !== "accepted") ||
      scene.grounding?.decisions?.some(decision => decision.status === "deferred");
    if (needsReview) draft.review = true;
    if (scene.grounding) draft.grounding = { ...scene.grounding, links, suggestions,

      status: needsReview ? "review_required" : links.length ? "verified" : scene.grounding.status === "verified" ? "no_match" : scene.grounding.status,
      ...(scene.grounding.diagnostics ? { diagnostics: { ...scene.grounding.diagnostics,
        supplementsAdded: added, supplementsRemoved: removed } } : {}),
    };
    return draft;
  });
}
