import type { Scene } from "./storyboard";
import { evidenceLabel, type EvidenceLink } from "./grounding";

export function evidenceKey(link: EvidenceLink) {
  return JSON.stringify([link.referenceId, link.field, link.start, link.end, link.sentence]);
}

type EvidenceDecision = NonNullable<NonNullable<Scene["grounding"]>["decisions"]>[number];
export function decisionKey(item: EvidenceDecision) {
  return JSON.stringify([item.referenceId, item.field, item.sentence, item.quote, item.reason, item.status]);
}

export function decisionInUse(scene: Scene, item: EvidenceDecision) {
  return Boolean(item.used && item.sentence.trim() && scene[item.field].includes(item.sentence));
}

/** User selection applies text, but never upgrades the AI's evidence verdict. */
export function useEvidenceDecision(scene: Scene, key: string): Scene {
  const grounding = scene.grounding;
  const chosen = grounding?.decisions?.find(item => decisionKey(item) === key);
  if (!grounding || !chosen || !chosen.sentence.trim() || decisionInUse(scene, chosen)) return scene;
  const existing = scene[chosen.field];
  const appended = !existing.includes(chosen.sentence);
  const addition = appended ? `${existing ? "\n" : ""}${chosen.sentence}` : "";
  const next = existing + addition;
  return { ...scene,
    [chosen.field]: next,
    edited: [...new Set([...scene.edited, ...(appended ? [chosen.field] : []), "grounding"])],
    grounding: { ...grounding,
      status: appended ? "stale" : grounding.status,
      decisions: grounding.decisions!.map(item => decisionKey(item) === key ? { ...item, used: true,
        application: appended ? { start: existing.length, text: addition, value: next } : undefined,
      } : item.field === chosen.field && item.application?.value === existing
        ? { ...item, application: { ...item.application, value: next } } : item),
    },
  };
}

/** Revoke the user choice without converting it into an AI-approved link. */
export function undoEvidenceDecision(scene: Scene, key: string): Scene {
  const grounding = scene.grounding;
  const chosen = grounding?.decisions?.find(item => decisionKey(item) === key);
  if (!grounding || !chosen?.used) return scene;
  const existing = scene[chosen.field];
  const applied = chosen.application;
  const tracked = applied && applied.value === existing &&
    applied.text === `${applied.start ? "\n" : ""}${chosen.sentence}` &&
    existing.slice(applied.start, applied.start + applied.text.length) === applied.text;
  const shared = grounding.decisions!.find(item => decisionKey(item) !== key && item.used &&
    item.field === chosen.field && item.sentence === chosen.sentence);
  const remove = Boolean(tracked && !shared);
  const start = applied?.start ?? 0;
  let end = start + (applied?.text.length ?? 0);
  // If the first inserted sentence was the entire original field, also remove
  // the now-unneeded separator before the next appended sentence.
  if (remove && start === 0 && existing[end] === "\n") end++;
  const next = remove ? existing.slice(0, start) + existing.slice(end) : existing;
  const decisions = grounding.decisions!.map(item => {
    if (decisionKey(item) === key) return { ...item, used: false, application: undefined };
    if (tracked && shared === item) return { ...item, application: applied };
    const record = item.application;
    if (!remove || item.field !== chosen.field || !record || record.value !== existing) return item;
    // Adjust the other applied ranges after removing an earlier selected item.
    const last = record.start + record.text.length;
    if (record.start >= end) return { ...item, application: { ...record, start: record.start - (end-start), value: next } };
    if (last <= start) return { ...item, application: { ...record, value: next } };
    if (record.start >= start && last > end) return { ...item,
      application: { start, text: record.text.slice(end-record.start), value: next } };
    return { ...item, application: undefined };
  });
  return { ...scene, [chosen.field]: next,
    edited: [...new Set([...scene.edited, ...(remove ? [chosen.field] : []), "grounding"])],
    grounding: { ...grounding, status: remove ? "stale" : grounding.status, decisions },
  };
}

/** Apply the selected decisions in their displayed order in one board update. */
export function useEvidenceDecisions(scene: Scene, keys: string[]): Scene {
  const selected = new Set(keys);
  return (scene.grounding?.decisions ?? []).filter(item => selected.has(decisionKey(item)))
    .reduce((current, item) => useEvidenceDecision(current, decisionKey(item)), scene);
}

