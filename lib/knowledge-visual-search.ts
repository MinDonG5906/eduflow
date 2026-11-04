import type { KnowledgeStructure, VisualRecommendation } from "./knowledge-structure";

const common = new Set(["작업", "안전", "교육", "내용", "설명", "영상", "확인", "그림", "자료", "원본", "페이지", "합니다", "있습니다", "그리고", "위해서", "대한", "통해서", "min", "hr", "ach"]);
const normalize = (value: string) => value.normalize("NFC").toLocaleLowerCase("ko-KR");

/** Numeric units must not consume the entire query budget for figures and tables. */
export function visualSearchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of normalize(query).match(/[\p{L}]{2,}/gu) ?? []) {
    if (common.has(token)) continue;
    if (token.length === 2) terms.add(token);
    else for (let i = 0; i <= token.length - 3; i++) terms.add(token.slice(i, i + 3));
    if (terms.size >= 96) break;
  }
  return [...terms].slice(0, 96);
}

/** Context is restricted to the verified linked block or the accepted table, never the whole page. */
export function visualRelevance(visual: VisualRecommendation, structure: Pick<KnowledgeStructure, "blocks">, terms: string[]) {
  const direct = normalize(`${visual.title} ${visual.quote}`);
  const explanation = normalize(visual.kind === "table" ? "" : visual.reason);
  const context = normalize(visual.kind === "table"
    ? visual.table?.cells.map(cell => cell.text).join(" ") ?? ""
    : structure.blocks.find(block => block.id === visual.blockId)?.text ?? "");
  const matches = terms.filter(term => direct.includes(term) || explanation.includes(term) || context.includes(term));
  if (matches.length < Math.min(2, terms.length) || !matches.length) return 0;
  return matches.reduce((score, term) => score + (direct.includes(term) ? 4 : explanation.includes(term) ? 2 : 1), 0);
}
