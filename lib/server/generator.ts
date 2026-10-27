import "server-only";
import { GenerationError } from "../generation-contract";
import { readAIConfig, type AIConfig } from "./ai-config";
import { createAnthropicAdapter } from "./anthropic-adapter";
import { PLAN_SCOPE } from "./chatgpt-auth";
import { createChatGPTAdapter } from "./chatgpt-adapter";
import { createClaudeAgentAdapter } from "./claude-agent-adapter";
import {
  CLAUDE_MODELS, experimentalClaudeSubscription, readConnectionState, type ConnectionState, type Provider,
} from "./connection-store";
import { demoAdapter } from "./demo-adapter";
import type { GenerationAdapter } from "./generation-service";
import { createOpenAIAdapter, OPENAI_MODEL } from "./openai-adapter";

type Env = Record<string, string | undefined>;

// A key saved on the connection screen was entered with explicit consent to paid use,
// so it unlocks AI without EDUFLOW_AI_ENABLED. Budgets and token caps still come from
// the environment and never exceed the team limits enforced in readAIConfig.
export function openAIConfig(state: ConnectionState, env: Env = process.env): AIConfig {
  if (!state.openaiKey) return readAIConfig(env);
  return readAIConfig({
    ...env, EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: state.openaiKey,
    EDUFLOW_AI_MODEL: env.EDUFLOW_AI_MODEL || OPENAI_MODEL,
    EDUFLOW_AI_INPUT_USD_PER_MILLION: env.EDUFLOW_AI_INPUT_USD_PER_MILLION || "0.75",
    EDUFLOW_AI_OUTPUT_USD_PER_MILLION: env.EDUFLOW_AI_OUTPUT_USD_PER_MILLION || "4.50",
    EDUFLOW_AI_REQUEST_BUDGET_USD: env.EDUFLOW_AI_REQUEST_BUDGET_USD || "0.10",
  });
}

export function anthropicConfig(state: ConnectionState, env: Env = process.env): AIConfig {
  if (!state.anthropicKey) throw new GenerationError("AI_NOT_CONFIGURED");
  const pricing = CLAUDE_MODELS[state.anthropicModel];
  return readAIConfig({
    ...env, EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: state.anthropicKey, EDUFLOW_AI_MODEL: state.anthropicModel,
    EDUFLOW_AI_INPUT_USD_PER_MILLION: pricing.inputUSD, EDUFLOW_AI_OUTPUT_USD_PER_MILLION: pricing.outputUSD,
    EDUFLOW_AI_REQUEST_BUDGET_USD: env.EDUFLOW_ANTHROPIC_REQUEST_BUDGET_USD || pricing.requestBudgetUSD,
  });
}

export function adapterFor(state: ConnectionState, env: Env = process.env): GenerationAdapter {
  switch (state.provider) {
    case "demo": return demoAdapter;
    case "openai-api": {
      const config = openAIConfig(state, env);
      return { ...createOpenAIAdapter(config), billing: { kind: "metered", config } };
    }
    case "anthropic-api": return createAnthropicAdapter(anthropicConfig(state, env));
    case "chatgpt":
      if (!state.chatgpt?.scopes.includes(PLAN_SCOPE)) throw new GenerationError("AI_SIGN_IN_REQUIRED");
      return createChatGPTAdapter({ ...(state.chatgptModel ? { model: state.chatgptModel } : {}) });
    case "claude-subscription":
      if (!experimentalClaudeSubscription(env) || !state.claudeSubscriptionAcknowledged) throw new GenerationError("AI_NOT_CONFIGURED");
      return createClaudeAgentAdapter({ ...(env.EDUFLOW_CLAUDE_SUBSCRIPTION_MODEL ? { model: env.EDUFLOW_CLAUDE_SUBSCRIPTION_MODEL } : {}) });
  }
}

export function selectedGenerator() {
  return adapterFor(readConnectionState());
}

const labels: Record<Provider, string> = {
  demo: "데모 모드",
  "openai-api": "OpenAI API",
  "anthropic-api": "Claude API",
  chatgpt: "ChatGPT 플랜",
  "claude-subscription": "Claude 구독 (개인 실험)",
};
const vendors: Record<Provider, "OpenAI" | "Anthropic" | null> = {
  demo: null, "openai-api": "OpenAI", "anthropic-api": "Anthropic", chatgpt: "OpenAI", "claude-subscription": "Anthropic",
};

export function generatorStatus() {
  let provider: Provider = "demo", available = false;
  try {
    const state = readConnectionState();
    provider = state.provider;
    adapterFor(state);
    available = true;
  } catch { /* Reported as unavailable; the connection screen shows what is missing. */ }
  return { mode: provider === "demo" ? "demo" : "ai", available, provider, label: labels[provider], vendor: vendors[provider] } as const;
}
