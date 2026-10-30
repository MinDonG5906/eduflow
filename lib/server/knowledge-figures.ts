import "server-only";
import { OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import type { KnowledgeFigure } from "../knowledge-structure";

/** Positions are evidence about location only. The model still has to establish
 * the semantic link; raster images larger than half a page are not figures. */
export async function knowledgeFigureCandidates(page: PDFPageProxy): Promise<KnowledgeFigure[]> {
  const viewport = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [], figures: KnowledgeFigure[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i], args = ops.argsArray[i];
    if (op === OPS.save) stack.push([...matrix]);
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (op === OPS.transform) matrix = Util.transform(matrix, args);
    else if (op === OPS.paintFormXObjectBegin) { stack.push([...matrix]); if (args[0]) matrix = Util.transform(matrix, args[0]); }
    else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      const m = Util.transform(viewport.transform, matrix);
      const points = [[0,0], [1,0], [0,1], [1,1]].map(([x,y]) => [x*m[0]+y*m[2]+m[4], x*m[1]+y*m[3]+m[5]]);
      const left = Math.max(0, Math.min(...points.map(p=>p[0])) / viewport.width);
      const right = Math.min(1, Math.max(...points.map(p=>p[0])) / viewport.width);
      const top = Math.max(0, Math.min(...points.map(p=>p[1])) / viewport.height);
      const bottom = Math.min(1, Math.max(...points.map(p=>p[1])) / viewport.height);
      const area = (right-left)*(bottom-top);
      if (area < 0.001 || area > 0.5 || right <= left || bottom <= top) continue;
      if (figures.some(f => f.bounds.every((value,index) => Math.abs(value - [left,top,right,bottom][index]) < 0.001))) continue;
      figures.push({ id: `image${figures.length+1}`, title: `원본 그림 ${figures.length+1}`, bounds: [left,top,right,bottom] });
      if (figures.length === 15) break;
    }
  }
  return figures;
}
