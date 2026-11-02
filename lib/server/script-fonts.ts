import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { bundledFonts } from "../languages";
import { officeFontCandidates } from "./office-fonts";

export const KOREAN_FAMILY = "EduFlow Korean";
const fontDirectory = () => join(process.cwd(), "public", "fonts");
let registered = false;

export function bundledFontBytes(file: string) {
  return readFileSync(join(fontDirectory(), file));
}

// Canvas falls back across this family list glyph by glyph and shapes complex
// scripts correctly, unlike SVG text and pdf-lib. Registration happens once.
export function registerCanvasFonts() {
  if (registered) return;
  registered = true;
  for (const font of bundledFonts) {
    try { GlobalFonts.register(bundledFontBytes(font.file), font.family); }
    catch { /* A missing bundled font only loses that script. */ }
  }
  if (!GlobalFonts.has(KOREAN_FAMILY)) {
    for (const file of officeFontCandidates().filter(file => !file.endsWith(".ttc"))) {
      try { GlobalFonts.register(readFileSync(file), KOREAN_FAMILY); break; }
      catch { /* Try the next installed Korean font. */ }
    }
  }
}

// Latin text without Hangul uses Inter first so a Vietnamese word is not split
// between the Korean font's Latin glyphs and Inter's accented ones.
export function canvasFont(text: string, size: number, bold = false) {
  const families = /\p{Script=Hangul}/u.test(text)
    ? [KOREAN_FAMILY, "Apple SD Gothic Neo", "Malgun Gothic", "Inter"]
    : ["Inter", KOREAN_FAMILY, "Apple SD Gothic Neo", "Malgun Gothic"];
  return `${bold ? "bold " : ""}${size}px ${[...families, "Noto Sans SC", "Noto Sans Sinhala", "Noto Sans Khmer"].map(family => `"${family}"`).join(", ")}, sans-serif`;
}

const measureContext = createCanvas(1, 1).getContext("2d");
export function measureCanvasText(text: string, size: number, bold = false) {
  registerCanvasFonts();
  measureContext.font = canvasFont(text, size, bold);
  return measureContext.measureText(text).width;
}
