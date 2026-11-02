// Viewer languages for video content (title, narration, subtitles).
// The app's own screens stay Korean. Selection rationale: docs/13_VIEWER_LANGUAGES.md.
export const viewerLanguages = [
  { code: "ko", label: "한국어", nativeName: "한국어" },
  { code: "ko-easy", label: "쉬운 한국어", nativeName: "쉬운 한국어" },
  { code: "en", label: "영어", nativeName: "English" },
  { code: "vi", label: "베트남어", nativeName: "Tiếng Việt" },
  { code: "zh-Hans", label: "중국어(간체)", nativeName: "简体中文" },
  { code: "si", label: "싱할라어", nativeName: "සිංහල" },
  { code: "km", label: "크메르어", nativeName: "ភាសាខ្មែរ" },
] as const;
export type ViewerLanguage = (typeof viewerLanguages)[number]["code"];

// Bundled fonts (public/fonts) for scripts a Korean system font lacks.
// Korean text uses the system Korean font; these cover everything else.
export const bundledFonts = [
  { family: "Inter", file: "inter-regular.ttf" },
  { family: "Noto Sans SC", file: "noto-sans-sc-regular-gb2312.otf" },
  { family: "Noto Sans Sinhala", file: "noto-sans-sinhala-regular.ttf" },
  { family: "Noto Sans Khmer", file: "noto-sans-khmer-regular.ttf" },
] as const;
