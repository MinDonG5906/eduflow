import type { Scene, VisualPlacement } from "./storyboard";

export const compositionLayouts = { left: "자료 왼쪽 · 인물 오른쪽", right: "자료 오른쪽 · 인물 왼쪽", full: "자료 중심 · 화면 전체", bottom: "자료 아래쪽" } as const;
export type CompositionLayout = keyof typeof compositionLayouts;
type CompositionScene = Pick<Scene, "visuals" | "visualPlacements" | "visual"> & Partial<Pick<Scene, "subtitle" | "subtitleSettings">>;
export function compositionVisuals(scene: Pick<Scene, "visuals">) {
  return [...new Map((scene.visuals ?? []).map(visual => [visual.id, visual])).values()];
}
export function suggestedComposition(visual: string): CompositionLayout {
  if (/(?:자료|표|그림|이미지|사진)(?:를|을|는|은|의|\s|화면|영역){0,12}(?:전체|전면|중심)/.test(visual)) return "full";
  // Match the asset's own placement, not a later clause about the presenter.
  const position = visual.match(/(왼쪽|좌측|오른쪽|우측|아래쪽|하단)(?:에|는|은|의|\s|화면|영역){0,12}(?:자료|표|그림|이미지|사진)/)?.[1]
    ?? visual.match(/(?:자료|표|그림|이미지|사진)(?:를|을|는|은|의|\s|화면|영역|과|와|그림|표){0,12}(왼쪽|좌측|오른쪽|우측|아래쪽|하단)/)?.[1];
  if (position === "아래쪽" || position === "하단") return "bottom";
  if (position === "오른쪽" || position === "우측") return "right";
  return "left";
}
export function defaultVisualPlacements(scene: Pick<Scene, "visuals" | "visual"> & Partial<Pick<Scene, "subtitle">>, layout = suggestedComposition(scene.visual)): VisualPlacement[] {
  const visuals = compositionVisuals(scene);
  const area = { left: [5, 12, 57, 76], right: [38, 12, 57, 76], full: [5, 8, 90, 84], bottom: [5, 54, 90, 39] }[layout];
  if (scene.subtitle?.trim()) { area[1] = layout === "bottom" ? 36 : 8; area[3] = layout === "bottom" ? 40 : 68; }
  const columns = visuals.length <= 2 ? 1 : Math.min(4, Math.ceil(Math.sqrt(visuals.length)));
  const rows = Math.ceil(visuals.length / columns);
  area[3] = Math.max(area[3], rows * 12);
  area[1] = Math.min(area[1], 98 - area[3]);
  return visuals.map((item, i) => ({ visualId: item.id,
    x: area[0] + (i % columns) * area[2] / columns, y: area[1] + Math.floor(i / columns) * area[3] / rows,
    width: area[2] / columns - 2, height: area[3] / rows - 2 }));
}
export function sceneVisualPlacements(scene: CompositionScene): VisualPlacement[] {
  const ids = new Set(compositionVisuals(scene).map(visual => visual.id));
  return (scene.visualPlacements ?? defaultVisualPlacements(scene)).filter(item => ids.has(item.visualId));
}
export function setVisualUsage(scene: CompositionScene, visualId: string, enabled: boolean): VisualPlacement[] {
  const placements = sceneVisualPlacements(scene);
  if (!enabled) return placements.filter(item => item.visualId !== visualId);
  if (placements.some(item => item.visualId === visualId)) return placements;
  const placement = defaultVisualPlacements(scene).find(item => item.visualId === visualId);
  return placement ? [...placements, placement] : placements;
}
/** Layout presets move the active visuals without re-enabling excluded ones. */
export function relayoutVisualPlacements(scene: CompositionScene, layout?: CompositionLayout): VisualPlacement[] {
  const active = new Set(sceneVisualPlacements(scene).map(item => item.visualId));
  return defaultVisualPlacements(scene, layout).filter(item => active.has(item.visualId));
}
export function activeVisuals(scene: CompositionScene) {
  const active = new Set(sceneVisualPlacements(scene).map(item => item.visualId));
  return compositionVisuals(scene).filter(item => active.has(item.id));
}
export function activeVisualReferences(scene: CompositionScene & Pick<Scene, "visualReferences">) {
  if (scene.visualPlacements === undefined) return scene.visualReferences ?? [];
  const visuals = activeVisuals(scene);
  return (scene.visualReferences ?? []).filter(reference => visuals.some(visual => reference.documentId === visual.documentId &&
    (reference.visuals?.some(item => item.id === visual.id) || reference.page === visual.page)));
}
export function clampVisualPlacement(placement: VisualPlacement): VisualPlacement {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const width = Math.min(100, Math.max(10, finite(placement.width, 40)));
  const height = Math.min(100, Math.max(10, finite(placement.height, 40)));
  return { ...placement, width, height, x: Math.min(100 - width, Math.max(0, finite(placement.x, 0))), y: Math.min(100 - height, Math.max(0, finite(placement.y, 0))) };
}
// Resize from the lower-right corner without moving the opposite corner.
export function resizeVisualPlacement(placement: VisualPlacement, width: number, height: number): VisualPlacement {
  return { ...placement, width: Math.min(100 - placement.x, Math.max(10, Number.isFinite(width) ? width : placement.width)), height: Math.min(100 - placement.y, Math.max(10, Number.isFinite(height) ? height : placement.height)) };
}
// The background always fits the frame; legacy scale settings are ignored.
export function compositionBackgroundRect(imageWidth: number, imageHeight: number, frameWidth: number, frameHeight: number) {
  const scale = Math.min(frameWidth / imageWidth, frameHeight / imageHeight);
  const width = imageWidth * scale, height = imageHeight * scale;
  return { x: (frameWidth - width) / 2, y: (frameHeight - height) / 2, width, height };
}
export function compositionStickers(scene: CompositionScene) {
  const visuals = compositionVisuals(scene);
  return sceneVisualPlacements(scene).flatMap(placement => {
    const index = visuals.findIndex(visual => visual.id === placement.visualId);
    return index < 0 ? [] : [{ ...placement, number: index + 1, visual: visuals[index], label: `추천 시각자료 ${index + 1}`, kind: visuals[index].kind === "table" ? "표" : "그림" }];
  });
}
const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!));
export type CompositionAssets = Record<string, string>;
const COMPOSITION_FONT = "EduFlow Korean, Apple SD Gothic Neo, Malgun Gothic, Noto Sans CJK KR, Arial, sans-serif";
export function compositionAssetRect(placement: VisualPlacement) {
  const w = placement.width * 16, h = placement.height * 9;
  const font = Math.min(27, w / 15, h / 6);
  return { x: placement.x * 16 + 6, y: placement.y * 9 + font * 1.7, width: Math.max(1, w - 12), height: Math.max(1, h - font * 1.7 - 6) };
}
export function wrapCompositionText(text: string, columns: number) {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "", width = 0;
    for (const char of Array.from(paragraph)) {
      const weight = /^[\x00-\x7f]$/.test(char) ? .55 : 1;
      if (line && width + weight > columns) { lines.push(line.trim()); line = ""; width = 0; }
      line += char; width += weight;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}
/** The empty storyboard is a usable title card, shared by preview and exports. */
export function compositionPlaceholderSvg(scene: Pick<Scene, "title">) {
  const lines = wrapCompositionText(scene.title || "스토리보드", 24).slice(0, 4);
  const top = 450 - (lines.length - 1) * 42;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#111113"/>${lines.map((line, i) => `<text x="800" y="${top + i * 84}" text-anchor="middle" font-family="EduFlow Korean, Apple SD Gothic Neo, Malgun Gothic, Noto Sans CJK KR, Arial, sans-serif" font-size="64" font-weight="bold" fill="#fafafa">${escapeXml(line)}</text>`).join("")}</svg>`;
}
export function compositionSubtitle(scene: CompositionScene) {
  if (!scene.subtitle?.trim() || scene.subtitleSettings?.enabled === false) return null;
  let fontSize = 44, lines = wrapCompositionText(scene.subtitle, 1344 / fontSize);
  while (lines.length > 2 && fontSize > 26) { fontSize -= 2; lines = wrapCompositionText(scene.subtitle, 1344 / fontSize); }
  const truncated = lines.length > 8;
  if (truncated) lines = [...lines.slice(0, 7), `${lines[7]}…`];
  const height = (lines.length * fontSize * 1.35 + 36) / 9;
  const overlap = (y: number) => sceneVisualPlacements(scene).reduce((sum, item) => sum
    + Math.max(0, Math.min(94, item.x + item.width) - Math.max(6, item.x))
    * Math.max(0, Math.min(y + height, item.y + item.height) - Math.max(y, item.y)), 0);
  const requested = scene.subtitleSettings?.position ?? "auto";
  const position = requested === "auto" ? overlap(4) < overlap(96 - height) ? "top" : "bottom" : requested;
  return { x: 6, y: position === "top" ? 4 : 96 - height, width: 88, height, fontSize, lines, position, truncated };
}
function tableMarkup(table: NonNullable<NonNullable<Scene["visuals"]>[number]["table"]>) {
  const width = 1000, rowHeight = 100, cellWidth = width / table.cols;
  const font = Math.max(7, Math.min(25, cellWidth / 5));
  return `<svg viewBox="0 0 ${width} ${table.rows * rowHeight}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">${table.cells.map((cell, i) => {
    const x = (cell.col - 1) * cellWidth, y = (cell.row - 1) * rowHeight, w = cell.colSpan * cellWidth, h = cell.rowSpan * rowHeight;
    const allLines = wrapCompositionText(cell.text, Math.max(1, (w - 16) / font));
    const limit = Math.max(1, Math.floor((h - 14) / (font * 1.3)));
    const lines = allLines.slice(0, limit);
    if (allLines.length > limit) lines[lines.length - 1] += "…";
    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${cell.row === 1 ? "#edf0f5" : "white"}" stroke="#777" stroke-width="1.5"/><svg x="${x + 8}" y="${y + 7}" width="${Math.max(1, w - 16)}" height="${Math.max(1, h - 14)}">${lines.map((line, j) => `<text x="0" y="${font + j * font * 1.3}" font-family="sans-serif" font-size="${font}" fill="#171717">${escapeXml(line)}</text>`).join("")}</svg></g>`;
  }).join("")}</svg>`;
}
// Preview, PNG and PDF use this same locally composed overlay, including real assets.
export function compositionOverlaySvg(scene: CompositionScene, assets: CompositionAssets = {}, layer: "all" | "sources" | "subtitle" = "all") {
  const stickers = layer === "subtitle" ? "" : compositionStickers(scene).map(sticker => {
    const x = sticker.x * 16, y = sticker.y * 9, w = sticker.width * 16, h = sticker.height * 9;
    const font = Math.min(27, w / 15, h / 6), header = font * 1.7;
    const titleLength = Math.max(3, Math.floor(w / font) - 2);
    const title = Array.from(sticker.visual.title);
    const shortTitle = title.slice(0, titleLength).join("") + (title.length > titleLength ? "…" : "");
    const asset = assets[sticker.visualId];
    const safeAsset = asset && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(asset) ? asset : undefined;
    const content = sticker.visual.kind === "table" && sticker.visual.table ? tableMarkup(sticker.visual.table)
      : safeAsset ? `<image href="${safeAsset}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"/>`
        : `<text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="${font}" fill="#765a29">원본 사진 확인 필요</text>`;
    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="white" stroke="#a9adb6" stroke-width="2"/><text x="${x + 8}" y="${y + font * 1.2}" font-family="sans-serif" font-size="${font}" fill="#333">${sticker.number} · ${sticker.kind} · ${escapeXml(shortTitle)}</text><svg x="${x + 6}" y="${y + header}" width="${Math.max(1, w - 12)}" height="${Math.max(1, h - header - 6)}">${content}</svg></g>`;
  }).join("");
  const subtitle = layer === "sources" ? null : compositionSubtitle(scene);
  const caption = subtitle ? `<g><rect x="${subtitle.x * 16}" y="${subtitle.y * 9}" width="${subtitle.width * 16}" height="${subtitle.height * 9}" rx="12" fill="#111827" fill-opacity=".9"/>${subtitle.lines.map((line, i) => `<text x="800" y="${subtitle.y * 9 + 18 + subtitle.fontSize + i * subtitle.fontSize * 1.35}" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="${subtitle.fontSize}" fill="white">${escapeXml(line)}</text>`).join("")}</g>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${stickers}${caption}</svg>`.replaceAll('font-family="sans-serif"', `font-family="${COMPOSITION_FONT}"`);
}
