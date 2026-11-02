import type { NextConfig } from 'next';
const config: NextConfig = { output: "standalone", devIndicators: false, serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "mammoth", "tesseract.js", "@huggingface/transformers", "onnxruntime-node"],
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*", "./node_modules/pdfjs-dist/wasm/**/*"],
  },
};
export default config;
