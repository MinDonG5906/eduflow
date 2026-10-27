import {
  CONTRACT_VERSION, GenerationError, MAX_OUTPUT_CHARS, SERVER_TIMEOUT_MS,
  generatedEnvelopeSchema, generatedSceneSchema, generationTask, parseGenerationResponse,
  type GeneratedScene, type GenerationInput,
} from "../generation-contract";
import { fieldLabels, manuscriptSource, type Board } from "../storyboard";
import { correctIndustrialTerms, termCorrectionNotice, type FieldTermCorrection } from "../term-corrections";
import type { PaidGenerationLimits } from "./ai-config";
import type { PdfAttachment } from "./pdf-input";
import { sourceFormat, sourceUnit, type PdfSource } from "../pdf-source";
import type { RetrievedReference } from "../knowledge";

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

const unexpectedScript = /[\u0900-\u097f]/;

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

function normalizeExactManuscriptCitation(scene: GeneratedScene, sentences: string[]): GeneratedScene {
  const evidence = cleanEvidence(scene.evidence);
  if (scene.sourceId || !evidence) return { ...scene, evidence };
  const possibleQuote = evidence.replace(/\s+\/\s+/g, " ").replace(/\s+/g, " ").trim();
  for (let start = 0; start < sentences.length; start++) {
    for (let end = start; end < sentences.length; end++) {
      const quote = sentences.slice(start, end + 1).join(" ");
      if (quote.replace(/\s+/g, " ").trim() === possibleQuote)
        return { ...scene, evidence: quote, sourceId: `sentence:${start + 1}-${end + 1}` };
      if (quote.length > possibleQuote.length) break;
    }
  }
  return { ...scene, evidence };
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
  options: { signal?: AbortSignal; timeoutMs?: number; pdf?: PdfAttachment; references?: RetrievedReference[] } = {},
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
        };
        const sentences = manuscriptSource(input.manuscript).sentences;
        const availableReferences = new Map(task.supplementalSources.map((reference) => [reference.id, reference]));
        const scenes = [...accepted.values()].sort((a, b) => a.sceneNo - b.sceneNo).map((scene) => {
          const normalizedScene = adapter.mode === "ai"
            ? input.pdfSource ? { ...scene, evidence: cleanEvidence(scene.evidence) }
              : normalizeExactManuscriptCitation(scene, sentences)
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
          const { sceneNo, referenceIds, phase, ...content } = correctedScene;
          const expectedPhase = input.scene?.phase ?? (sceneNo === 1 ? "intro" : sceneNo === expected ? "outro" : "body");
          if (phase && phase !== expectedPhase)
            warnings.push(`${sceneNo}번 장면: 도입·본문·마무리 위치를 확인해 주세요.`);
          const unknownIds = (referenceIds ?? []).filter((id) => !availableReferences.has(id));
          if (unknownIds.length)
            warnings.push(`${sceneNo}번 장면: 확인되지 않은 보강 자료 출처가 있어 제외했습니다.`);
          const references = [...new Set(referenceIds ?? [])]
            .map((id) => availableReferences.get(id)).filter((item) => item !== undefined);
          return {
            ...content,
            phase: expectedPhase,
            references,
            ...(input.pdfSource ? { pdfSource: input.pdfSource } : {}),
            id: input.scene?.id || crypto.randomUUID(),
            review: true,
            reviewReason: [adapter.mode === "demo" ? "원문 발췌 기반 데모입니다. 표현과 사실을 검토해 주세요." : "AI 생성 초안입니다. 원문의 의미와 교육 대상에 맞는 표현인지 검토해 주세요.", warning, correctionNote].filter(Boolean).join(" "),
            edited: [],
            generation: record,
          };
        });
        const duration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
        if (!input.scene && Math.abs(duration - input.settings.minutes * 60) > input.settings.minutes * 60 * 0.15)
          warnings.push("전체 예상 시간이 목표 길이의 ±15%를 벗어났습니다. 장면별 시간을 확인해 주세요.");
        const correctionNote = termCorrectionNotice(allCorrections);
        if (correctionNote) warnings.push(correctionNote);
        const board = {
          ...correctedHeader, scenes, settings: input.settings, mode: adapter.mode,
          ...(input.pdfSource ? { pdfSource: input.pdfSource } : {}),
          generation: {
            ...record, repairedScenes, warnings,
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
