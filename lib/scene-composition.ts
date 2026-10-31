import type { Scene, VisualPlacement } from "./storyboard";

export const compositionLayouts = { left: "자료 왼쪽 · 인물 오른쪽", right: "자료 오른쪽 · 인물 왼쪽", full: "자료 중심 · 화면 전체", bottom: "자료 아래쪽" } as const;
export type CompositionLayout = keyof typeof compositionLayouts;
type CompositionScene = Pick<Scene, "visuals" | "visualPlacements" | "visual">;
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
export function defaultVisualPlacements(scene: Pick<Scene, "visuals" | "visual">, layout = suggestedComposition(scene.visual)): VisualPlacement[] {
  const visuals = compositionVisuals(scene);
  const area = { left: [5, 12, 57, 76], right: [38, 12, 57, 76], full: [5, 8, 90, 84], bottom: [5, 54, 90, 39] }[layout];
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
export const clampImageScale = (scale = 100) => Number.isFinite(scale) ? Math.min(100, Math.max(20, scale)) : 100;
// Shared by PNG and PDF; CSS uses the same centered percentage box with contain.
export function compositionBackgroundRect(imageWidth: number, imageHeight: number, frameWidth: number, frameHeight: number, scalePercent = 100) {
  const scale = Math.min(frameWidth / imageWidth, frameHeight / imageHeight) * clampImageScale(scalePercent) / 100;
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
// One SVG is used by the live preview and PNG export, so labels and geometry match.
export function compositionOverlaySvg(scene: CompositionScene) {
  const stickers = compositionStickers(scene).map(sticker => {
    const x = sticker.x * 16, y = sticker.y * 9, w = sticker.width * 16, h = sticker.height * 9;
    const font = Math.min(34, w / 12, h / 3.7);
    const titleLength = Math.max(3, Math.floor(w / font) - 2);
    const title = Array.from(sticker.visual.title);
    const shortTitle = title.slice(0, titleLength).join("") + (title.length > titleLength ? "…" : "");
    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#fff9de" fill-opacity="0.96" stroke="#a98024" stroke-width="3" stroke-dasharray="12 7"/><g text-anchor="middle" font-family="sans-serif" fill="#433714"><text x="${x + w / 2}" y="${y + h / 2 - font * .45}" font-size="${font}" font-weight="bold">${escapeXml(sticker.label)} · ${sticker.kind}</text><text x="${x + w / 2}" y="${y + h / 2 + font * .85}" font-size="${font * .8}">${escapeXml(shortTitle)}</text></g></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${stickers}</svg>`;
}
