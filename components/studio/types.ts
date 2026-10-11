export type StudioView = "input" | "board";
export type StudioModal = "new" | "export" | "help" | "regenerate" | "delete" | null;
export type GeneratorStatus = { mode: "demo" | "ai"; available: boolean } | null;
export type ExportFormat = "md" | "csv" | "copy";
