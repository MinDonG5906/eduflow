import "server-only";
import {
  chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GenerationError } from "../generation-contract";

export const PROVIDERS = ["demo", "openai-api", "anthropic-api", "gemini-api"] as const;
export type Provider = (typeof PROVIDERS)[number];

// Pinned standard prices (USD per million tokens), checked 2026-10-27. The budget
// ledger reserves against these, so a model is selectable only with a known price.
export const CLAUDE_MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5", inputUSD: "4.00", outputUSD: "20.00", requestBudgetUSD: "0.50" },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", inputUSD: "2.00", outputUSD: "10.00", requestBudgetUSD: "0.25" },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", inputUSD: "0.10", outputUSD: "0.50", requestBudgetUSD: "0.02" },
} as const;
export type ClaudeModel = keyof typeof CLAUDE_MODELS;
const claudeModelIds = Object.keys(CLAUDE_MODELS) as [ClaudeModel, ...ClaudeModel[]];

// Gemini runs on a team key that the operator puts in the server's .env.local, so people
// using the app never handle a key. Both models are on Google's free tier; a key whose
// Google project has billing turned on is charged these paid-tier prices (checked
// 2026-10-27), so the ledger reserves against them. gemini-3.8-flash doubles to
// $1.50/$7.50 on 2027-01-01: update this table before then.
export const GEMINI_MODELS = {
  "gemini-3.8-flash": { label: "Gemini 3.8 Flash", inputUSD: "0.75", outputUSD: "3.75", requestBudgetUSD: "0.10" },
  "gemini-3.5-flash-lite": { label: "Gemini 3.5 Flash-Lite", inputUSD: "0.30", outputUSD: "2.50", requestBudgetUSD: "0.05" },
} as const;
export type GeminiModel = keyof typeof GEMINI_MODELS;
export const DEFAULT_GEMINI_MODEL: GeminiModel = "gemini-3.8-flash";

/** The team's Gemini model from .env.local; null when it names an unpriced model. */
export function geminiModel(env: Record<string, string | undefined> = process.env): GeminiModel | null {
  const model = env.EDUFLOW_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  return Object.hasOwn(GEMINI_MODELS, model) ? (model as GeminiModel) : null;
}

const apiKey = z.string().trim().min(10).max(1000).refine((value) => !/\s/.test(value));
const stateSchema = z.object({
  version: z.literal(1),
  provider: z.enum(PROVIDERS),
  openaiKey: apiKey.optional(),
  anthropicKey: apiKey.optional(),
  anthropicModel: z.enum(claudeModelIds).default("claude-opus-5-5"),
  imageEnabled: z.boolean().default(false),
});
export type ConnectionState = z.infer<typeof stateSchema>;

const FILE = "connection.json";

export function privateDirectory() {
  return join(process.cwd(), ".eduflow-private");
}

function ensureDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  chmodSync(directory, 0o700);
}

function defaults(env: Record<string, string | undefined>): ConnectionState {
  // Checkouts configured before the connection screen keep their .env.local choice, and a
  // team Gemini key set there is used from the first start without any screen setup.
  const provider = env.EDUFLOW_GENERATOR === "openai" ? "openai-api" : env.EDUFLOW_GENERATOR === "gemini" ? "gemini-api" : "demo";
  return stateSchema.parse({ version: 1, provider });
}

export function readConnectionState(
  directory = privateDirectory(), env: Record<string, string | undefined> = process.env,
): ConnectionState {
  const filename = join(directory, FILE);
  let raw: string;
  try {
    if (lstatSync(filename).isSymbolicLink()) throw new GenerationError("AI_NOT_CONFIGURED");
    raw = readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(env);
    throw new GenerationError("AI_NOT_CONFIGURED");
  }
  try { return stateSchema.parse(JSON.parse(raw)); }
  // A damaged file is kept for inspection; never silently replace stored credentials.
  catch { throw new GenerationError("AI_NOT_CONFIGURED"); }
}

function writeState(directory: string, state: ConnectionState) {
  ensureDirectory(directory);
  const filename = join(directory, FILE);
  const temporary = join(directory, `${FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const file = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(file, JSON.stringify(stateSchema.parse(state)));
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(file);
  renameSync(temporary, filename);
}

export function updateConnectionState(
  update: (state: ConnectionState) => ConnectionState,
  directory = privateDirectory(), env: Record<string, string | undefined> = process.env,
): ConnectionState {
  const next = stateSchema.parse(update(readConnectionState(directory, env)));
  try { writeState(directory, next); }
  catch { throw new GenerationError("AI_NOT_CONFIGURED"); }
  return next;
}

const masked = (key?: string) => key ? `····${key.slice(-4)}` : null;

export function imageGenerationVendor(state: ConnectionState, env: Record<string, string | undefined> = process.env): "OpenAI" | "Google" | null {
  const openai = Boolean(state.openaiKey || (env.EDUFLOW_AI_ENABLED === "true" && env.EDUFLOW_AI_API_KEY?.trim()));
  if (state.provider === "openai-api" && openai) return "OpenAI";
  if (env.EDUFLOW_GEMINI_API_KEY?.trim()) return "Google";
  return openai ? "OpenAI" : null;
}

/** Everything the browser may see. Keys and tokens never leave the server. */
export function publicConnection(state: ConnectionState, env: Record<string, string | undefined> = process.env) {
  return {
    provider: state.provider,
    sceneImages: { enabled: state.imageEnabled, teamKey: Boolean(env.EDUFLOW_GEMINI_API_KEY?.trim()), vendor: imageGenerationVendor(state, env) },
    openai: {
      saved: masked(state.openaiKey),
      fromEnv: !state.openaiKey && env.EDUFLOW_AI_ENABLED === "true" && Boolean(env.EDUFLOW_AI_API_KEY),
    },
    anthropic: {
      saved: masked(state.anthropicKey),
      model: state.anthropicModel,
      models: claudeModelIds.map((id) => ({ id, ...CLAUDE_MODELS[id] })),
    },
    gemini: {
      // Only whether the team key exists; the key itself stays in .env.local.
      teamKey: Boolean(env.EDUFLOW_GEMINI_API_KEY?.trim()),
      model: geminiModel(env),
      label: GEMINI_MODELS[geminiModel(env) ?? DEFAULT_GEMINI_MODEL].label,
    },
  };
}
export type PublicConnection = ReturnType<typeof publicConnection>;
