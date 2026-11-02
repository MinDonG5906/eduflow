export type StudioView = "input" | "board";
export type StudioModal = "new" | "export" | "help" | "regenerate" | "delete" | null;
export type GeneratorStatus = {
  mode: "demo" | "ai";
  available: boolean;
  label: string;
  // Who receives the manuscript when generating; null in demo mode.
  vendor: "OpenAI" | "Anthropic" | "Google" | null;
} | null;
export type ExportFormat = "md" | "copy" | "pdf" | "srt" | "vtt";
// Which language to export, and for translations whether subtitles also show the Korean line.
export type ExportOptions = { language: import("@/lib/languages").ViewerLanguage; subtitles: import("@/lib/localization").SubtitleMode };
