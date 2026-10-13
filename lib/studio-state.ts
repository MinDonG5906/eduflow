import { z } from "zod";
import { boardSchema, requestSchema, settingsSchema, type Board } from "./storyboard";
import { documentSchema } from "./documents";

const draftSchema = z.object({
  manuscript: z.string(),
  settings: settingsSchema,
  board: boardSchema.nullish().transform((board) => board ?? null),
  document: documentSchema.optional(),
});
export type Draft = z.infer<typeof draftSchema>;

export const DRAFT_STORAGE_KEY = "frame-studio-v1";
export const RETIRED_EXAMPLE_BACKUP_KEY = "eduflow-retired-hunmin-backup-v1";
const RETIRED_EXAMPLE_CLEANUP_KEY = "eduflow-retired-hunmin-cleanup-v1";
const retiredSceneTitles = [
  "한자의 장벽", "말하고 싶어도 쓰기 어려운 현실", "세종의 문제의식", "새 문자 창제의 시작",
  "완성과 반포", "소리의 원리를 담은 문자", "하늘·땅·사람의 모음", "조합과 확장성",
  "백성의 기록 수단이 되다", "지식의 확산", "새 문자에서 공공 자산으로", "오늘의 한글과 기록유산",
];

function isRetiredExample(board: Board | null) {
  return board?.title.trim() === "훈민정음, 백성을 위한 새로운 문자" &&
    board.scenes.length === retiredSceneTitles.length &&
    board.scenes.every((scene, i) => scene.title.trim() === retiredSceneTitles[i]);
}

// Retire the old example once; preserve the user's current input and a recoverable copy.
export function restoreBrowserDraft(raw: string | null, storage: Pick<Storage, "getItem" | "setItem">) {
  const draft = raw === null ? null : readDraft(raw);
  if (storage.getItem(RETIRED_EXAMPLE_CLEANUP_KEY) === "done")
    return { draft, removedExample: false };
  const removedExample = Boolean(draft && isRetiredExample(draft.board));
  if (draft && removedExample) {
    // If backup or replacement fails, the caller keeps automatic saving blocked.
    if (storage.getItem(RETIRED_EXAMPLE_BACKUP_KEY) === null)
      storage.setItem(RETIRED_EXAMPLE_BACKUP_KEY, raw!);
    draft.board = null;
    storage.setItem(DRAFT_STORAGE_KEY, serializeDraft(draft));
  }
  // The cleaned draft is already durable. A marker failure must not discard a valid input.
  try { storage.setItem(RETIRED_EXAMPLE_CLEANUP_KEY, "done"); } catch { /* Retry the marker on a later opening. */ }
  return { draft, removedExample };
}

export function readDraft(raw: string): Draft {
  const draft = draftSchema.parse(JSON.parse(raw));
  const legacy = draft.settings.audience;
  if (["초등 저학년", "초등 고학년", "중고등학생", "대학생/일반인"].includes(legacy))
    draft.settings.audience = "현장 방문자 · 일반인";
  else if (legacy === "실무자/전문가") draft.settings.audience = "산업현장 근무자";
  return draft;
}

export function serializeDraft(draft: Draft): string {
  return JSON.stringify(draftSchema.parse(draft));
}

export function normalizeDuration(value: string): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.min(600, Math.max(1, Math.round(seconds))) : 1;
}

export type GenerationJob = {
  input: z.infer<typeof requestSchema>;
  previousBoard: Board | null;
  pdf?: Blob;
};

export function captureGeneration(input: GenerationJob["input"], board: Board | null, pdf?: Blob): GenerationJob {
  // Keep both the request and its replacement target independent of later edits.
  return { ...structuredClone({ input, previousBoard: board }), ...(pdf ? { pdf } : {}) };
}

export function retryConflict(job: GenerationJob, board: Board | null): string | null {
  const original = job.input.scene;
  if (original) {
    const current = board?.scenes.find((scene) => scene.id === original.id);
    if (!current) return "재시도할 장면이 삭제되었습니다. 다시 생성할 장면을 선택해 주세요.";
    if (JSON.stringify(current) !== JSON.stringify(original))
      return "재시도할 장면이 수정되었습니다. 현재 내용을 확인한 뒤 장면 재생성을 다시 요청해 주세요.";
  } else if (JSON.stringify(board) !== JSON.stringify(job.previousBoard)) {
    return "스토리보드가 수정되었습니다. 현재 내용을 확인한 뒤 전체 생성을 다시 요청해 주세요.";
  }
  return null;
}
