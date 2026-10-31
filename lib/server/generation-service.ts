import {
  CONTRACT_VERSION, GenerationError, MAX_OUTPUT_CHARS, SERVER_TIMEOUT_MS,
  generatedEnvelopeSchema, generatedSceneSchema, generationTask, parseGenerationResponse,
  type GeneratedScene, type GenerationInput,
} from "../generation-contract";
import { DURATION_TOLERANCE, durationOffTarget, fieldLabels, manuscriptSource, type Board } from "../storyboard";
import { correctIndustrialTerms, termCorrectionNotice, type FieldTermCorrection } from "../term-corrections";
import type { AIConfig, PaidGenerationLimits } from "./ai-config";
import type { PdfAttachment } from "./pdf-input";
import { sourceFormat, sourceUnit, type PdfSource } from "../pdf-source";
import type { KnowledgeSearchStatus, RetrievedReference } from "../knowledge";

type Header = { title: string; summary: string; objectives: string[] };
type Issue = { path: string; reason: string };
export type GenerationContext = {
  signal: AbortSignal;
  limits?: PaidGenerationLimits;
  pdf?: PdfAttachment;
  task: ReturnType<typeof generationTask>;
  repair?: { issues: Issue[]; acceptedScenes: GeneratedScene[]; header: Header | null };
};
export type GenerationAdapter = {
  mode: Board["mode"];
  model: string;
  promptVersion: string;
  // Saved API keys reserve the dollar budget with this config. Omitted: env config.
  billing?: { kind: "metered"; config: AIConfig };
  // Count the complete provider payload before starting a paid generation.
  countInputTokens?: (input: GenerationInput, context: GenerationContext) => number | Promise<number>;
  generate: (input: GenerationInput, context: GenerationContext) => Promise<unknown>;
};

async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Scripts that never belong in Korean copy but leak into model output mid-word
// (2026-10-28 test: Arabic inside "\uc791\uc5c5"): Cyrillic, Hebrew, Arabic, Devanagari, Thai.
const unexpectedScript = /[\u0400-\u04ff\u0590-\u06ff\u0900-\u097f\u0e00-\u0e7f]/;

function inspectOutput(raw: unknown, expected: number, language: GenerationInput["settings"]["language"], mode: Board["mode"]) {
  const scenes = new Map<number, GeneratedScene>();
  const issues: Issue[] = [];
  let header: Header | null = null;
  try {
    const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (!serialized || serialized.length > MAX_OUTPUT_CHARS) throw new Error();
    const result = generatedEnvelopeSchema.safeParse(JSON.parse(serialized));
    if (!result.success) {
      issues.push(...result.error.issues.map((issue) => ({ path: issue.path.join("."), reason: issue.code })));
      return { header, scenes, issues };
    }
    const candidate = result.data;
    header = { title: candidate.title, summary: candidate.summary, objectives: candidate.objectives };
    if (candidate.scenes.length !== expected) {
      issues.push({ path: "scenes", reason: "scene_count_mismatch" });
      return { header, scenes, issues };
    }
    const counts = new Map<number, number>();
    for (const rawScene of candidate.scenes) {
      if (rawScene && typeof rawScene === "object" && "sceneNo" in rawScene && typeof rawScene.sceneNo === "number")
        counts.set(rawScene.sceneNo, (counts.get(rawScene.sceneNo) || 0) + 1);
    }
    candidate.scenes.forEach((rawScene, index) => {
      const parsed = generatedSceneSchema.safeParse(rawScene);
      if (!parsed.success) {
        issues.push(...parsed.error.issues.map((issue) => ({ path: `scenes.${index}.${issue.path.join(".")}`, reason: issue.code })));
      } else if (parsed.data.sceneNo > expected || counts.get(parsed.data.sceneNo) !== 1) {
        issues.push({ path: `scenes.${index}.sceneNo`, reason: "invalid_or_duplicate_scene_number" });
      } else if (mode === "ai" && language === "한국어" &&
        (["title", "purpose", "visual", "assets", "narration", "subtitle"] as const)
          .some((field) => unexpectedScript.test(parsed.data[field]))) {
        issues.push({ path: `scenes.${index}`, reason: "unexpected_script_in_korean_output" });
      } else scenes.set(parsed.data.sceneNo, parsed.data);
    });
  } catch {
    issues.push({ path: "response", reason: "invalid_json_or_response_size" });
  }
  return { header, scenes, issues: issues.slice(0, 50) };
}

