import "server-only";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { KnowledgeBase } from "./knowledge-base";
import { ValidationStore } from "./knowledge-validation-store";
import { checkValidationPage, publishValidation, skipExhaustedValidationPage, sourceFingerprint } from "./knowledge-validation-service";
import { knowledgeVisionConfig } from "./knowledge-vision";
import { LocalAIBudget } from "./ai-budget";
import { isProcessedPage, exhaustedValidationPage, validationCompletionReason, VALIDATION_RETRYABLE_ERRORS, type ValidationJob, type ValidationRun } from "../knowledge-validation";

export function enqueueRun(id: string, directory: string) {
  const store = new ValidationStore(directory);
  try { return store.enqueue(id); } finally { store.close(); }
}

export async function enqueueExisting(ids: string[], directory: string) {
  const base = new KnowledgeBase(directory), store = new ValidationStore(directory);
  try {
    const documents = base.list();
    const managed = new Set(store.list().map(run => run.localDocumentId));
    const results: { documentId: string; runId?: string; error?: string }[] = [];
    for (const id of [...new Set(ids)].slice(0, 50)) {
      const doc = documents.find(doc => doc.id === id);
      if (!doc?.hasFile || managed.has(id)) { results.push({ documentId: id, error: "원본 PDF가 있는 일반 등록 자료를 선택해 주세요." }); continue; }
      const fingerprint = sourceFingerprint(base, id);
      const previous = store.list().find(run => run.sourceDocumentId === id && run.sourceFingerprint === fingerprint && !run.quarantine);
      if (previous) { store.enqueue(previous.id); results.push({ documentId: id, runId: previous.id }); continue; }
      const pdf = base.pdf(id)!;
      const total = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
      if (total > 200) { results.push({ documentId: id, error: "200쪽을 넘는 자료는 나누어 등록해 주세요." }); continue; }
      const structures = base.structures(id), reviews = base.reviewPages(id);
      const filePages: Record<number, number> = {};
      for (let filePage = 1; filePage <= total; filePage++) {
        const original = structures.find(page => page.filePage === filePage)?.page ?? reviews.find(page => page.filePage === filePage)?.page ?? filePage;
        if (reviews.some(page => page.page === original && page.status === "excluded")) continue;
        if (filePages[original]) throw new Error("원본 페이지 대응이 중복됩니다. 자료를 다시 등록해 주세요.");
        filePages[original] = filePage;
      }
      if (!Object.keys(filePages).length) { results.push({ documentId: id, error: "처리할 페이지가 없습니다. 모든 페이지가 검색에서 제외되어 있습니다." }); continue; }
      const run = store.create({ title: doc.title, origin: doc.origin, ...(doc.url ? { url: doc.url } : {}), published: doc.published, revision: doc.revision }, pdf, Object.keys(filePages).map(Number));
      const token = store.claim(run.id);
      try {
        Object.assign(run, { sourceDocumentId: id, sourceFingerprint: fingerprint, filePages });
        store.save(run, token);
      } finally { store.release(run.id, token); }
      store.enqueue(run.id); results.push({ documentId: id, runId: run.id });
    }
    return results;
  } finally { store.close(); base.close(); }
}

export type QueueDependencies = {
  check: typeof checkValidationPage; publish: typeof publishValidation;
  availability: (directory: string) => { ready: boolean; nextAt: number; reason: string };
};
const defaults: QueueDependencies = {
  check: checkValidationPage, publish: publishValidation,
  availability: directory => {
    const budget = new LocalAIBudget(directory);
    try { return budget.availability(knowledgeVisionConfig(directory)); } finally { budget.close(); }
  },
};
const unfinished = (run: ValidationRun) => run.pages.find(page => !isProcessedPage(page) && page.status !== "skipped");

