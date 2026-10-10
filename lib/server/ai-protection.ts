import "server-only";
import { join } from "node:path";
import { GenerationError } from "../generation-contract";
import { assertLocalAIRequest, readAIConfig, type AIConfig } from "./ai-config";
import { LocalAIBudget } from "./ai-budget";
import type { GenerationAdapter } from "./generation-service";

export function protectPaidGeneration(
  request: Request,
  adapter: GenerationAdapter,
  options: { config?: AIConfig; directory?: string } = {},
): { adapter: GenerationAdapter; finish: () => void } {
  assertLocalAIRequest(request);
  const config = options.config ?? readAIConfig();
  if (adapter.model !== config.model || typeof adapter.countInputTokens !== "function")
    throw new GenerationError("AI_NOT_CONFIGURED");
  if (request.signal.aborted) throw new GenerationError("CANCELLED");
  const budget = new LocalAIBudget(options.directory ?? join(process.cwd(), ".eduflow-private"));
  let id: string;
  try { id = budget.reserve(config); } catch (error) { budget.close(); throw error; }
  let finished = false, pending = 0;
  const closeWhenIdle = () => {
    if (finished && pending === 0) {
      try { budget.finish(id); } finally { budget.close(); }
    }
  };
  const limits = Object.freeze({
    maxInputTokens: config.maxInputTokens, maxOutputTokens: config.maxOutputTokens, maxProviderCalls: 1 as const,
  });
  return {
    adapter: {
      ...adapter,
      async generate(input, context) {
        if (finished) throw new GenerationError("CANCELLED");
        context.signal.throwIfAborted();
        const paidContext = { ...context, limits };
        // Counting also uses the network. Hold concurrency until it settles, and
        // recheck cancellation before any generation can start.
        pending++;
        let started = false;
        try {
          const inputTokens = await adapter.countInputTokens!(input, paidContext);
          context.signal.throwIfAborted();
          if (!Number.isSafeInteger(inputTokens) || inputTokens < 1) throw new GenerationError("AI_NOT_CONFIGURED");
          if (inputTokens > limits.maxInputTokens) throw new GenerationError("TOKEN_LIMIT_EXCEEDED", {
            inputTokens, maxInputTokens: limits.maxInputTokens,
          });
          budget.startAttempt(id);
          started = true;
          return await adapter.generate(input, paidContext);
        } finally {
          try { if (started) budget.settleAttempt(id); }
          finally { pending--; closeWhenIdle(); }
        }
      },
    },
    finish() {
      if (finished) return;
      finished = true;
      closeWhenIdle();
    },
  };
}
