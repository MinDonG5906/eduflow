import type { KnowledgeTable } from "@/lib/knowledge-structure";

/** A source-data preview: blank cells and merged ranges retain their original meaning. */
export function KnowledgeTablePreview({ table }: { table: KnowledgeTable }) {
  return <div className="visual-table-scroll" tabIndex={0} role="region" aria-label="추천 표 미리보기">
    <table><caption className="sr-only">추천 표의 추출 내용</caption>
      <tbody>{Array.from({ length: table.rows }, (_, index) => <tr key={index}>
        {table.cells.filter(cell => cell.row === index + 1).sort((a,b) => a.col - b.col).map(cell =>
          <td key={cell.col} rowSpan={cell.rowSpan} colSpan={cell.colSpan} aria-label={cell.text ? undefined : "빈 셀"}>{cell.text}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}
