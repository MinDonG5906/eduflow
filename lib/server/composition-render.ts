import "server-only";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Scene } from "../storyboard";
import { compositionAssetRect, compositionBackgroundRect, compositionOverlaySvg, compositionPlaceholderSvg, compositionStickers, type CompositionAssets } from "../scene-composition";

export async function renderCompositionOverlay(scene: Scene, assets: CompositionAssets, titleCard = false) {
  const canvas = createCanvas(1600, 900), context = canvas.getContext("2d");
  try {
    if (titleCard) context.drawImage(await loadImage(Buffer.from(compositionPlaceholderSvg(scene))), 0, 0);
    context.drawImage(await loadImage(Buffer.from(compositionOverlaySvg(scene, assets, "sources"))), 0, 0);
    // Native SVG does not decode nested <image> data. Draw pixels at the same
    // source viewport explicitly, then restore subtitles above the pictures.
    for (const sticker of compositionStickers(scene)) {
      const uri = assets[sticker.visualId];
      if (sticker.visual.kind === "table" || !uri || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(uri)) continue;
      const image = await loadImage(Buffer.from(uri.split(",")[1], "base64"));
      const area = compositionAssetRect(sticker), fitted = compositionBackgroundRect(image.width, image.height, area.width, area.height);
      context.drawImage(image, area.x + fitted.x, area.y + fitted.y, fitted.width, fitted.height);
    }
    context.drawImage(await loadImage(Buffer.from(compositionOverlaySvg(scene, assets, "subtitle"))), 0, 0);
    return canvas.toBuffer("image/png");
  } finally { canvas.width = 1; canvas.height = 1; }
}
