import { z } from "zod";
import { boundsSchema, knowledgeTableSchema, knowledgeVisionWireSchema, makeKnowledgeStructure } from "./knowledge-structure";
import type { KnowledgeMetadata } from "./knowledge";

export const validationCandidateSchema = z.object({
  text: z.string().max(20000),
  tables: knowledgeVisionWireSchema.shape.tables,
  figures: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), title: z.string().min(1).max(160), bounds: boundsSchema,
    links: z.array(z.object({ quote: z.string().min(3).max(700), reason: z.string().min(3).max(500) })).max(10),
  })).max(15),
  uncertainties: z.array(z.string().min(1).max(500)).max(50),
});
export const validationVerdictSchema = z.object({
  textMatches: z.boolean(), numbersAndUnitsMatch: z.boolean(), tableCellsMatch: z.boolean(),
  figuresAndLinksMatch: z.boolean(), readingOrderMatches: z.boolean(), coverageComplete: z.boolean(),
  issues: z.array(z.string().min(1).max(500)).max(50),
});
export type ValidationCandidate = z.infer<typeof validationCandidateSchema>;
export type ValidationVerdict = z.infer<typeof validationVerdictSchema>;
export type ValidationPage = {
  page: number; status: "pending" | "held" | "passed" | "processed" | "skipped";
  attempts: { at: string; parserCommit?: string; initial?: string; parsed?: string;
    candidate?: ValidationCandidate; verdict?: ValidationVerdict; reasons: string[]; imageHash?: string; model?: string;
    policy?: "single-pass"; errorCode?: string; phase?: "render" | "parse" | "correct" | "verify"; calls?: number }[];
};
export type ValidationRun = {
  id: string; createdAt: string; metadata: KnowledgeMetadata; sha256: string; pages: ValidationPage[];
  status: "staged" | "published"; localDocumentId?: string; remoteDocumentId?: string;
  remoteChunks?: { id: string; page: number; text: string; blockIds: string[]; structureHash: string }[];
  backendIdentity?: string;
  testOnly?: boolean;
  quarantine?: { at: string; reasons: string[] };
  sourceDocumentId?: string;
  sourceFingerprint?: string;
  filePages?: Record<number, number>;
};

export type ValidationJob = { runId: string; state: "queued" | "processing" | "waiting" | "paused" | "complete" | "blocked";
  updatedAt: string; nextAt: number; reason: string };
export function validationCounts(run: ValidationRun) {
  const counts = { passed: 0, pending: 0, waiting: 0, retrying: 0, exceptions: 0 };
  for (const page of run.pages) {
    if (run.quarantine) { counts.exceptions++; continue; }
    if (page.status === "passed" || page.status === "processed") { counts.passed++; continue; }
    if (page.status === "skipped") { counts.exceptions++; continue; }
    if (page.status === "pending") { counts.pending++; continue; }
    if (page.attempts.at(-1)?.errorCode) { counts.waiting++; continue; }
    const tries = page.attempts.filter(attempt => !attempt.errorCode).length;
    if (tries < 2) counts.retrying++; else counts.exceptions++;
  }
  return counts;
}

