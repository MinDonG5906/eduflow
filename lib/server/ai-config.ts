import "server-only";
import { z } from "zod";
import { GenerationError } from "../generation-contract";

// Shared by every local checkout. Lower personal limits remain valid.
export const TEAM_AI_BUDGET_LIMITS = Object.freeze({
  dayUSD: "1.00",
  monthUSD: "5.00",
});

// All amounts are integer millionths of a US dollar; never use floating-point money.
export function usdMicros(value: string): number {
  if (!/^\d{1,5}(\.\d{1,6})?$/.test(value)) throw new GenerationError("AI_NOT_CONFIGURED");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
}

const positiveMoney = z.string().transform(usdMicros).pipe(z.number().int().positive().max(10_000_000_000));
const integer = (fallback: string, max: number) => z.string().regex(/^\d+$/)
  .default(fallback).transform(Number).pipe(z.number().int().min(1).max(max));
const schema = z.object({
  apiKey: z.string().trim().min(10).max(1000).refine((v) => !/\s/.test(v)),
  model: z.string().trim().min(1).max(100),
  inputRate: positiveMoney,
  outputRate: positiveMoney,
  requestBudget: positiveMoney,
  dayBudget: positiveMoney,
  monthBudget: positiveMoney,
  maxInputTokens: integer("16000", 110000),
  maxOutputTokens: integer("8000", 100000),
  requestsPerHour: integer("5", 100),
  maxConcurrent: integer("1", 4),
});
export type AIConfig = z.infer<typeof schema> & { attemptCost: number; reservationCost: number };
export type PaidGenerationLimits = {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxProviderCalls: 1;
};

// teamCaps: false only for the operator's free-tier Gemini team key, which the team exempted
// from the shared $1/$5 caps; its own Gemini budget still guards a key whose project has billing.
export function readAIConfig(env: Record<string, string | undefined> = process.env, { teamCaps = true } = {}): AIConfig {
  if (env.EDUFLOW_AI_ENABLED !== "true") throw new GenerationError("AI_DISABLED");
  if (env.NEXT_PUBLIC_EDUFLOW_AI_API_KEY || env.NEXT_PUBLIC_AI_API_KEY)
    throw new GenerationError("AI_NOT_CONFIGURED");
  const parsed = schema.safeParse({
    apiKey: env.EDUFLOW_AI_API_KEY, model: env.EDUFLOW_AI_MODEL,
    inputRate: env.EDUFLOW_AI_INPUT_USD_PER_MILLION,
    outputRate: env.EDUFLOW_AI_OUTPUT_USD_PER_MILLION,
    requestBudget: env.EDUFLOW_AI_REQUEST_BUDGET_USD,
    dayBudget: env.EDUFLOW_AI_DAY_BUDGET_USD ?? TEAM_AI_BUDGET_LIMITS.dayUSD,
    monthBudget: env.EDUFLOW_AI_MONTH_BUDGET_USD ?? TEAM_AI_BUDGET_LIMITS.monthUSD,
    maxInputTokens: env.EDUFLOW_AI_MAX_INPUT_TOKENS,
    maxOutputTokens: env.EDUFLOW_AI_MAX_OUTPUT_TOKENS,
    requestsPerHour: env.EDUFLOW_AI_REQUESTS_PER_HOUR,
    maxConcurrent: env.EDUFLOW_AI_MAX_CONCURRENT,
  });
  if (!parsed.success) throw new GenerationError("AI_NOT_CONFIGURED");
  const personal = parsed.data;
  if (personal.dayBudget > personal.monthBudget || personal.requestBudget > personal.dayBudget)
    throw new GenerationError("AI_NOT_CONFIGURED");
  const config = {
    ...personal,
    ...(teamCaps ? {
      dayBudget: Math.min(personal.dayBudget, usdMicros(TEAM_AI_BUDGET_LIMITS.dayUSD)),
      monthBudget: Math.min(personal.monthBudget, usdMicros(TEAM_AI_BUDGET_LIMITS.monthUSD)),
    } : {}),
  };
  const numerator = BigInt(config.maxInputTokens) * BigInt(config.inputRate) +
    BigInt(config.maxOutputTokens) * BigInt(config.outputRate);
  const attemptCost = Number((numerator + BigInt(999999)) / BigInt(1000000));
  const reservationCost = attemptCost * 2; // Includes the one allowed format repair.
  if (config.dayBudget > config.monthBudget || config.requestBudget > config.dayBudget)
    throw new GenerationError("AI_NOT_CONFIGURED");
  return Object.freeze({ ...config, attemptCost, reservationCost });
}

// Only server adapters may call this. Never put the result in task/Board/errors.
export function readAIKey(): string {
  return readAIConfig().apiKey;
}

export function assertLocalAIRequest(request: Request): void {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new GenerationError("AI_ACCESS_DENIED");
  // NextRequest normalizes 127.0.0.1/[::1] to localhost. Use the browser's
  // Host for the exact Origin comparison, without trusting forwarded headers.
  let browserURL: URL;
  try { browserURL = new URL(`http://${request.headers.get("host") ?? url.host}`); }
  catch { throw new GenerationError("AI_ACCESS_DENIED"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(browserURL.hostname) ||
      browserURL.port !== url.port || browserURL.username || browserURL.password ||
      browserURL.pathname !== "/" || browserURL.search || browserURL.hash ||
      request.headers.get("origin") !== browserURL.origin ||
      (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin"))
    throw new GenerationError("AI_ACCESS_DENIED");
  if (!["application/json", "multipart/form-data"].includes(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? ""))
    throw new GenerationError("INVALID_REQUEST");
}
