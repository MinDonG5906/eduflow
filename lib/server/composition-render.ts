import "server-only";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type { Scene } from "../storyboard";
import { compositionAssetRect, compositionBackgroundRect, compositionOverlaySvg, compositionStickers, compositionSubtitle, compositionTitleCard, type CompositionAssets } from "../scene-composition";
import { canvasFont, registerCanvasFonts } from "./script-fonts";

// Title and subtitle are drawn with canvas text, not SVG text: SVG rendering
// detaches Sinhala and Khmer vowel signs and subscripts.
function drawCentered(context: SKRSContext2D, lines: string[], top: number, lineHeight: number, size: number, color: string) {
  context.fillStyle = color; context.textAlign = "center"; context.textBaseline = "alphabetic";
  lines.forEach((line, i) => { context.font = canvasFont(line, size, true); context.fillText(line, 800, top + i * lineHeight); });
}

export async function renderCompositionOverlay(scene: Scene, assets: CompositionAssets, titleCard = false) {
  registerCanvasFonts();
  const canvas = createCanvas(1600, 900), context = canvas.getContext("2d");
  try {
    if (titleCard) {
      const card = compositionTitleCard(scene);
      context.fillStyle = "#111113"; context.fillRect(0, 0, 1600, 900);
      drawCentered(context, card.lines, card.top, card.lineHeight, card.fontSize, "#fafafa");
    }
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
    const subtitle = compositionSubtitle(scene);
    if (subtitle) {
      context.globalAlpha = .9; context.fillStyle = "#111827";
      context.beginPath(); context.roundRect(subtitle.x * 16, subtitle.y * 9, subtitle.width * 16, subtitle.height * 9, 12); context.fill();
      context.globalAlpha = 1;
      drawCentered(context, subtitle.lines, subtitle.y * 9 + 18 + subtitle.fontSize, subtitle.fontSize * 1.35, subtitle.fontSize, "white");
    }
    return canvas.toBuffer("image/png");
  } finally { canvas.width = 1; canvas.height = 1; }
}
