import "server-only";
import { z } from "zod";
import { validationCandidateSchema, type ValidationCandidate } from "../knowledge-validation";
import { knowledgeTableSchema } from "../knowledge-structure";

// A matrix avoids repeating coordinate keys for every ordinary cell.
// Only merged cells need coordinates; the stored/searchable format stays unchanged.
export const sourceCandidateSchema = validationCandidateSchema.extend({
  tables: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
    grid: z.array(z.array(z.string().max(4000)).min(2).max(50)).min(2).max(100),
    merges: z.array(z.object({
      row: z.number().int().min(1).max(100), col: z.number().int().min(1).max(50),
      rowSpan: z.number().int().min(1).max(100), colSpan: z.number().int().min(1).max(50),
    })).max(2000),
  })).max(5),
});

export type SourceCandidate = z.infer<typeof sourceCandidateSchema>;
export type TableIssue = {
  tableIndex: number; code: "ROW_WIDTH" | "GRID_LIMIT" | "MERGE_OUTSIDE" | "MERGE_OVERLAP" | "COVERED_TEXT" | "TABLE_SCHEMA" | "DUPLICATE_ID" | "REPAIR_TABLE_SET";
  row?: number; col?: number; expectedColumns?: number; actualColumns?: number;
};
export type SourceDiagnostic = { version: 1; source: SourceCandidate; issues: TableIssue[] };
export class SourceTableError extends Error {
  constructor(readonly issues: TableIssue[]) { super("INVALID_TABLE_STRUCTURE"); }
}

export function tableIssueMessage(issue: TableIssue): string {
  const position = `${issue.tableIndex + 1}번 표${issue.row ? ` ${issue.row}행` : ""}${issue.col ? ` ${issue.col}열` : ""}`;
  const messages: Record<TableIssue["code"], string> = {
    ROW_WIDTH: `열 수 불일치(기준 ${issue.expectedColumns}, 응답 ${issue.actualColumns})`,
    GRID_LIMIT: "표 크기 한도 초과", MERGE_OUTSIDE: "병합 범위가 표 밖으로 나감",
    MERGE_OVERLAP: "병합 영역 겹침", COVERED_TEXT: "병합으로 덮이는 칸에 별도 내용이 있음",
    TABLE_SCHEMA: "저장 가능한 표 구조가 아님", DUPLICATE_ID: "표 식별자 중복", REPAIR_TABLE_SET: "보정 대상 표가 누락되거나 바뀜",
  };
  return `${position}: ${messages[issue.code]}`;
}

export function expandSourceCandidate(source: SourceCandidate): ValidationCandidate {
  const issues: TableIssue[] = [];
  const tables = source.tables.flatMap((table, tableIndex) => {
    const before = issues.length;
    const issue = (code: TableIssue["code"], extra: Partial<TableIssue> = {}) => issues.push({ tableIndex, code, ...extra });
    const rows = table.grid.length, cols = table.grid[0].length;
    if (source.tables.filter(other => other.id === table.id).length > 1) issue("DUPLICATE_ID");
    if (rows * cols > 2000) issue("GRID_LIMIT");
    table.grid.forEach((row, index) => {
      if (row.length !== cols) issue("ROW_WIDTH", { row: index + 1, expectedColumns: cols, actualColumns: row.length });
    });
    // Do not invent missing empty cells: their positions cannot be inferred from row length alone.
    if (issues.length > before) return [];
    const occupied = new Set<string>();
    const cells = table.merges.flatMap(merge => {
      if (merge.row + merge.rowSpan - 1 > rows || merge.col + merge.colSpan - 1 > cols) {
        issue("MERGE_OUTSIDE", { row: merge.row, col: merge.col }); return [];
      }
      for (let r = merge.row; r < merge.row + merge.rowSpan; r++) for (let c = merge.col; c < merge.col + merge.colSpan; c++) {
        const key = `${r}:${c}`;
        if (occupied.has(key)) issue("MERGE_OVERLAP", { row: r, col: c });
        if ((r !== merge.row || c !== merge.col) && table.grid[r - 1][c - 1] !== "") issue("COVERED_TEXT", { row: r, col: c });
        occupied.add(key);
      }
      return [{ ...merge, text: table.grid[merge.row - 1][merge.col - 1] }];
    });
    if (issues.length > before) return [];
    table.grid.forEach((row, r) => row.forEach((text, c) => {
      if (!occupied.has(`${r + 1}:${c + 1}`)) cells.push({ row: r + 1, col: c + 1, rowSpan: 1, colSpan: 1, text });
    }));
    cells.sort((a, b) => a.row - b.row || a.col - b.col);
    const result = knowledgeTableSchema.safeParse({ id: table.id, rows, cols, cells });
    if (!result.success) { issue("TABLE_SCHEMA"); return []; }
    return [result.data];
  });
  if (issues.length) throw new SourceTableError(issues.slice(0, 100));
  return validationCandidateSchema.parse({ ...source, tables });
}
