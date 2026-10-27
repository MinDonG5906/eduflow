import "server-only";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as agentQuery, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { GenerationError } from "../generation-contract";
import type { GenerationAdapter, GenerationContext } from "./generation-service";
import type { PdfContent } from "./pdf-content";
import { claudeContent, claudeJsonSchema, createDocumentPreparer, providerTask } from "./provider-prompt";

// Personal experiment only: runs the user's own Claude Code login on their own PC.
// Anthropic does not allow products to offer claude.ai login without approval.

type AgentQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

// Only what the bundled CLI needs to start and find its own login. API keys, cloud
// provider switches and every EduFlow secret stay out of the subprocess.
const PASSED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"];

export function subscriptionEnv(env: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(PASSED_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
}

async function* userMessage(context: GenerationContext, taskText: string, document?: PdfContent): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: claudeContent(taskText, document) } };
  context.signal.throwIfAborted();
}

function failure(status: number | null | undefined, text: string): GenerationError {
  if (status === 401 || status === 403 || /log ?in|logged in|\/login|oauth/i.test(text)) return new GenerationError("AI_SIGN_IN_REQUIRED");
  if (status === 429 || /usage limit|rate limit/i.test(text)) return new GenerationError("SUBSCRIPTION_LIMITED");
  return new GenerationError("PROVIDER_UNAVAILABLE");
}

export function createClaudeAgentAdapter(options: { model?: string; query?: AgentQuery; env?: Record<string, string | undefined> } = {}): GenerationAdapter {
  const model = options.model ?? "opus";
  const run = options.query ?? (agentQuery as unknown as AgentQuery);
  const prepareDocument = createDocumentPreparer();
  return {
    mode: "ai", model: `claude-code-subscription/${model}`, promptVersion: "eduflow-claude-agent-v1-selected-pdf",
    billing: { kind: "subscription" },
    async generate(_, context) {
      context.signal.throwIfAborted();
      const prepared = await prepareDocument(context);
      const { instructions, responseSchema, taskText } = providerTask(prepared.context, prepared.document);
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      // An empty directory keeps project files and CLAUDE.md out of the session.
      const cwd = await mkdtemp(join(tmpdir(), "eduflow-claude-"));
      try {
        for await (const message of run({
          prompt: userMessage(context, taskText, prepared.document),
          options: {
            model, cwd, abortController,
            env: subscriptionEnv(options.env),
            systemPrompt: instructions,
            tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [],
            persistSession: false, maxTurns: 3,
            outputFormat: { type: "json_schema", schema: claudeJsonSchema(responseSchema) },
          },
        })) {
          if (message.type === "system" && message.subtype === "init" && message.apiKeySource !== "none")
            // A stray key would silently switch this to metered API billing.
            throw new GenerationError("AI_NOT_CONFIGURED");
          if (message.type !== "result") continue;
          if (message.subtype === "success") {
            if (message.is_error) throw failure(message.api_error_status, message.result);
            return message.structured_output !== undefined ? JSON.stringify(message.structured_output) : message.result;
          }
          // Let the normal one-time repair handle unusable structure.
          if (message.subtype === "error_max_structured_output_retries") return "";
          throw failure(null, message.errors.join(" "));
        }
        throw new GenerationError("PROVIDER_UNAVAILABLE");
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        if (error instanceof GenerationError) throw error;
        // Never forward CLI output; it can contain account details or manuscript text.
        throw new GenerationError("PROVIDER_UNAVAILABLE");
      } finally {
        context.signal.removeEventListener("abort", abort);
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
