import type { NextConfig } from 'next';
const config: NextConfig = { devIndicators: false, serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "mammoth"] };
export default config;
