import "server-only";
import OpenAI from "openai";
import { GenerationError, SERVER_TIMEOUT_MS } from "../generation-contract";
import type { AIConfig } from "./ai-config";
import type { GenerationAdapter, GenerationContext } from "./generation-service";
import type { PdfContent } from "./pdf-content";
import { createDocumentPreparer, providerTask } from "./provider-prompt";
import { verificationPrompt } from "./generation-grounding";

export const OPENAI_MODEL = "gpt-5.4-mini-2026-03-17";

export function assertOpenAIConfig(config: AIConfig) {
  // A pinned, priced model prevents an unpriced model change from bypassing the cap.
  if (config.model !== OPENAI_MODEL || config.inputRate < 750000 || config.outputRate < 4500000)
    throw new GenerationError("AI_NOT_CONFIGURED");
}

function payload(context: GenerationContext, document?: PdfContent) {
  if (context.verification) {
    const verification = verificationPrompt(context.verification);
    return { model: OPENAI_MODEL, instructions: verification.instructions, input: verification.taskText,
      reasoning: { effort: "none" as const },
      text: { format: { type: "json_schema" as const, name: "eduflow_evidence", strict: true, schema: verification.responseSchema } } };
  }
  const { instructions, responseSchema, taskText } = providerTask(context, document);
  return {
    model: OPENAI_MODEL,
    instructions,
    input: document && (document.pdf || document.images.length) ? [{ role: "user" as const, content: [
      ...(document.pdf ? [{ type: "input_file" as const, filename: document.pdf.filename, detail: "high" as const, file_data: `data:application/pdf;base64,${Buffer.from(document.pdf.data).toString("base64")}` }] : []),
      { type: "input_text" as const, text: taskText },
      ...document.images.flatMap(image => [
        { type: "input_text" as const, text: image.id },
        { type: "input_image" as const, detail: "high" as const, image_url: `data:image/png;base64,${Buffer.from(image.data).toString("base64")}` },
      ]),
    ] }] : taskText,
    reasoning: { effort: "none" as const },
    text: { format: { type: "json_schema" as const, name: "eduflow_storyboard", strict: true, schema: responseSchema } },
  };
}

function safeFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw signal.reason;
  if (error instanceof GenerationError) throw error;
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403 || error.code === "insufficient_quota" || error.type === "insufficient_quota")
      throw new GenerationError("AI_AUTH_FAILED");
    if (error.status === 429) throw new GenerationError("RATE_LIMITED");
    if (error.status === 400 || error.status === 404) throw new GenerationError("AI_NOT_CONFIGURED");
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) throw new GenerationError("TIMEOUT");
  // Never include SDK messages, headers, keys, or manuscript fragments in errors.
  throw new GenerationError("PROVIDER_UNAVAILABLE");
}

export function createOpenAIAdapter(config: AIConfig, options: { fetch?: typeof fetch } = {}): GenerationAdapter {
  assertOpenAIConfig(config);
  const client = new OpenAI({
    apiKey: config.apiKey, baseURL: "https://api.openai.com/v1",
    maxRetries: 0, timeout: SERVER_TIMEOUT_MS, logLevel: "off",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const prepareDocument = createDocumentPreparer();
  async function completePayload(context: GenerationContext) {
    const prepared = await prepareDocument(context);
    return payload(prepared.context, prepared.document);
  }
  return {
    mode: "ai", model: OPENAI_MODEL, promptVersion: "eduflow-openai-v20-evidence-applicability",
    async countInputTokens(_, context) {
      try {
        const result = await client.responses.inputTokens.count(await completePayload(context), { signal: context.signal });
        return result.input_tokens;
      } catch (error) { return safeFailure(error, context.signal); }
    },
    async generate(_, context) {
      if (!context.limits) throw new GenerationError("AI_NOT_CONFIGURED");
      context.signal.throwIfAborted();
      try {
        const result = await client.responses.create({
          ...await completePayload(context), max_output_tokens: context.limits.maxOutputTokens,
          store: false, stream: false, service_tier: "default", tools: [],
        }, { signal: context.signal });
        if (result.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal")))
          throw new GenerationError("AI_REFUSED");
        if (result.status === "incomplete") throw new GenerationError("OUTPUT_TRUNCATED");
        if (result.status !== "completed") throw new GenerationError("PROVIDER_UNAVAILABLE");
        return result.output_text;
      } catch (error) { return safeFailure(error, context.signal); }
    },
  };
}
