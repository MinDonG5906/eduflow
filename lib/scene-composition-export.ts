import type { Scene } from "./storyboard";
import { compositionBackgroundRect, compositionOverlaySvg } from "./scene-composition";

const imageFromUrl = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url;
});
export async function exportSceneComposition(scene: Scene, background?: Blob): Promise<Blob> {
  const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 900;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("콘티 이미지를 저장하지 못했습니다.");
  context.fillStyle = "#f5f5f6"; context.fillRect(0, 0, 1600, 900);
  if (background) {
    const url = URL.createObjectURL(background);
    try {
      const image = await imageFromUrl(url), rect = compositionBackgroundRect(image.width, image.height, 1600, 900, scene.image?.scalePercent);
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    } finally { URL.revokeObjectURL(url); }
  }
  const overlay = await imageFromUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(compositionOverlaySvg(scene))}`);
  context.drawImage(overlay, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("콘티 이미지를 저장하지 못했습니다.")), "image/png"));
}
