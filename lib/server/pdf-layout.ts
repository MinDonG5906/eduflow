import "server-only";
import { OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";

export type Box = [number, number, number, number]; // left, top, right, bottom, PDF points
type Matrix = number[];
type Line = { a: number; b: number; at: number; vertical: boolean };
export type LayoutCell = { row: number; col: number; rowSpan: number; colSpan: number; text: string; figures: string[]; highlights?: { text: string; color: string }[] };
export type LayoutTable = { id: string; bounds: Box; rows: number; cols: number; rowPositions: number[]; columnPositions: number[]; cells: LayoutCell[] };
export type LayoutFigure = { id: string; bounds: Box; table?: string; row?: number; col?: number; nearbyText?: string };
export type PageLayout = {
  page: number; width: number; height: number; text: string;
  tables: LayoutTable[]; figures: LayoutFigure[]; contextImage: string;
  panels: { bounds: Box; text: string; color: string }[];
};
type Region = { box: Box; text: string };
const tolerance = 1.5;
const identity = () => [1, 0, 0, 1, 0, 0];
const round = (v: number) => Math.round(v * 10) / 10;
const transformPoint = (p: number[], m: Matrix) => [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
const boxSize = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
function intersect(a: Box, b: Box): Box { return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]; }
function within(a: Box, b: Box, margin = tolerance) { return a[0] >= b[0] - margin && a[1] >= b[1] - margin && a[2] <= b[2] + margin && a[3] <= b[3] + margin; }
function bounds(points: number[][]): Box { return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]; }
function transformed(b: Box, matrix: Matrix): Box {
  return bounds([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(p => transformPoint(p, matrix)));
}

// PDF.js 5.x normalizes paths to move/line/cubic/close commands. Decode the
// actual segments: a bounding box alone cannot distinguish a table from a chart.
function pathGeometry(paths: ArrayLike<number>[], matrix: Matrix) {
  const segments: number[][][] = [], rectangles: Box[] = [];
  let curved = false;
  for (const path of paths) {
    let points: number[][] = [], current: number[] | undefined;
    for (let i = 0; i < path.length;) {
      const op = path[i++];
      if (op === 0) { current = transformPoint([path[i++], path[i++]], matrix); points = [current]; }
      else if (op === 1) {
        const point = transformPoint([path[i++], path[i++]], matrix);
        if (current) segments.push([current, point]);
        points.push(point); current = point;
      } else if (op === 2) { curved = true; i += 6; }
      else if (op === 3) {
        if (current && points[0]) segments.push([current, points[0]]);
        if (points.length === 4 && points.every((p, n) => {
          const next = points[(n + 1) % points.length];
          return Math.abs(p[0] - next[0]) < 0.1 || Math.abs(p[1] - next[1]) < 0.1;
        })) rectangles.push(bounds(points));
      } else return null;
    }
  }
  return { segments, rectangles, curved };
}

function pivots(values: number[]) {
  const result: number[] = [];
  for (const value of values.sort((a, b) => a - b)) {
    if (!result.length || value - result[result.length - 1] > tolerance) result.push(value);
  }
  return result;
}
function covers(lines: Line[], vertical: boolean, at: number, a: number, b: number) {
  let end = a;
  for (const line of lines.filter(l => l.vertical === vertical && Math.abs(l.at - at) <= tolerance && l.b >= a && l.a <= b).sort((l, r) => l.a - r.a)) {
    if (line.a > end + tolerance) return false;
    end = Math.max(end, line.b);
    if (end >= b - tolerance) return true;
  }
  return false;
}

function tableFromLines(lines: Line[], page: number): { table: LayoutTable; boxes: Box[] } | null {
  const vertical = lines.filter(l => l.vertical && l.b - l.a > 12);
  const verticalPositions = pivots(vertical.map(l => l.at));
  // Writing underlines inside a cell are not row borders: a grid border must
  // start and finish on column boundaries. Keep these marks in the context
  // image rather than inventing extra rows from them.
  const horizontal = lines.filter(l => !l.vertical && l.b - l.a > 12 &&
    verticalPositions.some(x => Math.abs(x - l.a) <= tolerance) && verticalPositions.some(x => Math.abs(x - l.b) <= tolerance));
  lines = [...vertical, ...horizontal];
  const xs = pivots(vertical.map(l => l.at)), ys = pivots(horizontal.map(l => l.at));
  if (xs.length < 3 || ys.length < 3 || xs.length > 50 || ys.length > 100) return null;
  const cols = xs.length - 1, rows = ys.length - 1;
  if (cols * rows > 2000) return null;
  // Ignore disconnected headers/underlines outside the largest closed grid.
  const candidates: { x1: number; x2: number; y1: number; y2: number }[] = [];
  let attempts = 0;
  for (let x1 = 0; x1 < xs.length - 2; x1++) for (let x2 = xs.length - 1; x2 > x1 + 1; x2--) {
    for (let y1 = 0; y1 < ys.length - 2; y1++) for (let y2 = ys.length - 1; y2 > y1 + 1; y2--) {
      if (++attempts > 40000) return null;
      if (covers(lines, true, xs[x1], ys[y1], ys[y2]) && covers(lines, true, xs[x2], ys[y1], ys[y2]) &&
          covers(lines, false, ys[y1], xs[x1], xs[x2]) && covers(lines, false, ys[y2], xs[x1], xs[x2])) candidates.push({ x1, x2, y1, y2 });
      if (candidates.length > 2000) return null;
    }
  }
  const outer = candidates.sort((a, b) => (xs[b.x2] - xs[b.x1]) * (ys[b.y2] - ys[b.y1]) - (xs[a.x2] - xs[a.x1]) * (ys[a.y2] - ys[a.y1]))[0];
  if (!outer) return null;
  const x = xs.slice(outer.x1, outer.x2 + 1), y = ys.slice(outer.y1, outer.y2 + 1);
  const width = x.length - 1, height = y.length - 1;
  const visited = new Set<number>(), cells: LayoutCell[] = [], boxes: Box[] = [];
  // Missing internal borders join atomic grid slots. Only rectangular unions
  // qualify as merged cells; ambiguous or broken borders force the visual path.
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const start = row * width + col;
    if (visited.has(start)) continue;
    const slots: [number, number][] = [], queue: [number, number][] = [[row, col]];
    visited.add(start);
    for (let i = 0; i < queue.length; i++) {
      const [r, c] = queue[i]; slots.push([r, c]);
      for (const [nr, nc, wall] of [
        [r, c - 1, covers(lines, true, x[c], y[r], y[r + 1])],
        [r, c + 1, covers(lines, true, x[c + 1], y[r], y[r + 1])],
        [r - 1, c, covers(lines, false, y[r], x[c], x[c + 1])],
        [r + 1, c, covers(lines, false, y[r + 1], x[c], x[c + 1])],
      ] as [number, number, boolean][]) {
        const key = nr * width + nc;
        if (!wall && nr >= 0 && nr < height && nc >= 0 && nc < width && !visited.has(key)) { visited.add(key); queue.push([nr, nc]); }
      }
    }
    const r1 = Math.min(...slots.map(s => s[0])), r2 = Math.max(...slots.map(s => s[0]));
    const c1 = Math.min(...slots.map(s => s[1])), c2 = Math.max(...slots.map(s => s[1]));
    if (slots.length !== (r2 - r1 + 1) * (c2 - c1 + 1)) return null;
    for (let c = c1 + 1; c <= c2; c++) if (vertical.some(l => Math.abs(l.at - x[c]) <= tolerance && Math.min(l.b, y[r2 + 1]) - Math.max(l.a, y[r1]) > tolerance)) return null;
    for (let r = r1 + 1; r <= r2; r++) if (horizontal.some(l => Math.abs(l.at - y[r]) <= tolerance && Math.min(l.b, x[c2 + 1]) - Math.max(l.a, x[c1]) > tolerance)) return null;
    cells.push({ row: r1 + 1, col: c1 + 1, rowSpan: r2 - r1 + 1, colSpan: c2 - c1 + 1, text: "", figures: [] });
    boxes.push([x[c1], y[r1], x[c2 + 1], y[r2 + 1]]);
  }
  if (cells.length < 4) return null;
  return { table: { id: `p${page}-table1`, bounds: [x[0], y[0], x[x.length - 1], y[y.length - 1]].map(round) as Box,
    rows: height, cols: width, rowPositions: y.map(round), columnPositions: x.map(round), cells }, boxes };
}

