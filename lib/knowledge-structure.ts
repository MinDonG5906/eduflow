import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
export const boundsSchema = z.array(z.number().min(0).max(1)).length(4)
  .refine(([left, top, right, bottom]) => right > left && bottom > top, "invalid bounds");
export const knowledgeCellSchema = z.object({
  row: z.number().int().min(1).max(100), col: z.number().int().min(1).max(50),
  rowSpan: z.number().int().min(1).max(100), colSpan: z.number().int().min(1).max(50),
  text: z.string().max(4000),
});
const knowledgeTableWireSchema = z.object({
  id, rows: z.number().int().min(2).max(100), cols: z.number().int().min(2).max(50),
  cells: z.array(knowledgeCellSchema).min(4).max(2000),
});
export const knowledgeTableSchema = knowledgeTableWireSchema.superRefine((table, ctx) => {
  const occupied = new Set<string>();
  for (const cell of table.cells) {
    if (cell.row + cell.rowSpan - 1 > table.rows || cell.col + cell.colSpan - 1 > table.cols) {
      ctx.addIssue({ code: "custom", message: "cell outside table" }); return;
    }
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
      const key = `${r}:${c}`;
      if (occupied.has(key)) { ctx.addIssue({ code: "custom", message: "overlapping cells" }); return; }
      occupied.add(key);
    }
  }
  if (occupied.size !== table.rows * table.cols) ctx.addIssue({ code: "custom", message: "missing cells, including empty response cells" });
});
export type KnowledgeTable = z.infer<typeof knowledgeTableSchema>;
export type KnowledgeBlock = { id: string; text: string; tableId?: string; row?: number };
export const figureLinkSchema = z.object({
  blockId: id, quote: z.string().min(3).max(900), reason: z.string().min(3).max(500),
  confidence: z.number().min(0).max(1), relationship: z.enum(["illustrates", "unrelated", "uncertain"]),
});
export const knowledgeVisionSchema = z.object({
  // AI table transcriptions are proposals until explicitly checked against the page.
  tables: z.array(knowledgeTableSchema).max(5),
  figures: z.array(z.object({ id, title: z.string().min(1).max(160), bounds: boundsSchema,
    links: z.array(figureLinkSchema).max(10) })).max(15),
});
export const knowledgeVisionWireSchema = knowledgeVisionSchema.extend({ tables: z.array(knowledgeTableWireSchema).max(5) });
export type KnowledgeVision = z.infer<typeof knowledgeVisionSchema>;
export type KnowledgeFigure = Omit<KnowledgeVision["figures"][number], "links">;
export type KnowledgeLink = z.infer<typeof figureLinkSchema> & {
  id: string; figureId: string; status: "verified" | "pending" | "rejected"; model: string;
  reviewed?: boolean;
};
export type KnowledgeStructure = {
  version: 1; page: number; filePage: number; text: string; searchable: boolean;
  tables: KnowledgeTable[]; proposedTables: KnowledgeTable[]; blocks: KnowledgeBlock[];
  figures: KnowledgeFigure[]; links: KnowledgeLink[]; analyzed: boolean; model?: string;
  figureCandidates?: KnowledgeFigure[];
  tableWarnings?: string[];
  approvedBlockIds?: string[];
  reviewedTableIds?: string[];
};

/** Re-extraction must not discard a person's cell corrections or approved quotes. */
export function preserveKnowledgeReview(next: KnowledgeStructure, previous?: KnowledgeStructure): KnowledgeStructure {
  if (!previous) return next;
  const reviewed = previous.tables.filter(table => previous.reviewedTableIds?.includes(table.id));
  const reviewedIds = new Set(reviewed.map(table => table.id));
  next.tables = [...next.tables.filter(table => !reviewedIds.has(table.id)), ...reviewed];
  next.blocks = [...next.blocks.filter(block => !block.tableId || !reviewedIds.has(block.tableId)),
    ...reviewed.flatMap(table => tableBlocks(table, next.page)),
    ...previous.blocks.filter(block => previous.approvedBlockIds?.includes(block.id))];
  next.approvedBlockIds = previous.approvedBlockIds;
  next.reviewedTableIds = previous.reviewedTableIds;
  next.figures = previous.figures;
  next.links = previous.links.filter(link => {
    const old = previous.blocks.find(block => block.id === link.blockId);
    return old && next.blocks.some(block => block.id === old.id && block.text === old.text);
  });
  next.proposedTables = previous.proposedTables;
  next.model = previous.model;
  return next;
}
export const visualRecommendationSchema = z.object({
  id: z.string().max(320), figureId: id, documentId: z.string().uuid(), blockId: id,
  title: z.string().max(160), page: z.number().int().positive(), filePage: z.number().int().positive(),
  // Old drafts omit kind and retain their original figure crop.
  kind: z.enum(["figure", "table"]).optional(),
  table: knowledgeTableSchema.optional(),
  bounds: boundsSchema.optional(), quote: z.string().max(900), reason: z.string().max(500),
  model: z.string().max(100), confidence: z.number().min(0).max(1),
}).refine(visual => visual.kind === "table" ? Boolean(visual.table && visual.table.id === visual.figureId) : Boolean(visual.bounds), "missing visual content");
export type VisualRecommendation = z.infer<typeof visualRecommendationSchema>;