function cleanEvidence(value: string) {
  // Models sometimes append a machine-readable locator to an otherwise verbatim quote.
  // Remove only exact locator syntax; citationWarning still verifies the quote itself.
  return value.replace(/\s*\[(?:sentence:\d+-\d+|pdf-page:\d+)\]\s*/g, " ").trim();
}

// A shorter quote could match unrelated sentences, so it is never relocated.
const MIN_RELOCATED_QUOTE_CHARS = 10;

// Model quotes are usually verbatim, but its sentence ids are not: they arrive as lists
// ("sentence:1-1, sentence:2-2"), as ranges narrower than the quote, or empty (2026-10-28
// test: 58 of 96 Korean scenes). The server locates the quote in the manuscript and keeps
// the model's id only when that range already contains the quote.
function alignManuscriptCitation(scene: GeneratedScene, sentences: string[]): GeneratedScene {
  const cleaned = cleanEvidence(scene.evidence);
  if (!cleaned) return { ...scene, evidence: cleaned };
  const compact = (value: string) => value.replace(/\s/g, "");
  const keys = sentences.map(compact);
  const stray = new RegExp(unexpectedScript.source, "g");
  const joinedSlashes = cleaned.replace(/\s+\/\s+/g, " ");
  // Try the quote as written, then without " / " joins, then without leaked foreign script
  // when the manuscript itself has none of it.
  const candidates = [cleaned, joinedSlashes,
    ...(keys.some((key) => unexpectedScript.test(key)) ? [] : [joinedSlashes.replace(stray, "")])];
  const current = /^sentence:(\d+)-(\d+)$/.exec(scene.sourceId);
  for (const evidence of [...new Set(candidates)]) {
    const quote = compact(evidence);
    if (current) {
      const start = Number(current[1]), end = Number(current[2]);
      if (start >= 1 && end >= start && end <= keys.length && keys.slice(start - 1, end).join("").includes(quote))
        return { ...scene, evidence };
    }
    if (quote.length < MIN_RELOCATED_QUOTE_CHARS) continue;
    let best: [number, number] | null = null;
    for (let start = 0; start < keys.length; start++) {
      let joined = "";
      for (let end = start; end < keys.length; end++) {
        joined += keys[end];
        if (joined.includes(quote)) {
          if (!best || end - start < best[1] - best[0]) best = [start, end];
          break;
        }
        // Past this point the quote no longer needs the first sentence of the range.
        if (joined.length - keys[start].length >= quote.length) break;
      }
    }
    if (!best) continue;
    const [start, end] = best;
    const exact = keys.slice(start, end + 1).join("") === quote;
    return { ...scene, evidence: exact ? sentences.slice(start, end + 1).join(" ") : evidence, sourceId: `sentence:${start + 1}-${end + 1}` };
  }
  return { ...scene, evidence: cleaned };
}

function citationWarning(scene: GeneratedScene, sentences: string[], pdfSource?: PdfSource): string | null {
  if (pdfSource) {
    const match = /^pdf-page:(\d+)$/.exec(scene.sourceId);
    if (!match || !pdfSource.pages.includes(Number(match[1])) || !scene.evidence)
      return `선택한 ${sourceFormat(pdfSource.name)} ${sourceUnit(pdfSource.name)}의 근거를 확인할 수 없습니다. 원본과 대조해 주세요.`;
    return `${sourceFormat(pdfSource.name)} 원본 ${match[1]}${sourceUnit(pdfSource.name)}를 근거로 한 AI 해석입니다. 인용·표·그림의 정확성을 원본과 대조해 주세요.`;
  }
  const match = /^sentence:(\d+)-(\d+)$/.exec(scene.sourceId);
  if (!match || !scene.evidence) return "원문 근거 구간을 확인할 수 없습니다. 원문과 대조해 주세요.";
  const start = Number(match[1]), end = Number(match[2]);
  if (start < 1 || end < start || end > sentences.length)
    return "원문 근거 구간을 확인할 수 없습니다. 원문과 대조해 주세요.";
  const normalize = (value: string) => value.replace(/\s/g, "");
  if (!normalize(sentences.slice(start - 1, end).join(" ")).includes(normalize(scene.evidence)))
    return "인용 내용이 지정된 원문 구간과 일치하지 않습니다. 원문과 대조해 주세요.";
  return null;
}