function regionText(regions: Region[]) {
  // PDFs often encode m³ as separate ordinary "m" and "3" glyphs. Recover
  // numeric scripts from their size AND baseline shift, never from unit names.
  // Align only the reading-order box; keep original geometry for cell assignment.
  const superscript = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾";
  const subscript = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎";
  const scriptCharacters = "0123456789+-=()";
  const aligned = regions.map(region => {
    if (!/^[0-9+−\-=()]+$/.test(region.text)) return region;
    const height = region.box[3] - region.box[1];
    const bases = regions.filter(base => {
      const baseHeight = base.box[3] - base.box[1];
      const gap = region.box[0] - base.box[2];
      const shift = base.box[3] - region.box[3];
      return /[\p{L}\p{N})\]]$/u.test(base.text) && height > 0 && height <= baseHeight * 0.85 &&
        gap >= -baseHeight * 0.2 && gap <= baseHeight * 0.65 &&
        Math.abs(shift) >= baseHeight * 0.18 && Math.abs(shift) <= baseHeight * 0.7;
    }).sort((a, b) => Math.abs(region.box[0] - a.box[2]) - Math.abs(region.box[0] - b.box[2]));
    const base = bases[0];
    if (!base) return region;
    const alphabet = base.box[3] > region.box[3] ? superscript : subscript;
    return { text: [...region.text.replace(/−/g, "-")].map(char => alphabet[scriptCharacters.indexOf(char)]).join(""),
      box: [region.box[0], base.box[1], region.box[2], base.box[3]] as Box };
  });
  const sorted = aligned.sort((a, b) => Math.abs(a.box[1] - b.box[1]) < 2 ? a.box[0] - b.box[0] : a.box[1] - b.box[1]);
  let result = "", previous: Region | undefined;
  for (const region of sorted) {
    if (previous) {
      const sameLine = Math.abs(region.box[1] - previous.box[1]) < 2;
      const height = region.box[3] - region.box[1];
      result += sameLine ? (region.box[0] - previous.box[2] > height * 0.18 ? " " : "") : "\n";
    }
    result += region.text; previous = region;
  }
  return result.trim();
}