/** A confidence score is deliberately absent: these are model checks, not measured accuracy. */
export function candidateProblems(candidate: ValidationCandidate, verdict?: ValidationVerdict): string[] {
  const reasons = [...candidate.uncertainties];
  if (!candidate.text.trim() && !candidate.tables.length) reasons.push("검색할 본문이나 표가 없습니다.");
  if (new Set(candidate.tables.map(t => t.id)).size !== candidate.tables.length) reasons.push("표 ID가 중복됩니다.");
  if (new Set(candidate.figures.map(f => f.id)).size !== candidate.figures.length) reasons.push("그림 ID가 중복됩니다.");
  for (const table of candidate.tables) {
    if (!knowledgeTableSchema.safeParse(table).success) { reasons.push("표 셀이 겹치거나 누락됐습니다."); continue; }
    // A boundary crossed by a merged cell in every row is an invented grid line.
    // Preserve real mixed merges; require a visible boundary somewhere in the grid.
    for (let column = 2; column <= table.cols; column++) {
      if (!table.cells.some(cell => cell.col === column)) { reasons.push("표에 실제 셀 경계가 없는 중복 열이 있습니다."); break; }
    }
    const compact = (value: string) => value.replace(/\s+/g, "").normalize("NFC");
    const body = compact(candidate.text);
    const duplicated = table.cells.filter(cell => compact(cell.text).length >= 20 && body.includes(compact(cell.text)));
    if (duplicated.length >= 2) reasons.push("여러 표 셀의 내용이 본문에도 중복 저장되어 있습니다.");
  }
  const structure = makeKnowledgeStructure(1, 1, candidate.text, false, candidate.tables);
  const normalize = (text: string) => text.replace(/\s+/g, "").normalize("NFC");
  for (const figure of candidate.figures) for (const link of figure.links) {
    const matching = structure.blocks.filter(block => normalize(block.text).includes(normalize(link.quote)));
    if (matching.length !== 1) reasons.push("그림의 연결 문장을 한 곳으로 특정할 수 없습니다.");
  }
  if (!verdict) reasons.push("원본 재대조가 완료되지 않았습니다.");
  else {
    const labels = { textMatches: "본문", numbersAndUnitsMatch: "숫자·단위", tableCellsMatch: "표 셀",
      figuresAndLinksMatch: "그림·연결", readingOrderMatches: "읽기 순서", coverageComplete: "내용 누락" } as const;
    for (const [key, label] of Object.entries(labels)) if (!verdict[key as keyof typeof labels]) reasons.push(`${label} 대조를 통과하지 못했습니다.`);
    reasons.push(...verdict.issues);
  }
  return [...new Set(reasons)];
}

/** Extraction is not verification. Keep historical verified records distinct. */
export function isProcessedPage(page: ValidationPage) {
  return page.status === "passed" || page.status === "processed";
}

export function processedStructure(page: ValidationPage, filePage: number) {
  if (page.status === "passed") return validatedStructure(page, filePage);
  const attempt = page.attempts.at(-1);
  if (page.status !== "processed" || attempt?.policy !== "single-pass" || !attempt.candidate || attempt.errorCode)
    throw new Error("판독이 완료되지 않은 페이지입니다.");
  const candidate = validationCandidateSchema.parse(attempt.candidate);
  // Malformed table geometry is not usable structured data; retain its source image instead.
  const tables = candidate.tables.filter(table => knowledgeTableSchema.safeParse(table).success);
  const structure = makeKnowledgeStructure(page.page, filePage, candidate.text, true, tables);
  structure.analyzed = true;
  structure.model = attempt.model;
  structure.figures = candidate.figures.map(({ links: _links, ...figure }, index) => ({ ...figure, id: `p${page.page}-figure-${index}` }));
  // A single model extraction must never create a "verified" semantic link.
  structure.links = [];
  return structure;
}

export function validatedStructure(page: ValidationPage, filePage: number) {
  const attempt = page.attempts.at(-1);
  if (page.status !== "passed" || !attempt?.candidate || candidateProblems(attempt.candidate, attempt.verdict).length)
    throw new Error("검사를 통과하지 않은 페이지입니다.");
  const candidate = attempt.candidate;
  const structure = makeKnowledgeStructure(page.page, filePage, candidate.text, true, candidate.tables);
  structure.analyzed = true;
  structure.model = attempt.model;
  structure.figures = candidate.figures.map(({ links: _links, ...figure }) => ({ ...figure,
    id: `${figure.id}-${figure.bounds.map(n => Math.round(n * 100000)).join("-")}` }));
  const normalize = (text: string) => text.replace(/\s+/g, "").normalize("NFC");
  structure.links = candidate.figures.flatMap((figure, i) => figure.links.map((link, j) => ({
    ...link, id: `${structure.figures[i].id}-${j}`, figureId: structure.figures[i].id,
    blockId: structure.blocks.find(block => normalize(block.text).includes(normalize(link.quote)))!.id,
    status: "verified" as const, relationship: "illustrates" as const,
    // Compatibility value only; it is never used as a gate or displayed as accuracy.
    confidence: 1, model: attempt.model ?? "source-check-v1",
  })));
  return structure;
}
