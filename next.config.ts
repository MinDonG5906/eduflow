import type { NextConfig } from 'next';
const config: NextConfig = { output: "standalone", devIndicators: false, serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "mammoth", "tesseract.js"] };
export default config;
