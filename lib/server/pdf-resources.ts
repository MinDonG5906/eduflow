import "server-only";
import { join, sep } from "node:path";

// PDF.js in Node needs explicit paths for CMaps, fonts and image decoders.
// Both Next's launcher and the standalone server run from the application root.
// next.config.ts explicitly includes these runtime assets in the distribution.
const root = join(process.cwd(), "node_modules", "pdfjs-dist");

export const pdfResources = {
  cMapUrl: join(root, "cmaps") + sep,
  cMapPacked: true,
  standardFontDataUrl: join(root, "standard_fonts") + sep,
  wasmUrl: join(root, "wasm") + sep,
};