/** Called by the single leased worker. One page per tick, with durable checkpoints. */
export async function processValidationQueue(directory: string, dependencies = defaults, now = Date.now()) {
  const store = new ValidationStore(directory);
  try {
    const job = store.jobs().find(job => ["queued", "processing", "waiting"].includes(job.state) && job.nextAt <= now);
    if (!job) return false;
    const finish = (state: ValidationJob["state"], reason: string, nextAt = 0) => {
      if (store.job(job.runId)?.state === "paused") return;
      store.putJob({ ...job, state, reason, nextAt, updatedAt: new Date().toISOString() });
    };
    let run = store.get(job.runId);
    if (!run || run.quarantine) { finish("blocked", "자료가 없거나 추가 검사로 격리됐습니다."); return true; }
    if (run.status === "published") { finish("complete", validationCompletionReason(run)); return true; }
    const page = unfinished(run);
    if (page) {
      if (exhaustedValidationPage(page, job.retrySince)) {
        // Legacy blocked pages must advance without reserving capacity or making a fourth call.
        try { run = skipExhaustedValidationPage(run.id, page.page, directory); }
        catch { finish("blocked", "실패 페이지 기록을 보존하지 못했습니다. 다시 시작해 주세요."); return true; }
      } else {
        // Reuse saved drafts without waiting for capacity for a call we will not make.
        let availability = { ready: true, nextAt: 0, reason: "" };
        try { if (!page.attempts.at(-1)?.candidate) availability = dependencies.availability(directory); }
        catch { finish("blocked", "모델 연결·비용 설정을 확인한 뒤 다시 시작해 주세요."); return true; }
        if (!availability.ready) { finish(availability.nextAt ? "waiting" : "blocked", availability.reason, availability.nextAt); return true; }
        finish("processing", `${page.page}쪽 자동 판독 중`);
        try { run = await dependencies.check(run.id, page.page, directory, AbortSignal.timeout(180000)); }
        catch { finish("blocked", "자동 판독 상태를 확인하지 못했습니다. 기록을 보존하고 멈췄습니다."); return true; }
        if (store.job(job.runId)?.state === "paused") return true;
        const checked = run.pages.find(item => item.page === page.page)!;
        const last = checked.attempts.at(-1)!;
        if (exhaustedValidationPage(checked, job.retrySince)) {
          try { run = skipExhaustedValidationPage(run.id, page.page, directory); }
          catch { finish("blocked", "실패 페이지 기록을 보존하지 못했습니다. 다시 시작해 주세요."); return true; }
        } else if (last.errorCode) {
          if (["RATE_LIMITED", "BUDGET_EXCEEDED"].includes(last.errorCode)) {
            const next = dependencies.availability(directory);
            finish("waiting", next.reason || "호출 가능 시간에 자동 재개", next.nextAt || now + 60000);
          } else if ([...VALIDATION_RETRYABLE_ERRORS, "CANCELLED"].includes(last.errorCode) &&
            run.pages.find(item => item.page === page.page)!.attempts.filter(item => [...VALIDATION_RETRYABLE_ERRORS, "CANCELLED"].includes(item.errorCode ?? "") && (!job.retrySince || item.at >= job.retrySince)).length < 3 &&
            run.pages.find(item => item.page === page.page)!.attempts.reduce((sum, item) => sum + (item.calls ?? 0), 0) < 3) {
            finish("waiting", `${last.reasons[0] || "페이지 판독에 실패했습니다."} · 잠시 후 자동 재시도`, now + 60000);
          } else finish("blocked", last.reasons[0] || "실행 환경 확인이 필요합니다.");
          return true;
        }
      }
      if (unfinished(run)) { finish("queued", "다음 페이지 판독 대기"); return true; }
    }
    if (store.job(job.runId)?.state === "paused") return true;
    if (run.pages.some(isProcessedPage)) {
      finish("processing", "판독한 내용을 검색에 저장 중");
      try { await dependencies.publish(run.id, directory, AbortSignal.timeout(180000)); }
      catch { finish("blocked", "판독 결과는 보존했습니다. 검색 저장소 또는 원본 변경을 확인하고 저장을 재개해 주세요."); return true; }
    }
    finish("complete", validationCompletionReason(run));
    return true;
  } finally { store.close(); }
}

/** Local desktop worker survives browser closure; no OS startup service is installed. */
export function ensureValidationWorker(directory: string) {
  const store = new ValidationStore(directory);
  try {
    if (store.workerAlive() || !store.jobs().some(job => ["queued", "processing", "waiting"].includes(job.state))) return;
  } finally { store.close(); }
  const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", join(process.cwd(), "scripts/knowledge-validation-worker.ts")], {
    cwd: process.cwd(), env: { ...process.env, EDUFLOW_VALIDATION_DIRECTORY: directory }, detached: true, stdio: "ignore",
  });
  child.on("error", () => {}); child.unref();
}