/** A merged cell participates in every row it covers. Empty cells remain explicit;
 * an empty YES/NO column is never a checked answer. */
export function tableBlocks(table: KnowledgeTable, page: number): KnowledgeBlock[] {
  const firstRow = table.cells.filter(cell => cell.row === 1);
  const hasHeader = firstRow.every(cell => cell.rowSpan === 1) && firstRow.some(cell =>
    /^(?:YES|NO|예|아니오|구분|단계|점검항목|자율점검항목|점검결과|조치사항)$/i.test(cell.text.replace(/\s+/g, "")));
  return Array.from({ length: table.rows }, (_, index) => {
    const row = index + 1;
    const cells = table.cells.filter(cell => cell.row <= row && cell.row + cell.rowSpan > row).sort((a, b) => a.col - b.col);
    const text = cells.map(cell => {
      const header = table.cells.find(h => h.row === 1 && h.col <= cell.col && h.col + h.colSpan > cell.col);
      const label = hasHeader && row > 1 && header?.text.trim() && header !== cell ? `${header.text.trim()} / ` : "";
      return `${label}열 ${cell.col}${cell.colSpan > 1 ? `~${cell.col + cell.colSpan - 1}` : ""}: ${cell.text.trim() || "[빈 응답 칸: 미기입]"}${cell.rowSpan > 1 ? ` (행 ${cell.row}~${cell.row + cell.rowSpan - 1} 병합)` : ""}`;
    }).join(" | ");
    return { id: `p${page}-${table.id}-r${row}`, text: `[표 ${table.id} / 행 ${row}] ${text}`, tableId: table.id, row };
  });
}

export function makeKnowledgeStructure(page: number, filePage: number, text: string, searchable: boolean, tables: KnowledgeTable[] = []): KnowledgeStructure {
  const paragraphs = text.split(/\n\s*\n/).map(t => t.trim()).filter(Boolean);
  const blocks: KnowledgeBlock[] = paragraphs.flatMap((paragraph, i) => {
    // Keep each candidate small enough to be cited and mapped without a page-wide match.
    const pieces = paragraph.replace(/\t+/g, " ")
      .split(/(?<=[。！？.!?])\s+(?!\d)|\n(?=\s*[①-⑳❶-❿‣§○●])/u)
      .map(piece => piece.replace(/\s+/g, " ").trim()).filter(Boolean);
    return pieces.flatMap((piece, j) => {
      const result: KnowledgeBlock[] = [];
      for (let offset = 0; offset < piece.length; offset += 800)
        if (piece.slice(offset, offset + 800).trim()) result.push({ id: `p${page}-b${i}-${j}-${offset}`, text: piece.slice(offset, offset + 800).trim() });
      return result;
    });
  });
  return { version: 1, page, filePage, text, searchable, tables, proposedTables: [],
    blocks: [...blocks, ...tables.flatMap(table => tableBlocks(table, page))], figures: [], links: [], analyzed: false };
}

