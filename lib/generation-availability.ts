import type { GeneratorStatus } from "@/components/studio/types";

// Client-side eligibility only; server generation and admission checks stay separate.
export function canStartGeneration({ generator, isPdf, valid, ready, busy, importing, documentPending, keyword, storageBlocked }: {
  generator: GeneratorStatus;
  isPdf: boolean;
  valid: boolean;
  ready: boolean;
  busy: boolean;
  importing: boolean;
  documentPending: boolean;
  keyword: string;
  storageBlocked: boolean;
}): boolean {
  return Boolean(generator?.available && (!isPdf || generator.mode === "ai") && valid && ready && !busy && !importing && !documentPending && !keyword.trim() && !storageBlocked);
}
