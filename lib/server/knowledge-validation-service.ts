import "server-only";
import { processedStructure, isProcessedPage, validationCandidateSchema, type ValidationRun } from "../knowledge-validation";
import { structureChunks } from "../knowledge-structure";
import { selectPdfPages } from "../pdf-source";
import { knowledgePageImage, knowledgeVisionConfig } from "./knowledge-vision";
import { correctSource } from "./knowledge-source-check";
import { parseWithParseFixer } from "./knowledge-services";
import { contentHash, ValidationStore } from "./knowledge-validation-store";
import { KnowledgeBase } from "./knowledge-base";
import { OPENAI_MODEL } from "./openai-adapter";
import { analyzeKnowledgePdf } from "./knowledge-ingest";
import { knowledgeIndex, knowledgeMode } from "./knowledge-backend";
import type { SearchIndex } from "./knowledge-local-index";
import { GenerationError } from "../generation-contract";

export type ValidationDependencies = {
  image: typeof knowledgePageImage; config: typeof knowledgeVisionConfig; parse: typeof parseWithParseFixer;
  correct: typeof correctSource;
};
const defaults: ValidationDependencies = { image: knowledgePageImage, config: knowledgeVisionConfig,
  parse: parseWithParseFixer, correct: correctSource };
class PageCallLimit extends Error {}

export function sourceFingerprint(base: KnowledgeBase, id: string) {
  const doc = base.list().find(doc => doc.id === id);
  if (!doc) throw new Error("원본 자료가 삭제됐습니다.");
  return contentHash(JSON.stringify({ id, title: doc.title, origin: doc.origin, url: doc.url,
    published: doc.published, revision: doc.revision, sha256: doc.sha256, structures: base.structures(id) }));
}

/** One page per request keeps cancellation and progress visible. Passed pages are immutable. */
export async function checkValidationPage(id: string, pageNumber: number, directory: string, signal: AbortSignal,
  dependencies: ValidationDependencies = defaults) {
  const store = new ValidationStore(directory); let token: string | undefined;
  try {
    token = store.claim(id);
    const run = store.get(id)!;
    if (run.quarantine) throw new Error("추가 검사에서 보류된 판본입니다. 원본을 새 자료로 등록해 주세요.");
    if (run.status === "published" || run.localDocumentId) throw new Error("검색 반영을 시작한 자료는 검사 내용을 변경할 수 없습니다.");
    const page = run.pages.find(page => page.page === pageNumber);
    if (!page) throw new Error("선택한 페이지를 찾지 못했습니다.");
    if (isProcessedPage(page) || page.status === "skipped") return run;
    const previous = page.attempts.at(-1);
    const attempt: typeof page.attempts[number] = { at: new Date().toISOString(), reasons: [], model: OPENAI_MODEL, calls: 0, policy: "single-pass" };
    page.attempts.push(attempt);
    store.save(run, token);
    let calling = false;
    const call = async <T,>(operation: () => Promise<T>): Promise<T> => {
      if (page.attempts.filter(item => item.policy === "single-pass").reduce((sum, item) => sum + (item.calls ?? 0), 0) >= 3) throw new PageCallLimit();
      attempt.calls!++; calling = true; store.save(run, token!);
      const result = await operation(); calling = false; return result;
    };
    try {
      // Existing extraction drafts can be consumed without another paid call, even if
      // the removed verification step previously held them. Preserve the old attempt.
      if (previous?.candidate && validationCandidateSchema.safeParse(previous.candidate).success) {
        Object.assign(attempt, { candidate: previous.candidate, imageHash: previous.imageHash,
          parserCommit: previous.parserCommit, initial: previous.initial, parsed: previous.parsed, phase: "correct" });
      } else {
        const config = dependencies.config(directory);
        attempt.phase = "render";
        const filePage = run.filePages?.[pageNumber] ?? pageNumber;
        const image = await dependencies.image(store.pdf(id), filePage, signal);
        attempt.imageHash = contentHash(image);
        attempt.phase = "parse";
        const parsed = dependencies === defaults && knowledgeMode() === "local"
          ? await (async () => {
            const result = await analyzeKnowledgePdf(store.pdf(id), String(filePage), signal);
            const initial = result.pages[0].text;
            return { commit: "pdf-parse-2.4.5+tesseract-7.0.0", initial, markdown: initial };
          })()
          : await dependencies.parse(image, signal);
        attempt.parserCommit = parsed.commit; attempt.initial = parsed.initial; attempt.parsed = parsed.markdown;
        attempt.phase = "correct";
        attempt.candidate = validationCandidateSchema.parse(await call(() => dependencies.correct(parsed.markdown, image, config, directory, signal)));
      }
      store.save(run, token);
      signal.throwIfAborted();
    } catch (error) {
      // Never leak keys, model responses or internal service URLs through errors.
      if (calling && error instanceof GenerationError && ["RATE_LIMITED", "BUDGET_EXCEEDED", "TOKEN_LIMIT_EXCEEDED", "AI_NOT_CONFIGURED", "AI_DISABLED", "BUDGET_UNAVAILABLE"].includes(error.code)) attempt.calls!--;
      attempt.errorCode = signal.aborted ? "CANCELLED" : error instanceof PageCallLimit ? "PAGE_CALL_LIMIT" : error instanceof GenerationError ? error.code : "CHECK_FAILED";
      attempt.reasons = [error instanceof PageCallLimit ? "이 페이지의 자동 호출 한도(실패 재시도 포함 최대 3회)에 도달했습니다. 추가 유료 호출을 멈췄습니다." : signal.aborted ? "판독이 중단됐습니다. 이어서 처리할 수 있습니다." : error instanceof GenerationError
        ? `판독을 완료하지 못했습니다. ${error.message}` : "판독을 완료하지 못했습니다. 서버 연결·모델 연결·비용 한도를 확인해 주세요."];
    }
    page.status = attempt.errorCode ? "held" : attempt.candidate && (attempt.candidate.text.trim() || attempt.candidate.tables.length || attempt.candidate.figures.length) ? "processed" : "skipped";
    store.save(run, token);
    return run;
  } finally { if (token) store.release(id, token); store.close(); }
}

