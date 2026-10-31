import { z } from "zod";

// Only a match, a valid citation, or an explicit user choice may open a PDF page.
// In particular, unresolved image-only citations must not default to the first page.
export function sourcePageToDisplay(pages: { page: number }[], browsed?: number | null, matched?: number | null, cited?: number | null) {
  return [browsed, matched, cited].find(page => page != null && pages.some(item => item.page === page));
}

export const sourceBoxSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
export type SourceBox = z.infer<typeof sourceBoxSchema>;
export const sourcePageSchema = z.object({
  page: z.number().int().min(1).max(200),
  text: z.string().max(100000),
  runs: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), box: sourceBoxSchema })).max(30000),
});
export const sourceIndexSchema = z.object({ pages: z.array(sourcePageSchema).min(1).max(200) });
export type SourcePage = z.infer<typeof sourcePageSchema>;
export type SourceRange = { start: number; end: number; kind?: "full" | "quote" | "fragment"; characters?: number };

function normalized(value: string) {
  let text = "";
  const starts: number[] = [], ends: number[] = [];
  const characters = value === value.normalize("NFC") ? [...value] : null;
  let cursor = 0;
  const parts = characters ? characters.map(segment => { const index = cursor; cursor += segment.length; return { segment, index }; }) : [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(value)];
  for (const { segment: character, index: offset } of parts) {
    for (const part of character.normalize("NFKC").toLowerCase()) {
      const previousDigit = /\d\s*$/.test(value.slice(Math.max(0, offset - 4), offset));
      const nextDigit = /^\s*\d/.test(value.slice(offset + character.length, offset + character.length + 4));
      if (/[\p{L}\p{N}%°±≤≥<>+=−]/u.test(part) || /[.,/]/.test(part) && previousDigit && nextDigit || /[-–—]/.test(part) && (previousDigit || nextDigit)) {
        text += part;
        // String indices are UTF-16 offsets, including supplementary characters.
        for (let i = 0; i < part.length; i++) { starts.push(offset); ends.push(offset + character.length); }
      }
    }
  }
  return { text, starts, ends };
}

/** Verbatim matching only. Ignore typography/line wrapping, never guess a paraphrase. */
export function findSourceMatches(text: string, evidence: string): SourceRange[] {
  const source = normalized(text);
  const quoted = [...evidence.matchAll(/["'“‘「『]([^"'”’」』]{4,})["'”’」』]/g)].map(match => match[1]);
  const fragments = [...quoted, evidence].flatMap(value => value.split(/[,;:，；：\n…]/)).filter(value => normalized(value).text.length >= 16);
  const needles = [
    { value: evidence, kind: "full" as const }, ...quoted.map(value => ({ value, kind: "quote" as const })),
    ...fragments.map(value => ({ value, kind: "fragment" as const })),
  ].map(candidate => ({ ...candidate, needle: normalized(candidate.value).text })).filter(candidate => candidate.needle.length >= 2)
    .sort((a, b) => b.needle.length - a.needle.length);
  for (const { needle, kind } of needles) {
    const ranges: SourceRange[] = [];
    let from = 0;
    while (ranges.length < 100) {
      const start = source.text.indexOf(needle, from);
      if (start === -1) break;
      ranges.push({ start: source.starts[start], end: source.ends[start + needle.length - 1], kind, characters: needle.length });
      from = start + needle.length;
    }
    if (ranges.length) return ranges;
  }
  return [];
}

export function sourcePassages(text: string) {
  return [...text.matchAll(/[^\n.!?。！？]+[.!?。！？]*/g)].filter(match => match[0].trim()).map((match, i) => ({
    number: i + 1, start: match.index, end: match.index + match[0].length, text: match[0],
  }));
}

export function matchBoxes(page: SourcePage, range?: SourceRange): SourceBox[] {
  const boxes: SourceBox[] = [];
  for (const run of page.runs) {
    if (!range || run.start >= range.end || run.end <= range.start) continue;
    const box = run.box, previous = boxes.at(-1);
    const overlap = previous ? Math.min(previous[3], box[3]) - Math.max(previous[1], box[1]) : 0;
    if (previous && overlap > Math.min(previous[3] - previous[1], box[3] - box[1]) * 0.7 &&
      box[0] >= previous[0] - 0.003 && box[0] - previous[2] < 0.015) {
      previous[1] = Math.min(previous[1], box[1]); previous[2] = Math.max(previous[2], box[2]); previous[3] = Math.max(previous[3], box[3]);
    } else boxes.push([...box]);
  }
  return boxes;
}

export function sourceLocationLabel(sourceId: string, filename?: string) {
  const page = /^pdf-page:([1-9]\d*)$/.exec(sourceId);
  if (page && Number(page[1]) <= 200) return `원본 ${page[1]}${/\.pptx?$/i.test(filename ?? "") ? "슬라이드" : "페이지"}`;
  const sentence = /^sentence:([1-9]\d*)-([1-9]\d*)$/.exec(sourceId);
  if (sentence && Number(sentence[1]) <= Number(sentence[2]))
    return `원고 ${sentence[1] === sentence[2] ? sentence[1] : `${sentence[1]}~${sentence[2]}`}번째 문장`;
  return "근거 위치 미지정";
}
