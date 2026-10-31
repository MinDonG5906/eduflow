import "server-only";
import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import { GenerationError, SERVER_TIMEOUT_MS } from "../generation-contract";
import type { AIConfig } from "./ai-config";
import { GEMINI_MODELS } from "./connection-store";
import type { GenerationAdapter, GenerationContext } from "./generation-service";
import type { PdfAttachment } from "./pdf-input";
import { preparePdfInput } from "./prepare-pdf";
import { geminiJsonSchema, providerTask } from "./provider-prompt";
import { citedPdfPage, selectPdfPages } from "../pdf-source";

export function assertGeminiConfig(config: AIConfig) {
  // Only pinned, priced models can run under the dollar budget.
  const pricing = GEMINI_MODELS[config.model as keyof typeof GEMINI_MODELS];
  if (!pricing) throw new GenerationError("AI_NOT_CONFIGURED");
  const micros = (usd: string) => Math.round(Number(usd) * 1_000_000);
  if (config.inputRate < micros(pricing.inputUSD) || config.outputRate < micros(pricing.outputUSD))
    throw new GenerationError("AI_NOT_CONFIGURED");
}

function request(context: GenerationContext) {
  const { instructions, responseSchema, taskText } = providerTask(context);
  const parts: Part[] = [
    ...(context.pdf ? [{ inlineData: { mimeType: "application/pdf", data: Buffer.from(context.pdf.data).toString("base64") } }] : []),
    { text: taskText },
  ];
  return { instructions, parts, schema: geminiJsonSchema(responseSchema) };
}

const REFUSED = new Set<FinishReason | undefined>([
  FinishReason.SAFETY, FinishReason.PROHIBITED_CONTENT, FinishReason.BLOCKLIST, FinishReason.SPII, FinishReason.RECITATION,
]);

function safeFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw signal.reason;
  if (error instanceof GenerationError) throw error;
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) throw new GenerationError("AI_AUTH_FAILED");
    if (error.status === 429) throw new GenerationError("RATE_LIMITED");
    if (error.status === 413) throw new GenerationError("REQUEST_TOO_LARGE");
    if (error.status === 400 || error.status === 404) throw new GenerationError("AI_NOT_CONFIGURED");
    if (error.status === 408 || error.status === 504) throw new GenerationError("TIMEOUT");
  }
  // Never include SDK messages, headers, keys, or manuscript fragments in errors.
  throw new GenerationError("PROVIDER_UNAVAILABLE");
}

export function createGeminiAdapter(config: AIConfig, options: { fetch?: typeof fetch } = {}): GenerationAdapter {
  assertGeminiConfig(config);
  const client = new GoogleGenAI({
    apiKey: config.apiKey,
    // One call per attempt: the budget ledger reserves exactly the calls this app makes.
    httpOptions: { timeout: SERVER_TIMEOUT_MS, retryOptions: { attempts: 1 }, ...(options.fetch ? { fetch: options.fetch } : {}) },
  });
  const preparedPdfs = new WeakMap<PdfAttachment, Map<string, Promise<PdfAttachment>>>();
  async function completeRequest(context: GenerationContext) {
    context.signal.throwIfAborted();
    if (!context.pdf) return request(context);
    const source = context.task.pdfSource;
    if (!source) throw new GenerationError("INVALID_PDF_PAGES");
    const cited = context.task.sceneSourceScope === "citation" ? citedPdfPage(source, context.task.selectedScene) : null;
    const pages = cited === null ? source.pages : [cited];
    const key = JSON.stringify([source.pages, pages]);
    let variants = preparedPdfs.get(context.pdf);
    if (!variants) { variants = new Map(); preparedPdfs.set(context.pdf, variants); }
    let prepared = variants.get(key);
    if (!prepared) {
      const attachment = context.pdf;
      prepared = (async () => {
        const pdf = cited === null ? attachment : { filename: attachment.filename,
          data: await selectPdfPages(attachment.data, [source.pages.indexOf(cited) + 1]) };
        return preparePdfInput(pdf, context.signal);
      })();
      variants.set(key, prepared);
    }
    const pdf = await prepared;
    context.signal.throwIfAborted();
    return request({ ...context, pdf, task: { ...context.task, pdfSource: { ...source, pages },
      sceneSourceScope: context.task.selectedScene ? cited === null ? "selection" : "citation" : undefined,
    } });
  }
  return {
    mode: "ai", model: config.model, promptVersion: "eduflow-gemini-v4-duration-target",
    billing: { kind: "metered", config },
    async countInputTokens(_, context) {
      try {
        const { instructions, parts } = await completeRequest(context);
        // The Gemini Developer API cannot count a separate system instruction, so it is
        // counted as text in front of the request instead.
        const result = await client.models.countTokens({
          model: config.model,
          contents: [{ role: "user", parts: [{ text: instructions }, ...parts] }],
          config: { abortSignal: context.signal },
        });
        if (typeof result.totalTokens !== "number") throw new GenerationError("PROVIDER_UNAVAILABLE");
        return result.totalTokens;
      } catch (error) { return safeFailure(error, context.signal); }
    },
    async generate(_, context) {
      if (!context.limits) throw new GenerationError("AI_NOT_CONFIGURED");
      context.signal.throwIfAborted();
      try {
        const { instructions, parts, schema } = await completeRequest(context);
        // Thinking tokens count toward maxOutputTokens, so the shared output cap also bounds
        // them; the low level leaves room for the storyboard itself.
        const response = await client.models.generateContent({
          model: config.model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: instructions,
            responseMimeType: "application/json",
            responseJsonSchema: schema,
            maxOutputTokens: context.limits.maxOutputTokens,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            abortSignal: context.signal,
          },
        });
        if (response.promptFeedback?.blockReason) throw new GenerationError("AI_REFUSED");
        const finish = response.candidates?.[0]?.finishReason;
        if (REFUSED.has(finish)) throw new GenerationError("AI_REFUSED");
        if (finish === FinishReason.MAX_TOKENS) throw new GenerationError("OUTPUT_TRUNCATED");
        if (finish !== FinishReason.STOP) throw new GenerationError("PROVIDER_UNAVAILABLE");
        return response.text ?? "";
      } catch (error) { return safeFailure(error, context.signal); }
    },
  };
}