/** Remote chunks are never made searchable until every checked chunk has been written.
 * The app additionally uses a local committed allowlist, so orphan/partial remote writes stay invisible. */
export async function publishValidation(id: string, directory: string, signal: AbortSignal, client: SearchIndex = knowledgeIndex(directory)) {
  const store = new ValidationStore(directory); const base = new KnowledgeBase(directory); let token: string | undefined;
  try {
    token = store.claim(id); const run = store.get(id)!;
    if (run.quarantine) throw new Error("추가 검사에서 보류된 자료는 반영할 수 없습니다.");
    // Re-evaluate recorded candidates under the current structural rules, including old publications.
    for (const page of run.pages.filter(isProcessedPage)) processedStructure(page, 1);
    if (run.status === "published") return run;
    if (run.pages.some(page => page.status === "pending")) throw new Error("페이지 판독이 끝난 뒤 저장합니다.");
    if (run.pages.some(page => !isProcessedPage(page) && page.attempts.at(-1)?.errorCode)) throw new Error("연결·한도 대기 중인 판독이 끝난 뒤 반영합니다.");
    const passed = run.pages.filter(isProcessedPage);
    if (!passed.length) throw new Error("저장할 판독 내용이 없습니다.");
    const structures = passed.map((page, i) => processedStructure(page, i + 1));
    const assertSource = () => {
      if (run.sourceDocumentId && sourceFingerprint(base, run.sourceDocumentId) !== run.sourceFingerprint)
        throw new Error("판독 중 원본 내용이 변경됐습니다. 변경된 자료를 새로 자동 처리해 주세요.");
    };
    assertSource();
    if (run.backendIdentity && run.backendIdentity !== client.identity) throw new Error("처음 반영을 시작한 검색 저장소로 연결해 주세요.");
    run.backendIdentity = client.identity;
    if (!run.localDocumentId) {
      const pdf = Buffer.from(await selectPdfPages(store.pdf(id), passed.map(page => run.filePages?.[page.page] ?? page.page)));
      signal.throwIfAborted();
      const doc = base.addImported(run.metadata, run.sha256, pdf, structures.map(structure => ({
        page: structure.page, text: structure.text, method: "ocr" as const, confidence: null,
        reviewReason: "", needsReview: false, structure,
      })), false);
      run.localDocumentId = doc.id; store.save(run, token);
    }
    const local = base.list().find(doc => doc.id === run.localDocumentId);
    if (!local) throw new Error("반영할 자료가 삭제됐습니다. 원본을 다시 등록해 주세요.");
    // An incomplete publish must never overwrite later user edits or activate a changed document.
    const current = base.structures(local.id);
    if (JSON.stringify(current) !== JSON.stringify(structures)) throw new Error("판독 후 내용이 변경됐습니다. 새 자료로 등록해 주세요.");
    if (!run.remoteDocumentId) {
      run.remoteDocumentId = await client.create(`eduflow-${run.id}.txt`, signal);
      store.save(run, token);
    }
    await client.enabled(run.remoteDocumentId, false, signal);
    run.remoteChunks ??= [];
    for (const structure of structures) for (const chunk of structureChunks(structure)) {
      const hash = contentHash(JSON.stringify(structure));
      if (run.remoteChunks.some(saved => saved.page === structure.page && saved.text === chunk.text &&
        JSON.stringify(saved.blockIds) === JSON.stringify(chunk.blockIds) && saved.structureHash === hash)) continue;
      const chunkId = await client.addChunk(run.remoteDocumentId, chunk.text, signal);
      run.remoteChunks.push({ id: chunkId, page: structure.page, text: chunk.text, blockIds: chunk.blockIds, structureHash: hash });
      store.save(run, token);
    }
    await client.enabled(run.remoteDocumentId, true, signal);
    signal.throwIfAborted();
    // Staged runs are blocked by retrieval even if activation precedes the final commit.
    if (run.sourceDocumentId && !run.testOnly) base.activateReplacement(local.id, run.sourceDocumentId, assertSource);
    else base.setActive(local.id, !run.testOnly);
    run.status = "published"; store.save(run, token);
    return run;
  } finally { if (token) store.release(id, token); base.close(); store.close(); }
}

export function validationSummary(run: ValidationRun) {
  return { ...run, remoteChunks: undefined, pages: run.pages.map(page => ({ ...page, attempts: page.attempts.map(attempt => ({ ...attempt,
    initial: undefined, parsed: undefined, candidate: undefined, verdict: undefined })) })) };
}
