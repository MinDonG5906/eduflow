import test from "node:test";
import assert from "node:assert/strict";
import { expandSourceCandidate, sourceCandidateSchema, SourceTableError } from "./server/knowledge-source-format";

const source = { text: "원본 본문", figures: [], uncertainties: [], tables: [{ id: "table1",
  grid: [["점검 항목", "결과", ""], ["전원 차단", "", ""]],
  merges: [{ row: 1, col: 2, rowSpan: 1, colSpan: 2 }] }] };
test("compact tables preserve merged headers, empty response cells and original coordinates", () => {
  const result = expandSourceCandidate(sourceCandidateSchema.parse(source));
  assert.equal(result.tables[0].cells.length, 5);
  assert.deepEqual(result.tables[0].cells[1], { row: 1, col: 2, rowSpan: 1, colSpan: 2, text: "결과" });
  assert.deepEqual(result.tables[0].cells.at(-1), { row: 2, col: 3, rowSpan: 1, colSpan: 1, text: "" });
});
test("four-column machine-safety table preserves a three-cell header and vertical category merges", () => {
  const result = expandSourceCandidate({ ...source, tables: [{ id: "machining",
    grid: [["관련 위험 상황(예)", "", "관련 작업", "관련 위험 영역"],
      ["끼임", "가공물과 공구 사이", "가공", "작업부"], ["", "회전부 접촉", "청소", "회전부"]],
    merges: [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }, { row: 2, col: 1, rowSpan: 2, colSpan: 1 }] }] });
  assert.equal(result.tables[0].cols, 4);
  assert.equal(result.tables[0].cells.length, 10);
  assert.equal(result.tables[0].cells.find(cell => cell.row === 3 && cell.col === 2)?.text, "회전부 접촉");
  assert.deepEqual(result.tables[0].cells.find(cell => cell.row === 2 && cell.col === 1),
    { row: 2, col: 1, rowSpan: 2, colSpan: 1, text: "끼임" });
});
test("table failures locate the exact row or cell without changing source text", () => {
  const hidden = structuredClone(source); hidden.tables[0].grid[0][2] = "별도 내용";
  const before = structuredClone(hidden);
  assert.throws(() => expandSourceCandidate(hidden), (error: unknown) => error instanceof SourceTableError &&
    error.issues.some(issue => issue.code === "COVERED_TEXT" && issue.row === 1 && issue.col === 3));
  assert.deepEqual(hidden, before);
  const ragged = structuredClone(source); ragged.tables[0].grid[1].pop();
  assert.throws(() => expandSourceCandidate(ragged), (error: unknown) => error instanceof SourceTableError &&
    error.issues.some(issue => issue.code === "ROW_WIDTH" && issue.row === 2 && issue.expectedColumns === 3 && issue.actualColumns === 2));
});
test("malformed matrices and conflicting merge content are rejected instead of discarding text", () => {
  const ragged = structuredClone(source); ragged.tables[0].grid[1].pop();
  assert.throws(() => expandSourceCandidate(ragged));
  const hidden = structuredClone(source); hidden.tables[0].grid[0][2] = "보존할 내용";
  assert.throws(() => expandSourceCandidate(hidden));
  const overlap = structuredClone(source); overlap.tables[0].merges.push(overlap.tables[0].merges[0]);
  assert.throws(() => expandSourceCandidate(overlap));
  const outside = structuredClone(source); outside.tables[0].merges[0].rowSpan = 3;
  assert.throws(() => expandSourceCandidate(outside));
});
