// Viewer languages for video content (title, narration, subtitles).
// The app's own screens stay Korean. Selection rationale: docs/13_VIEWER_LANGUAGES.md.
// `promptName` is what the translation model is told; `script` checks its output.
export const viewerLanguages = [
  { code: "ko", label: "한국어", nativeName: "한국어", promptName: "Korean", script: "Hangul" },
  { code: "ko-easy", label: "쉬운 한국어", nativeName: "쉬운 한국어", promptName: "Easy Korean (쉬운 한국어)", script: "Hangul" },
  { code: "en", label: "영어", nativeName: "English", promptName: "English", script: "Latin" },
  { code: "vi", label: "베트남어", nativeName: "Tiếng Việt", promptName: "Vietnamese", script: "Latin" },
  { code: "zh-Hans", label: "중국어(간체)", nativeName: "简体中文", promptName: "Simplified Chinese", script: "Han" },
  { code: "si", label: "싱할라어", nativeName: "සිංහල", promptName: "Sinhala", script: "Sinhala" },
  { code: "km", label: "크메르어", nativeName: "ភាសាខ្មែរ", promptName: "Khmer", script: "Khmer" },
] as const;
export type ViewerLanguage = (typeof viewerLanguages)[number]["code"];
// Korean is the master every translation is made from.
export const localizationTargets = ["ko-easy", "en", "vi", "zh-Hans", "si", "km"] as const satisfies readonly ViewerLanguage[];
export type LocalizationTarget = (typeof localizationTargets)[number];
export const viewerLanguage = (code: ViewerLanguage) => viewerLanguages.find(language => language.code === code)!;

// Bundled fonts (public/fonts) for scripts a Korean system font lacks.
// Korean text uses the system Korean font; these cover everything else.
export const bundledFonts = [
  { family: "Inter", file: "inter-regular.ttf" },
  { family: "Noto Sans SC", file: "noto-sans-sc-regular-gb2312.otf" },
  { family: "Noto Sans Sinhala", file: "noto-sans-sinhala-regular.ttf" },
  { family: "Noto Sans Khmer", file: "noto-sans-khmer-regular.ttf" },
] as const;