export function applyKnowledgeVision(structure: KnowledgeStructure, result: KnowledgeVision, model: string): KnowledgeStructure {
  if (new Set(result.tables.map(table => table.id)).size !== result.tables.length) throw new Error("KNOWLEDGE_VISION_INVALID");
  const figureIds = new Set<string>();
  const figures: KnowledgeFigure[] = [], links: KnowledgeLink[] = [];
  const normalize = (text: string) => text.replace(/\s+/gu, "").normalize("NFC");
  for (const figure of result.figures) {
    if (figureIds.has(figure.id)) throw new Error("KNOWLEDGE_VISION_INVALID");
    figureIds.add(figure.id);
    const candidate = structure.figureCandidates?.find(item => item.id === figure.id);
    if (structure.figureCandidates?.length && !candidate) continue;
    const bounds = candidate?.bounds ?? figure.bounds;
    if ((bounds[2] - bounds[0]) * (bounds[3] - bounds[1]) > 0.5) continue;
    // Include the analyzed bounds in the identity so old boards cannot silently
    // display a different crop after a later analysis.
    const figureId = `${figure.id.slice(0, 60)}-${bounds.map(n => Math.round(n * 100000)).join("-")}`;
    figures.push({ id: figureId, title: figure.title, bounds });
    const seen = new Set<string>();
    for (const link of figure.links) {
      const block = structure.blocks.find(block => block.id === link.blockId);
      if (!block || !normalize(block.text).includes(normalize(link.quote)) || seen.has(link.blockId)) continue;
      seen.add(link.blockId);
      links.push({ ...link, id: `${figureId}-${link.blockId}`, figureId, model,
        status: link.relationship === "unrelated" ? "rejected" : (structure.searchable || structure.approvedBlockIds?.includes(link.blockId)) && link.relationship === "illustrates" && link.confidence >= 0.9 ? "verified" : "pending" });
    }
  }
  for (const reviewed of structure.links.filter(link => link.reviewed)) {
    const figure = structure.figures.find(figure => figure.id === reviewed.figureId);
    if (!figure || !structure.blocks.some(block => block.id === reviewed.blockId && normalize(block.text).includes(normalize(reviewed.quote)))) continue;
    const index = links.findIndex(link => link.id === reviewed.id);
    if (index >= 0) links.splice(index, 1);
    links.push(reviewed);
    if (!figures.some(item => item.id === figure.id)) figures.push(figure);
  }
  return { ...structure, figures, links, proposedTables: structure.tables.length ? [] : result.tables,
    analyzed: true, model };
}

/** Only links whose exact source block survived retrieval can be recommended. */
export function recommendationsForBlocks(documentId: string, structure: KnowledgeStructure, blockIds: string[]): VisualRecommendation[] {
  return structure.links.filter(link => link.status === "verified" && blockIds.includes(link.blockId) &&
    (structure.searchable || structure.approvedBlockIds?.includes(link.blockId))).flatMap(link => {
    const figure = structure.figures.find(figure => figure.id === link.figureId);
    return figure ? [{ id: `${documentId}:${structure.page}:${link.id}`, documentId, figureId: figure.id, blockId: link.blockId,
      title: figure.title, page: structure.page, filePage: structure.filePage, bounds: figure.bounds,
      quote: link.quote, reason: link.reason, model: link.model, confidence: link.confidence }] : [];
  }).slice(0, 10);
}

/** Accepted tables are visual sources too. Proposed tables and unresolved symbols stay out. */
export function tableRecommendationsForBlocks(documentId: string, structure: KnowledgeStructure, blockIds: string[]): VisualRecommendation[] {
  return structure.blocks.filter(block => blockIds.includes(block.id) && block.tableId && !block.text.includes("[원본 기호 확인]"))
    .flatMap(block => {
      const table = structure.tables.find(table => table.id === block.tableId);
      if (!table || table.cells.some(cell => cell.text.includes("[원본 기호 확인]"))) return [];
      return [{ id: `${documentId}:${structure.page}:table:${table.id}:${block.id}`, kind: "table" as const,
        figureId: table.id, documentId, blockId: block.id, title: `원본 ${structure.page}페이지 표`,
        page: structure.page, filePage: structure.filePage, table,
        quote: block.text.slice(0, 900), reason: "검색된 구절이 포함된 표입니다. 셀 내용과 병합 구조를 원본과 함께 확인하세요.",
        model: "structured-table", confidence: 1 }];
    });
}

export function recommendationImageUrl(visual: VisualRecommendation) {
  return `/api/knowledge/figure?id=${encodeURIComponent(visual.documentId)}&page=${visual.page}&figure=${encodeURIComponent(visual.figureId)}`;
}

export function structureChunks(structure: KnowledgeStructure) {
  const chunks: { text: string; blockIds: string[] }[] = [];
  for (const block of structure.blocks) {
    if (!structure.searchable && !block.tableId && !structure.approvedBlockIds?.includes(block.id)) continue;
    if (block.text.includes("[원본 기호 확인]")) continue;
    for (let start = 0; start < block.text.length; start += 900) {
      const text = block.text.slice(start, start + 900);
      const previous = chunks.at(-1);
      if (previous && previous.text.length + text.length + 2 <= 900) {
        previous.text += `\n\n${text}`;
        if (!previous.blockIds.includes(block.id)) previous.blockIds.push(block.id);
      } else chunks.push({ text, blockIds: [block.id] });
    }
  }
  return chunks;
}