export async function runGeneration(
  input: GenerationInput,
  adapter: GenerationAdapter,
  options: { signal?: AbortSignal; timeoutMs?: number; pdf?: PdfAttachment; references?: RetrievedReference[]; knowledgeStatus?: KnowledgeSearchStatus } = {},
): Promise<Board> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new GenerationError("CANCELLED"));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new GenerationError("TIMEOUT")), options.timeoutMs ?? SERVER_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    if (Boolean(input.pdfSource) !== Boolean(options.pdf)) throw new GenerationError("PDF_NOT_ATTACHED");
    if (input.pdfSource && adapter.mode !== "ai") throw new GenerationError("PDF_AI_REQUIRED");
    const task = generationTask(input, options.references ?? []);
    const expected = task.requestedSceneCount;
    const accepted = new Map<number, GeneratedScene>();
    let header: Header | null = null;
    let repair: GenerationContext["repair"];
    const repairedScenes: number[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      let raw: unknown;
      try {
        raw = await abortable(controller.signal, () => adapter.generate(input, { signal: controller.signal, task, repair, ...(options.pdf ? { pdf: options.pdf } : {}) }));
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof GenerationError) throw error;
        // Provider exceptions can contain credentials or manuscript text; never expose them.
        throw new GenerationError("PROVIDER_UNAVAILABLE");
      }
      controller.signal.throwIfAborted();
      const inspected = inspectOutput(raw, expected, input.settings.language, adapter.mode);
      header ??= inspected.header;
      for (const [sceneNo, scene] of inspected.scenes) {
        if (!accepted.has(sceneNo)) {
          accepted.set(sceneNo, scene);
          if (attempt === 2) repairedScenes.push(sceneNo);
        }
      }
      if (header && accepted.size === expected) {
        const warnings: string[] = [];
        const allCorrections: FieldTermCorrection[] = [];
        const correct = (text: string, field: string, corrections: FieldTermCorrection[]) => {
          if (adapter.mode !== "ai") return text;
          const result = correctIndustrialTerms(text);
          corrections.push(...result.corrections.map((correction) => ({ ...correction, field })));
          return result.text;
        };
        const correctedHeader = {
          title: correct(header.title, "콘텐츠 제목", allCorrections),
          summary: correct(header.summary, "핵심 요약", allCorrections),
          objectives: header.objectives.map((objective) => correct(objective, "학습 목표", allCorrections)),
        };
        const record = {
          contractVersion: CONTRACT_VERSION, model: adapter.model, promptVersion: adapter.promptVersion,
          createdAt: new Date().toISOString(), attempts: attempt, mode: adapter.mode,
          ...(adapter.mode === "ai" && options.references !== undefined ? { knowledge: {
            ...(options.knowledgeStatus ? { status: options.knowledgeStatus } : {}),
            retrievedCount: task.supplementalSources.length,
            documentCount: new Set(task.supplementalSources.map(reference => reference.documentId)).size,
          } } : {}),
        };
        const sentences = manuscriptSource(input.manuscript).sentences;
        const availableReferences = new Map(task.supplementalSources.map((reference) => [reference.id, reference]));
        const relabeledScenes: number[] = [];
        const scenes = [...accepted.values()].sort((a, b) => a.sceneNo - b.sceneNo).map((scene) => {
          const normalizedScene = adapter.mode === "ai"
            ? input.pdfSource ? { ...scene, evidence: cleanEvidence(scene.evidence),
              // Never turn an out-of-selection/printed folio into a guessed file page.
              sourceId: task.pdfCitationIds?.includes(scene.sourceId) ? scene.sourceId : "" }
              : alignManuscriptCitation(scene, sentences)
            : scene;
          const warning = citationWarning(normalizedScene, sentences, input.pdfSource);
          if (warning) warnings.push(`${scene.sceneNo}번 장면: ${warning}`);
          const correctedScene = { ...normalizedScene };
          const corrections: FieldTermCorrection[] = [];
          for (const field of ["title", "purpose", "visual", "assets", "narration", "subtitle"] as const)
            correctedScene[field] = correct(scene[field], fieldLabels[field], corrections);
          allCorrections.push(...corrections);
          const correctionNote = termCorrectionNotice(corrections);
          // Evidence and source IDs are never spelling-corrected: preserve citations.
          const { sceneNo, referenceIds, visualReferenceIds, phase, ...content } = correctedScene;
          const expectedPhase = input.scene?.phase ?? (sceneNo === 1 ? "intro" : sceneNo === expected ? "outro" : "body");
          // The phase follows the scene position; a different model label is reported once below.
          if (phase && phase !== expectedPhase) relabeledScenes.push(sceneNo);
          const unknownIds = [...(referenceIds ?? []), ...(visualReferenceIds ?? [])].filter((id) => !availableReferences.has(id));
          if (unknownIds.length)
            warnings.push(`${sceneNo}번 장면: 확인되지 않은 보강·시각자료 출처가 있어 제외했습니다.`);
          const references = [...new Set(referenceIds ?? [])]
            .map((id) => availableReferences.get(id)).filter((item) => item !== undefined);
          const visualReferences = [...new Set(visualReferenceIds ?? [])]
            .map(id => availableReferences.get(id)).filter((item): item is RetrievedReference => item !== undefined && Boolean(item.visuals?.length));
          const visuals = [...new Map([...references, ...visualReferences].flatMap(reference => reference.visuals ?? [])
            .map(visual => [`${visual.documentId}:${visual.page}:${visual.figureId}`, visual])).values()].slice(0, 20);
          return {
            ...content,
            phase: expectedPhase,
            references,
            visualReferences,
            visuals,
            ...(input.pdfSource ? { pdfSource: input.pdfSource } : {}),
            id: input.scene?.id || crypto.randomUUID(),
            review: true,
            reviewReason: [adapter.mode === "demo" ? "원문 발췌 기반 데모입니다. 표현과 사실을 검토해 주세요." : "AI 생성 초안입니다. 원문의 의미와 교육 대상에 맞는 표현인지 검토해 주세요.", warning, correctionNote].filter(Boolean).join(" "),
            edited: [],
            generation: record,
          };
        });
        if (relabeledScenes.length)
          warnings.push(`${relabeledScenes.join(", ")}번 장면의 구성 단계(도입·본문·마무리)를 장면 위치에 맞게 바꿨습니다. 내용이 위치에 맞는지 확인해 주세요.`);
        const duration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
        if (!input.scene && durationOffTarget(duration, input.settings.minutes))
          warnings.push(`전체 예상 시간이 목표 길이의 ±${DURATION_TOLERANCE * 100}%를 벗어났습니다. 장면별 시간을 확인해 주세요.`);
        const correctionNote = termCorrectionNotice(allCorrections);
        if (correctionNote) warnings.push(correctionNote);
        const board = {
          ...correctedHeader, scenes, settings: input.settings, mode: adapter.mode,
          ...(input.pdfSource ? { pdfSource: input.pdfSource } : {}),
          generation: {
            ...record, repairedScenes, warnings,
            ...(record.knowledge ? { knowledgeSources: task.supplementalSources } : {}),
          },
        };
        return parseGenerationResponse(board, input);
      }
      repair = structuredClone({
        issues: inspected.issues.length ? inspected.issues : [{ path: "scenes", reason: "missing_required_scenes" }],
        acceptedScenes: [...accepted.values()],
        header,
      });
    }
    throw new GenerationError("INVALID_OUTPUT");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
