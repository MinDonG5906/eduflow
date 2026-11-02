import "server-only";
import { GenerationError } from "../generation-contract";
import type { GroundingFailure } from "../grounding-failure";

// Persist only allowlisted categories and validated counts, never SDK text, keys or source content.
export function groundingFailure(stage: GroundingFailure["stage"], error: unknown, started: number,
  options: { timeoutMs?: number; invalidResponse?: boolean } = {}): GroundingFailure {
  const code = error instanceof GenerationError ? error.code : undefined;
  const timedOut = options.timeoutMs !== undefined || code === "TIMEOUT" || error instanceof DOMException && error.name === "TimeoutError";
  const reason: GroundingFailure["reason"] = options.invalidResponse ? "invalid_response" : timedOut ? "timeout"
    : stage !== "verification" ? "search_failed"
    : code === "TOKEN_LIMIT_EXCEEDED" || code === "REQUEST_TOO_LARGE" ? "input_limit"
    : code === "OUTPUT_TRUNCATED" ? "output_limit"
    : code === "INVALID_OUTPUT" ? "invalid_response"
    : code === "RATE_LIMITED" ? "rate_limited"
    : code === "AI_AUTH_FAILED" ? "auth_failed"
    : code === "AI_NOT_CONFIGURED" || code === "AI_DISABLED" || code === "AI_ACCESS_DENIED" ? "configuration"
    : code === "BUDGET_EXCEEDED" || code === "BUDGET_UNAVAILABLE" ? "budget"
    : code === "AI_REFUSED" ? "refused"
    : code === "PROVIDER_UNAVAILABLE" ? "provider_error" : "unknown";
  return { stage, reason, recordedAt: new Date().toISOString(), elapsedMs: Math.max(0, Date.now() - started),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(error instanceof GenerationError && error.inputUsage ? error.inputUsage : {}),
  };
}
