export type StudioView = "input" | "board";
export type StudioModal = "new" | "export" | "help" | "regenerate" | "delete" | null;
export type GeneratorStatus = {
  mode: "demo" | "ai";
  available: boolean;
  label: string;
  // Who receives the manuscript when generating; null in demo mode.
  vendor: "OpenAI" | "Anthropic" | "Google" | null;
} | null;
export type ExportFormat = "md" | "csv" | "copy";