/** One immutable transaction: content, offsets and the review decision stay together. */
export function acceptTransferredEvidence(scene: Scene, key: string): Scene {
  const grounding = scene.grounding;
  if (!grounding || grounding.status === "stale") return scene;
  const suggestion = grounding.suggestions?.find(link => evidenceKey(link) === key);
  const linked = grounding.links.find(link => evidenceKey(link) === key);
  const chosen = suggestion ?? linked;
  if (!chosen || chosen.applicability !== "transfer" || !chosen.transfer || chosen.review === "accepted" ||
      !scene.references?.some(ref => ref.id === chosen.referenceId)) return scene;
  const draft = { ...scene };
  let accepted = { ...chosen, review: "accepted" as const };
  if (suggestion) {
    if (suggestion.field !== "narration" && suggestion.field !== "subtitle") return scene;
    if (draft[suggestion.field].includes(suggestion.sentence)) return scene;
    const start = draft[suggestion.field].length + (draft[suggestion.field] ? 1 : 0);
    if (start + suggestion.sentence.length > (suggestion.field === "narration" ? 24000 : 2000)) return scene;
    draft[suggestion.field] += `${draft[suggestion.field] ? "\n" : ""}${suggestion.sentence}`;
    accepted = { ...accepted, start, end: start + suggestion.sentence.length };
  } else if (scene[chosen.field].slice(chosen.start, chosen.end) !== chosen.sentence) return scene;
  const links = suggestion ? [...grounding.links, accepted] : grounding.links.map(link => evidenceKey(link) === key ? accepted : link);
  const suggestions = (grounding.suggestions ?? []).filter(link => evidenceKey(link) !== key);
  const pending = suggestions.length || links.some(link => link.applicability === "transfer" && link.review !== "accepted") ||
    grounding.decisions?.some(decision => decision.status === "deferred");
  return { ...draft, review: true, edited: [...new Set([...scene.edited, ...(suggestion ? [suggestion.field] : []), "grounding"])],
    grounding: { ...grounding, links, suggestions, status: pending ? "review_required" : "verified" } };
}

const fields = { narration: "나레이션", subtitle: "자막", visual: "화면 설명", assets: "시각자료 제안" };
export function evidenceReviewText(scene: Scene): string {
  if (!scene.grounding) return scene.references?.length ? "이전 연결 기록 · 적용 범위 미분류" : "";
  const grounding = scene.grounding;
  const stale = grounding.status === "stale";
  const describe = (link: EvidenceLink, proposed = false) => {
    const source = [...(scene.references ?? []), ...(scene.visualReferences ?? [])].find(ref => ref.id === link.referenceId);
    const current = !stale && (proposed || scene[link.field].slice(link.start, link.end) === link.sentence);
    return [`${fields[link.field]} · ${evidenceLabel(link, !current)}${proposed ? " · 제안 (본문 미반영)" : ""}`,
      link.sentence, `출처: ${source?.title ?? link.referenceId}${source?.page ? ` · 원본 ${source.page}페이지` : ""}`,
      `원문 구절: ${link.quote}`, link.reason,
      ...(link.transfer ? [`원래 적용 대상: ${link.transfer.sourceScope}`, `현재 교육 대상: ${link.transfer.targetScope}`,
        `참고한 원칙: ${link.transfer.principle}`, `확인할 조건: ${link.transfer.conditions}`] : [])].join("\n");
  };
  return [...grounding.links.map(link => describe(link)), ...(grounding.suggestions ?? []).map(link => describe(link, true)),
    ...(grounding.decisions ?? []).map(item => `${stale ? "이전 판정 · " : ""}${item.status === "deferred" ? "판단 보류" : "근거 연결 제외"} · ${fields[item.field]}${item.used ? `\n${decisionInUse(scene, item) ? "사용자 선택으로 사용 중" : "이전 사용자 선택 · 본문 변경됨"} · AI 근거 검증 미통과` : ""}\n${item.sentence}\n출처: ${item.sourceTitle}${item.page ? ` · 원본 ${item.page}페이지` : ""}\n${item.reason}${item.quote ? `\n원문 구절: ${item.quote}` : ""}`)].join("\n\n");
}
