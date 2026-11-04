import type { RetrievedReference } from "../knowledge";
import type { KnowledgeStructure } from "../knowledge-structure";

/** Enrich at read time so existing indexes retain their IDs and need no destructive rebuild. */
export function withKnowledgeContext(reference: RetrievedReference, structure?: KnowledgeStructure): RetrievedReference {
  const blocks = structure?.blocks ?? [];
  const position = blocks.findIndex(block => reference.blockIds?.includes(block.id));
  const selected = blocks.filter(block => reference.blockIds?.includes(block.id));
  const headings = blocks.filter(block => !block.tableId && block.text.length <= 100 && !/[.!?。！？]$/.test(block.text.trim()));
  // Table blocks are appended after page text, not in physical reading order.
  // With multiple section headings we cannot safely assign the last one to a table.
  const sectionTitle = selected.some(block => block.tableId)
    ? headings.length === 1 ? headings[0].text : ""
    : position < 0 ? "" : blocks.slice(0, position + 1).reverse().find(block => headings.includes(block))?.text ?? "";
  const tableIds = new Set(selected.map(block => block.tableId));
  const tableHeaders = (structure?.tables ?? []).filter(table => tableIds.has(table.id))
    .flatMap(table => table.cells.filter(cell => cell.row === 1).map(cell => cell.text)).slice(0, 50);
  const surroundingText = position < 0 || selected.some(block => block.tableId) ? "" :
    blocks.slice(Math.max(0, position - 1), position + 2).filter(block => !block.tableId).map(block => block.text).join("\n").slice(0, 1800);
  return { ...reference, context: { documentTitle: reference.title, sectionTitle, tableHeaders, surroundingText } };
}
