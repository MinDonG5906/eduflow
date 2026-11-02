import "server-only";
import OpenAI, { toFile } from "openai";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { GenerationError } from "../generation-contract";
import { readAIConfig } from "./ai-config";
import { readConnectionState } from "./connection-store";

// Pinned size/quality and current official prices checked 2026-10-31:
// https://developers.openai.com/api/docs/guides/image-generation
// 1536x864, low, one output. Reserve 1024 output tokens conservatively;
// price every input token at the higher image-input rate ($8/M vs $5/M text).
export const OPENAI_SCENE_IMAGE_MODEL = "gpt-image-2-2026-04-21";
type Env = Record<string, string | undefined>;
export function openAIImageConfig(directory: string, env: Env) {
  const state = readConnectionState(directory, env);
  const key = state.openaiKey || (env.EDUFLOW_AI_ENABLED === "true" ? env.EDUFLOW_AI_API_KEY : undefined);
  const configured = env.EDUFLOW_AI_MAX_INPUT_TOKENS;
  return readAIConfig({ ...env, EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: key,
    EDUFLOW_AI_MODEL: OPENAI_SCENE_IMAGE_MODEL, EDUFLOW_AI_INPUT_USD_PER_MILLION: "8.00", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "30.00",
    EDUFLOW_AI_MAX_INPUT_TOKENS: configured && /^\d+$/.test(configured) ? String(Math.min(Number(configured), 8000)) : configured ?? "8000",
    EDUFLOW_AI_MAX_OUTPUT_TOKENS: "1024", EDUFLOW_AI_REQUEST_BUDGET_USD: env.EDUFLOW_IMAGE_REQUEST_BUDGET_USD || "0.30" });
}

// A small thumbnail preserves composition and bounds reference-image input cost.
export async function openAIImageReference(reference: Buffer) {
  const image = await loadImage(reference);
  const scale = Math.min(1, 512 / Math.max(image.width, image.height));
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  try { canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height); return canvas.toBuffer("image/png"); }
  finally { canvas.width = 1; canvas.height = 1; }
}

export async function generateOpenAIImage(config: ReturnType<typeof openAIImageConfig>, prompt: string,
  reference: Buffer | undefined, signal: AbortSignal, options: { fetch?: typeof fetch; timeoutMs: number }) {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0,
    timeout: options.timeoutMs, logLevel: "off", ...(options.fetch ? { fetch: options.fetch } : {}) });
  const params = { model: OPENAI_SCENE_IMAGE_MODEL, prompt, size: "1536x864" as const, quality: "low" as const, n: 1, output_format: "png" as const };
  const response = reference
    ? await client.images.edit({ ...params, image: await toFile(reference, "reference.png", { type: "image/png" }) }, { signal })
    : await client.images.generate(params, { signal });
  if (response.data?.length !== 1 || !response.data[0].b64_json) throw new GenerationError("INVALID_OUTPUT");
  return response.data[0].b64_json;
}
