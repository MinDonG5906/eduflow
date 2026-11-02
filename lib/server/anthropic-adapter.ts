import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { GenerationError, SERVER_TIMEOUT_MS } from "../generation-contract";
import type { AIConfig } from "./ai-config";
import { CLAUDE_MODELS } from "./connection-store";
import type { GenerationAdapter, GenerationContext } from "./generation-service";
import type { PdfContent } from "./pdf-content";
import { claudeContent, claudeJsonSchema, createDocumentPreparer, providerTask } from "./provider-prompt";

export function assertAnthropicConfig(config: AIConfig) {
  // Only pinned, priced models can run under the dollar budget.
  const pricing = CLAUDE_MODELS[config.model as keyof typeof CLAUDE_MODELS];
  if (!pricing) throw new GenerationError("AI_NOT_CONFIGURED");
  const micros = (usd: string) => Math.round(Number(usd) * 1_000_000);
  if (config.inputRate < micros(pricing.inputUSD) || config.outputRate < micros(pricing.outputUSD))
    throw new GenerationError("AI_NOT_CONFIGURED");
}

function request(config: AIConfig, context: GenerationContext, document?: PdfContent) {
  const { instructions, responseSchema, taskText } = providerTask(context, document);
  return {
    model: config.model,
    system: instructions,
    messages: [{ role: "user" as const, content: claudeContent(taskText, document) }],
    output_config: { effort: "medium" as const, format: { type: "json_schema" as const, schema: claudeJsonSchema(responseSchema) } },
  };
}

function safeFailure(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw signal.reason;
  if (error instanceof GenerationError) throw error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
    throw new GenerationError("AI_AUTH_FAILED");
  if (error instanceof Anthropic.RateLimitError) throw new GenerationError("RATE_LIMITED");
  if (error instanceof Anthropic.APIError && error.status === 413) throw new GenerationError("REQUEST_TOO_LARGE");
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError)
    throw new GenerationError("AI_NOT_CONFIGURED");
  if (error instanceof Anthropic.APIConnectionTimeoutError) throw new GenerationError("TIMEOUT");
  // Never include SDK messages, headers, keys, or manuscript fragments in errors.
  throw new GenerationError("PROVIDER_UNAVAILABLE");
}

export function createAnthropicAdapter(config: AIConfig, options: { fetch?: typeof fetch } = {}): GenerationAdapter {
  assertAnthropicConfig(config);
  const client = new Anthropic({
    apiKey: config.apiKey, baseURL: "https://api.anthropic.com",
    maxRetries: 0, timeout: SERVER_TIMEOUT_MS, logLevel: "off",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const prepareDocument = createDocumentPreparer();
  async function completeRequest(context: GenerationContext) {
    const prepared = await prepareDocument(context);
    return request(config, prepared.context, prepared.document);
  }
  return {
    mode: "ai", model: config.model, promptVersion: "eduflow-claude-v5-two-captions",
    billing: { kind: "metered", config },
    async countInputTokens(_, context) {
      try {
        const result = await client.messages.countTokens(await completeRequest(context), { signal: context.signal });
        return result.input_tokens;
      } catch (error) { return safeFailure(error, context.signal); }
    },
    async generate(_, context) {
      if (!context.limits) throw new GenerationError("AI_NOT_CONFIGURED");
      context.signal.throwIfAborted();
      try {
        // Thinking tokens count toward max_tokens, so the shared output cap also bounds them.
        const message = await client.messages.stream(
          { ...await completeRequest(context), max_tokens: context.limits.maxOutputTokens },
          { signal: context.signal },
        ).finalMessage();
        if (message.stop_reason === "refusal") throw new GenerationError("AI_REFUSED");
        if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded")
          throw new GenerationError("OUTPUT_TRUNCATED");
        if (message.stop_reason !== "end_turn") throw new GenerationError("PROVIDER_UNAVAILABLE");
        return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      } catch (error) { return safeFailure(error, context.signal); }
    },
  };
}
