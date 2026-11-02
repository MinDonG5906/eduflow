import type { Scene } from "./storyboard";

type Reference = NonNullable<Scene["references"]>[number];
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const preview = (value: string, limit: number) => {
  const text = compact(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/** Only name a numbered item when the actual linked quote lies inside that item. */
function numberedItem(excerpt: string, quote: string): string {
  const position = excerpt.indexOf(quote);
  if (position < 0 || excerpt.indexOf(quote, position + 1) >= 0) return "";
  const items = [...excerpt.matchAll(/(?:^|\n|[●•▪])\s*((?:사례\s*\d+|제\s*\d+\s*[장절조]|\d+[.)])[^\n●•▪]*)/gu)];
  const item = items.filter(match => match.index! + match[0].indexOf(match[1]) <= position).at(-1);
  if (!item) return "";
  const next = items[items.indexOf(item) + 1]?.index ?? excerpt.length;
  return position + quote.length <= next ? preview(item[1], 120) : "";
}

/** A compact source locator; does not invent headings, page numbers or citation matches. */
export function referenceLocation(reference: Reference, quotes: string[] = []): string {
  const exact = [...new Set(quotes.filter(quote => quote.trim() && reference.excerpt.includes(quote)))];
  const section = compact(reference.context?.sectionTitle ?? "");
  const items = [...new Set(exact.map(quote => numberedItem(reference.excerpt, quote)).filter(Boolean))];
  const lines = [`${reference.title}${reference.published ? ` (${reference.published})` : ""}`,
    `위치: ${reference.page ? `원본 ${reference.page}페이지` : "페이지 정보 없음"}${section ? ` · ${preview(section, 120)}` : ""}`,
    ...items.map(item => `항목: ${item}`)];
  if (exact.length) {
    lines.push(...exact.slice(0, 3).map(quote => `찾을 구절: “${preview(quote, 150)}”`));
    if (exact.length > 3) lines.push(`외 ${exact.length - 3}개 연결 구절은 문장별 근거에서 확인`);
  } else if (reference.excerpt.trim()) {
    lines.push(`발췌 시작: “${preview(reference.excerpt, 150)}”`);
  }
  if (reference.url) lines.push(`원문 링크: ${reference.url}`);
  return lines.join("\n");
}

export function sceneReferenceLocations(scene: Scene, references = scene.references ?? []): string {
  const links = [...(scene.grounding?.links ?? []), ...(scene.grounding?.suggestions ?? [])];
  return references.map(reference => referenceLocation(reference,
    links.filter(link => link.referenceId === reference.id).map(link => link.quote))).join("\n\n");
}
