import "server-only";
import { GenerationError } from "../generation-contract";
import { assertLocalAIRequest } from "./ai-config";
import type { GenerationAdapter } from "./generation-service";

// Plan logins cost no dollars here, but still go out under the user's own account:
// one generation at a time and a per-hour count, kept per server process.
type GuardState = { active: number; started: number[] };
const state: GuardState = ((globalThis as { eduflowSubscriptionGuard?: GuardState }).eduflowSubscriptionGuard ??= {
  active: 0, started: [],
});

export function subscriptionLimits(env: Record<string, string | undefined> = process.env) {
  const perHour = Number(env.EDUFLOW_SUBSCRIPTION_REQUESTS_PER_HOUR ?? "10");
  return { maxConcurrent: 1, requestsPerHour: Number.isInteger(perHour) && perHour >= 1 && perHour <= 100 ? perHour : 10 };
}

export function protectSubscriptionGeneration(
  request: Request,
  adapter: GenerationAdapter,
  options: { now?: () => number; limits?: ReturnType<typeof subscriptionLimits> } = {},
): { adapter: GenerationAdapter; finish: () => void } {
  assertLocalAIRequest(request);
  if (request.signal.aborted) throw new GenerationError("CANCELLED");
  const now = options.now ?? Date.now;
  const limits = options.limits ?? subscriptionLimits();
  state.started = state.started.filter((time) => time > now() - 3_600_000);
  if (state.active >= limits.maxConcurrent || state.started.length >= limits.requestsPerHour)
    throw new GenerationError("RATE_LIMITED");
  state.active++;
  state.started.push(now());
  let finished = false;
  return {
    adapter: {
      ...adapter,
      async generate(input, context) {
        if (finished) throw new GenerationError("CANCELLED");
        return adapter.generate(input, context);
      },
    },
    finish() {
      if (finished) return;
      finished = true;
      state.active--;
    },
  };
}

export function resetSubscriptionGuardForTests() {
  state.active = 0;
  state.started = [];
}