/** A reliable closed grid is required. Arbitrary diagrams, borderless tables,
 * scans, clipped/rotated/hidden text and unknown paint operations stay visual. */
export async function analyzePdfTable(page: PDFPageProxy, originalPage: number, options: { tableOnly?: boolean } = {}): Promise<PageLayout | null> {
  if (page.rotate !== 0 || page.isPureXfa || (await page.getAnnotations()).some(a => a.subtype !== "Link")) return null;
  const viewport = page.getViewport({ scale: 1 }), pageBox: Box = [0, 0, viewport.width, viewport.height];
  const ops = await page.getOperatorList();
  let state = { matrix: identity(), textMatrix: identity(), clip: pageBox, fillAlpha: 1, strokeAlpha: 1, mode: 0, neutralFill: true, fillColor: "#000000" };
  const stack: typeof state[] = [], lines: Line[] = [], figures: Box[] = [], marks: { box: Box; background: boolean; color?: string }[] = [];
  const hiddenDots: number[][] = [];
  const textClips: { point: number[]; clip: Box }[] = [];
  const ignored = new Set<number>([OPS.dependency, OPS.setLineWidth, OPS.setLineCap, OPS.setLineJoin, OPS.setMiterLimit, OPS.setDash,
    OPS.beginText, OPS.endText, OPS.setCharSpacing, OPS.setWordSpacing, OPS.setHScale, OPS.setLeading, OPS.setFont,
    OPS.setTextRise, OPS.moveText, OPS.setLeadingMoveText, OPS.setTextMatrix, OPS.nextLine,
    OPS.setStrokeColorSpace, OPS.setFillColorSpace, OPS.setStrokeColor, OPS.setFillColor,
    OPS.setStrokeGray, OPS.setFillGray, OPS.setStrokeRGBColor, OPS.setFillRGBColor, OPS.setStrokeCMYKColor, OPS.setFillCMYKColor,
    OPS.markPoint, OPS.markPointProps, OPS.beginMarkedContent, OPS.beginMarkedContentProps, OPS.endMarkedContent]);
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i], args = ops.argsArray[i];
    const matrix = Util.transform(viewport.transform, state.matrix);
    if (op === OPS.save) stack.push({ ...state, matrix: [...state.matrix], clip: [...state.clip] });
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) { if (!stack.length) return null; state = stack.pop()!; }
    else if (op === OPS.transform) state.matrix = Util.transform(state.matrix, args);
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push({ ...state, matrix: [...state.matrix], clip: [...state.clip] });
      if (args[0]) state.matrix = Util.transform(state.matrix, args[0]);
      if (args[1]) state.clip = intersect(state.clip, transformed(args[1], Util.transform(viewport.transform, state.matrix)));
    } else if (op === OPS.setTextRenderingMode) state.mode = args[0];
    else if (op === OPS.setTextMatrix) state.textMatrix = [...(Array.isArray(args[0]) || ArrayBuffer.isView(args[0]) ? args[0] : args)];
    else if (op === OPS.moveText || op === OPS.setLeadingMoveText) state.textMatrix = Util.transform(state.textMatrix, [1, 0, 0, 1, args[0], args[1]]);
    else if (op === OPS.setFillRGBColor) {
      const rgb = typeof args[0] === "string" ? args[0].match(/^#(..)(..)(..)$/)?.slice(1).map((s: string) => parseInt(s, 16)) : args;
      state.neutralFill = Boolean(rgb && Math.max(...rgb) - Math.min(...rgb) < 2);
      state.fillColor = typeof args[0] === "string" ? args[0] : "unknown";
    } else if (op === OPS.setFillGray) { state.neutralFill = true; state.fillColor = "gray"; }
    else if (op === OPS.setFillCMYKColor) { state.neutralFill = Math.max(...args.slice(0, 3)) - Math.min(...args.slice(0, 3)) < 0.01; state.fillColor = "unknown"; }
    else if (op === OPS.setGState) {
      for (const [key, value] of args[0]) {
        if (key === "ca") state.fillAlpha = value;
        else if (key === "CA") state.strokeAlpha = value;
        else if (!["LW", "LC", "LJ", "ML", "D"].includes(key)) return null;
      }
    } else if ([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].includes(op)) {
      if (![0, 1, 2].includes(state.mode)) return null;
      if ((state.mode === 0 && state.fillAlpha !== 1) || (state.mode === 1 && state.strokeAlpha !== 1) ||
          (state.mode === 2 && (state.fillAlpha !== 1 || state.strokeAlpha !== 1))) {
        // rhwp emits transparent middle-dot layout placeholders. Remove only
        // these exact positioned glyphs; all other invisible text stays visual.
        const glyphs = (args[0] ?? []).filter((g: unknown) => typeof g === "object" && g !== null);
        if (glyphs.length !== 1 || glyphs[0].unicode !== "·" || state.fillAlpha !== 0) return null;
        hiddenDots.push(transformPoint([state.textMatrix[4], state.textMatrix[5]], matrix));
      } else textClips.push({ point: transformPoint([state.textMatrix[4], state.textMatrix[5]], matrix), clip: [...state.clip] });
      if (textClips.length > 10000) return null;
    } else if (op === OPS.constructPath) {
      const geometry = pathGeometry(args[1], matrix);
      if (!geometry) return null;
      const raw = transformed(args[2], matrix), box = intersect(raw, state.clip);
      if (!box.every(Number.isFinite)) return null;
      if (args[0] === OPS.endPath) {
        if (ops.fnArray[i - 1] === OPS.clip || ops.fnArray[i - 1] === OPS.eoClip) {
          if (geometry.rectangles.length !== 1) return null;
          state.clip = intersect(state.clip, geometry.rectangles[0]);
        }
        continue;
      }
      if (boxSize(box) <= 0 && !geometry.segments.length) continue;
      const paintVisible = args[0] === OPS.stroke ? state.strokeAlpha > 0 : state.fillAlpha > 0;
      if (!paintVisible) continue;
      if (geometry.curved) {
        // Tiny checkbox/checkmark/bullet artwork is retained as a figure crop.
        if (box[2] - box[0] > 18 || box[3] - box[1] > 18) {
          if (!options.tableOnly) return null;
          figures.push(box); continue;
        }
        marks.push({ box, background: false }); continue;
      }
      if ([OPS.fill, OPS.eoFill].includes(args[0])) {
        if (geometry.rectangles.length !== 1) {
          if (box[2] - box[0] <= 18 && box[3] - box[1] <= 18) { marks.push({ box, background: false }); continue; }
          if (!options.tableOnly) return null;
          figures.push(box); continue;
        }
        const rect = intersect(geometry.rectangles[0], state.clip), w = rect[2] - rect[0], h = rect[3] - rect[1];
        if (w > 12 && h <= 4) lines.push({ a: rect[0], b: rect[2], at: (rect[1] + rect[3]) / 2, vertical: false });
        else if (h > 12 && w <= 4) lines.push({ a: rect[1], b: rect[3], at: (rect[0] + rect[2]) / 2, vertical: true });
        // Filled rectangles are backgrounds only if later covered by the grid.
        else marks.push({ box: rect, background: state.neutralFill, color: state.fillColor });
      } else if ([OPS.stroke, OPS.fillStroke, OPS.eoFillStroke].includes(args[0])) {
        for (const [a, b] of geometry.segments) {
          if (Math.abs(a[0] - b[0]) < 0.2) {
            if (a[0] >= state.clip[0] && a[0] <= state.clip[2]) lines.push({ a: Math.max(Math.min(a[1], b[1]), state.clip[1]), b: Math.min(Math.max(a[1], b[1]), state.clip[3]), at: a[0], vertical: true });
          } else if (Math.abs(a[1] - b[1]) < 0.2) {
            if (a[1] >= state.clip[1] && a[1] <= state.clip[3]) lines.push({ a: Math.max(Math.min(a[0], b[0]), state.clip[0]), b: Math.min(Math.max(a[0], b[0]), state.clip[2]), at: a[1], vertical: false });
          }
          else if (options.tableOnly) figures.push(box);
          else return null;
        }
      } else return null;
    } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      if (Math.abs(matrix[1]) > 0.01 || Math.abs(matrix[2]) > 0.01 || state.fillAlpha !== 1) return null;
      const box = intersect(transformed([0, 0, 1, 1], matrix), state.clip);
      if (boxSize(box) > boxSize(pageBox) * 0.35) return null;
      if (box[2] > box[0] && box[3] > box[1]) figures.push(box);
    } else if (op !== OPS.clip && op !== OPS.eoClip && !ignored.has(op)) return null;
    if (lines.length > 10000 || figures.length > 100 || marks.length > 10000) return null;
  }
  const grid = tableFromLines(lines, originalPage);
  if (!grid) return null;
  const content = await page.getTextContent();
  const text: Region[] = [];
  for (const item of content.items.filter((item): item is TextItem => "str" in item)) {
    if (!item.str.trim()) continue;
    // Preserve the position of the known unmapped bullet glyph. RAG excludes
    // affected rows until this symbol is reviewed; never infer a checkbox state.
    const rawText = options.tableOnly && item.str === "\uf000" ? "[원본 기호 확인]" : item.str;
    if (item.dir !== "ltr" || /[\u0000-\u0008\u000b-\u001f\ufffd\ue000-\uf8ff]/u.test(rawText)) return null;
    const m = Util.transform(viewport.transform, item.transform);
    if (item.str === "·" && hiddenDots.some(p => Math.abs(p[0] - m[4]) < 1 && Math.abs(p[1] - m[5]) < 1)) continue;
    if (Math.abs(m[1]) > 0.01 || Math.abs(m[2]) > 0.01) return null;
    const box: Box = [m[4], m[5] - item.height, m[4] + item.width, m[5]];
    if (!within(box, pageBox)) return null;
    const clip = textClips.find(record => Math.abs(record.point[0] - m[4]) < 1 && Math.abs(record.point[1] - m[5]) < 1)?.clip;
    if (clip && !within(box, clip, 2)) return null;
    text.push({ box, text: rawText });
  }
  if (text.reduce((n, t) => n + t.text.length, 0) < 40) return null;
  const cellRegions: Region[][] = grid.boxes.map(() => []), outside: Region[] = [];
  for (const region of text) {
    const matches = grid.boxes.flatMap((box, i) => within(region.box, box) ? [i] : []);
    if (matches.length === 1) cellRegions[matches[0]].push(region);
    else if (within(region.box, grid.table.bounds)) return null;
    else outside.push(region);
  }
  for (const [i, regions] of cellRegions.entries()) grid.table.cells[i].text = regionText(regions);
  const result: PageLayout = { page: originalPage, width: round(viewport.width), height: round(viewport.height),
    text: regionText(outside), tables: [grid.table], figures: [], panels: [], contextImage: `p${originalPage}-context` };
  const panelText = new Set<Region>();
  // Large rectangles are permitted only as the page background or table/cell
  // background. Other artwork must keep the original whole-page visual path.
  for (const { box, background, color } of marks) {
    const large = box[2] - box[0] > 18 || box[3] - box[1] > 18;
    if (large && background && within(box, grid.table.bounds, 2)) continue;
    if (large && background && !within(pageBox, box, 2)) {
      const regions = outside.filter(region => within(region.box, box, 2));
      result.panels.push({ bounds: box.map(round) as Box, text: regionText(regions), color: color ?? "gray" });
      regions.forEach(region => panelText.add(region));
      continue;
    }
    if (large && !background && color && color !== "unknown") {
      const cellIndex = grid.boxes.findIndex(cell => within(box, cell, 2));
      if (cellIndex >= 0) {
        const label = regionText(cellRegions[cellIndex].filter(region => within(region.box, box, 2)));
        if (label) { (grid.table.cells[cellIndex].highlights ??= []).push({ text: label, color }); continue; }
      }
    }
    if (large && !within(pageBox, box, 2) && !grid.boxes.some(cell => within(box, cell, 2))) figures.push(box);
    else if (large && !background) figures.push(box);
    if (!large && boxSize(box) > 0.1) figures.push(box);
  }
  // Each crop is tied to one merged cell; captions/headers/footnotes remain in
  // the complete structured page and the context image. Never infer a relation
  // for artwork crossing cell borders.
  const grouped: Box[] = [];
  // Merge touching/overlapping artwork before rendering, preventing an outside
  // table header or a cluster of checkbox marks from becoming many tiny crops.
  for (const figure of figures) {
    const same = grouped.find(box => boxSize(intersect(box, figure)) > 0 ||
      (Math.abs(box[1] - figure[1]) < 1 && Math.abs(box[3] - figure[3]) < 1 && Math.max(box[0], figure[0]) <= Math.min(box[2], figure[2]) + 2));
    if (same) { same[0] = Math.min(same[0], figure[0]); same[1] = Math.min(same[1], figure[1]); same[2] = Math.max(same[2], figure[2]); same[3] = Math.max(same[3], figure[3]); }
    else grouped.push([...figure]);
  }
  // Keep multiple tiny checkbox/bullet graphics in one cell as one positioned
  // strip. This preserves their order while avoiding repeated image metadata.
  const smallByCell = new Map<number, Box>();
  const crops: Box[] = [];
  for (const box of grouped) {
    const cell = grid.boxes.findIndex(cell => within(box, cell, 2));
    if (cell >= 0 && box[2] - box[0] <= 18 && box[3] - box[1] <= 18) {
      const previous = smallByCell.get(cell);
      if (previous) { previous[0] = Math.min(previous[0], box[0]); previous[1] = Math.min(previous[1], box[1]); previous[2] = Math.max(previous[2], box[2]); previous[3] = Math.max(previous[3], box[3]); }
      else smallByCell.set(cell, [...box]);
    } else crops.push(box);
  }
  crops.push(...smallByCell.values());
  for (const box of crops) {
    const matches = grid.boxes.flatMap((cell, i) => within(box, cell, 2) ? [i] : []);
    const id = `p${originalPage}-figure${result.figures.length + 1}`;
    if (matches.length === 1) {
      const cell = grid.table.cells[matches[0]];
      cell.figures.push(id);
      result.figures.push({ id, bounds: box.map(round) as Box, table: grid.table.id, row: cell.row, col: cell.col });
    } else {
      const overlap = intersect(box, grid.table.bounds);
      if (!options.tableOnly && overlap[2] - overlap[0] > 2 && overlap[3] - overlap[1] > 2) return null;
      const near: Box = [box[0] - 12, box[1] - 24, box[2] + 12, box[3] + 24];
      result.figures.push({ id, bounds: box.map(round) as Box, nearbyText: regionText(outside.filter(r => boxSize(intersect(r.box, near)) > 0)) });
    }
  }
  if (!options.tableOnly && result.figures.length > 30) return null;
  if (options.tableOnly) {
    for (const cell of grid.table.cells) {
      // Vector ticks and tiny checkbox artwork have no Unicode text. Preserve
      // their presence and require a cell-level review instead of calling them empty.
      const hasSymbol = cell.figures.some(id => {
        const figure = result.figures.find(figure => figure.id === id)!;
        return figure.bounds[2] - figure.bounds[0] <= 36 && figure.bounds[3] - figure.bounds[1] <= 36;
      });
      if (hasSymbol && !cell.text.includes("[원본 기호 확인]")) cell.text += `${cell.text ? " " : ""}[원본 기호 확인]`;
    }
  }
  result.text = regionText(outside.filter(region => !panelText.has(region)));
  return result;
}
