import { z } from "zod";

export const knowledgeMetadataSchema = z.object({
  title: z.string().trim().min(2).max(160),
  origin: z.enum(["official", "internal"]),
  url: z.url().max(500).refine((url) => /^https?:\/\//i.test(url)).optional(),
  published: z.string().trim().max(100).default(""),
  revision: z.string().trim().max(100).default(""),
}).refine((source) => source.origin !== "official" || Boolean(source.url), {
  message: "공식 자료에는 원본 출처 주소가 필요합니다.", path: ["url"],
});
export const knowledgeSourceSchema = knowledgeMetadataSchema.safeExtend({
  text: z.string().trim().min(30).max(200000),
});
export type KnowledgeMetadata = z.infer<typeof knowledgeMetadataSchema>;
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export type KnowledgeDocument = Omit<KnowledgeSource, "text"> & {
  id: string;
  createdAt: string;
  active: boolean;
  chunks: number;
  sha256: string;
  pendingPages?: number;
};

export type KnowledgeImportPage = {
  page: number;
  text: string;
  method: "text" | "ocr" | "unreadable";
  confidence: number | null;
  reviewReason: string;
  needsReview: boolean;
};

export type KnowledgeReviewPage = Omit<KnowledgeImportPage, "needsReview"> & {
  status: "pending" | "approved" | "auto_indexed" | "excluded";
  filePage: number;
};

export type RetrievedReference = {
  id: string;
  documentId: string;
  title: string;
  url: string;
  excerpt: string;
  published: string;
  revision: string;
  origin: "official" | "internal";
  page?: number;
};

export type KnowledgeChunk = { ordinal: number; page?: number; text: string };

// Keep PDF pages separate so a retrieved passage retains its original page number.
export function chunkKnowledge(text: string, maxChars = 900): KnowledgeChunk[] {
  const pages = [...text.matchAll(/^\[PDF (\d+)페이지\]\s*$/gm)];
  const sections = pages.length
    ? pages.map((match, index) => ({ page: Number(match[1]), text: text.slice(match.index! + match[0].length, pages[index + 1]?.index ?? text.length) }))
    : [{ page: undefined, text }];
  const result: KnowledgeChunk[] = [];
  for (const section of sections) {
    const paragraphs = section.text.split(/\n\s*\n/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
    let current = "";
    const emit = () => {
      if (current) result.push({ ordinal: result.length + 1, ...(section.page ? { page: section.page } : {}), text: current });
      current = "";
    };
    for (const paragraph of paragraphs) {
      for (let start = 0; start < paragraph.length; start += maxChars) {
        const piece = paragraph.slice(start, start + maxChars);
        if (current && current.length + piece.length + 1 > maxChars) emit();
        current += `${current ? "\n" : ""}${piece}`;
      }
    }
    emit();
  }
  return result;
}

const common = new Set(["작업", "안전", "교육", "내용", "설명", "영상", "확인", "합니다", "있습니다", "그리고", "위해서", "대한", "통해서"]);
export function searchNeedles(query: string): string[] {
  const tokens = query.toLocaleLowerCase("ko-KR").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const grams = new Map<string, number>();
  for (const token of tokens) {
    if (common.has(token)) continue;
    for (let i = 0; i <= token.length - 3; i++) {
      const gram = token.slice(i, i + 3);
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
  }
  return [...grams].sort((a, b) => b[1] - a[1]).slice(0, 32).map(([gram]) => gram);
}
