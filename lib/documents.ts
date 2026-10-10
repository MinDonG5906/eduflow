import { z } from "zod";

export const MAX_DOCUMENT_CHARS = 200000;
export const MAX_MANUSCRIPT_CHARS = 20000;
export const documentSchema = z.object({
  name: z.string().min(1).max(255),
  text: z.string().max(MAX_DOCUMENT_CHARS),
  kind: z.enum(["pdf", "text"]).optional(),
  pages: z.number().int().min(1).max(200).optional(),
  selectedPages: z.array(z.number().int().min(1).max(200)).max(200).optional(),
  fileId: z.string().uuid().optional(),
  query: z.string().max(500),
  appliedQuery: z.string().max(500).optional(),
}).refine((document) => document.kind === "pdf" ? Boolean(document.pages) : Boolean(document.text));
export type SourceDocument = z.infer<typeof documentSchema>;

export function documentTopic(request: string) {
  const quoted = request.match(/["“「『]([^"”」』]+)["”」』]/)?.[1];
  if (quoted) return quoted.trim();
  const fromDocument = request.match(/(?:파일|문서|자료|PDF|Word|DOCX|TXT)(?:에서|의)\s*(.+)/i)?.[1];
  return (fromDocument ?? request)
    .replace(/^(?:올려둔|업로드한|첨부한)\s*(?:PDF|Word|DOCX|TXT)?\s*/i, "")
    .replace(/\s*(?:부분|내용|항목)(?:만|을|으로|에|이)?[\s\S]*$/, "")
    .replace(/\s*(?:제작|만들|구성|생성|찾아|찾고)[\s\S]*$/, "")
    .trim();
}

const compact = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const pageMarker = (value: string) => /^\[PDF \d+페이지\]$/.test(value);
const heading = (value: string) => !pageMarker(value) && value.length <= 80 &&
  !value.includes("\n") && !/[.!?。！？]$/.test(value) &&
  !/(?:합니다|하세요|됩니다|입니다|있습니다|한다|된다)$/.test(value);

// Search locally before generation. Never silently truncate a document or invent a match.
export function findDocumentExcerpt(document: SourceDocument, request: string) {
  const topic = documentTopic(request);
  const needle = compact(topic);
  if (needle.length < 2) throw new Error("찾을 제목이나 핵심 단어를 두 글자 이상 입력해 주세요.");
  const blocks = document.text.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
  const exact = blocks.map((block, i) => compact(block).includes(needle) ? i : -1).filter((i) => i >= 0);
  const words = topic.split(/\s+/).map(compact).filter((word) => word.length >= 2);
  const titled = exact.filter((i) => heading(blocks[i]));
  const matches = titled.length ? titled : exact.length ? exact : blocks.map((block, i) =>
    words.length > 1 && words.every((word) => compact(block).includes(word)) ? i : -1,
  ).filter((i) => i >= 0);
  if (!matches.length) throw new Error(`“${topic}”에 해당하는 내용을 찾지 못했습니다. 문서에 있는 제목이나 단어로 다시 찾아 주세요.`);
  const selected = new Set<number>();
  for (const i of matches) {
    selected.add(i);
    if (heading(blocks[i])) {
      for (let j = i + 1; j < blocks.length && !heading(blocks[j]); j++) selected.add(j);
    } else if (i > 0 && heading(blocks[i - 1])) selected.add(i - 1);
    for (let j = i - 1; j >= 0; j--) {
      if (pageMarker(blocks[j])) { selected.add(j); break; }
    }
  }
  const text = [...selected].sort((a, b) => a - b).map((i) => blocks[i]).join("\n\n");
  const excerpt = `${topic}\n\n${text}`;
  if (excerpt.length > MAX_MANUSCRIPT_CHARS)
    throw new Error("찾은 내용이 20,000자를 넘습니다. 더 구체적인 소제목이나 단어로 범위를 좁혀 주세요.");
  return { excerpt, matches: matches.length, topic };
}
