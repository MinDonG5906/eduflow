import "server-only";
import { GenerationError } from "../generation-contract";
import { readAIConfig } from "./ai-config";
import { demoAdapter } from "./demo-adapter";
import { assertOpenAIConfig, createOpenAIAdapter } from "./openai-adapter";

export function selectedGenerator() {
  const selection = process.env.EDUFLOW_GENERATOR ?? "demo";
  if (selection === "demo") return demoAdapter;
  if (selection !== "openai") throw new GenerationError("AI_NOT_CONFIGURED");
  return createOpenAIAdapter(readAIConfig());
}

export function generatorStatus() {
  const selection = process.env.EDUFLOW_GENERATOR ?? "demo";
  if (selection === "demo") return { mode: "demo", available: true } as const;
  try {
    if (selection !== "openai") throw new GenerationError("AI_NOT_CONFIGURED");
    assertOpenAIConfig(readAIConfig());
    return { mode: "ai", available: true } as const;
  } catch {
    return { mode: "ai", available: false } as const;
  }
}
