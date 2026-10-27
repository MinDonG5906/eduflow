import "server-only";
import OpenAI from "openai";
import { GenerationError, MAX_OUTPUT_CHARS, SERVER_TIMEOUT_MS } from "../generation-contract";
import { CHATGPT_RESOURCE, chatgptAccessToken, listChatGPTModels, type ChatGPTDeps } from "./chatgpt-auth";
import type { GenerationAdapter, GenerationContext } from "./generation-service";
import type { PdfAttachment } from "./pdf-input";
import { preparePdfInput } from "./prepare-pdf";
import { providerTask } from "./provider-prompt";

// Plan-usage preview rules: store:false and stream:true on every request; no
// max_output_tokens, temperature, metadata or system-role items. Output size is
// enforced here by stopping the stream instead.
function body(model: string, context: GenerationContext) {
  const { instructions, responseSchema, taskText } = providerTask(context);
  return {
    model, instructions,
    input: [{ role: "user" as const, content: [
      ...(context.pdf ? [{ type: "input_file" as const, filename: context.pdf.filename, detail: "high" as const,
        file_data: `data:application/pdf;base64,${Buffer.from(context.pdf.data).toString("base64")}` }] : []),
      { type: "input_text" as const, text: taskText },
    ] }],
    text: { format: { type: "json_schema" as const, name: "eduflow_storyboard", strict: true, schema: responseSchema } },
    store: false as const, stream: true as const,
  };
}

function providerFailure(status: number | undefined, code: string | null | undefined): GenerationError {
  if (code === "subscription_sharing_usage_limit_exceeded") return new GenerationError("SUBSCRIPTION_LIMITED");
  if (status === 401 || status === 403 || code === "subscription_sharing_user_not_eligible" || code === "subscription_sharing_invalid_user")
    return new GenerationError("AI_SIGN_IN_REQUIRED");
  if (status === 429) return new GenerationError("RATE_LIMITED");
  if (status === 400 || status === 404) return new GenerationError("AI_NOT_CONFIGURED");
  return new GenerationError("PROVIDER_UNAVAILABLE");
}

export function createChatGPTAdapter(options: { model?: string; auth?: ChatGPTDeps; fetch?: typeof fetch } = {}): GenerationAdapter {
  const preparedPdfs = new WeakMap<PdfAttachment, Promise<PdfAttachment>>();
  return {
    mode: "ai", model: `chatgpt-plan/${options.model ?? "default"}`, promptVersion: "eduflow-chatgpt-v1-selected-pdf",
    billing: { kind: "subscription" },
    async generate(_, context) {
      context.signal.throwIfAborted();
      try {
        const token = await chatgptAccessToken(options.auth);
        const model = options.model ?? (await listChatGPTModels(options.auth))[0]?.slug;
        if (!model) throw new GenerationError("AI_NOT_CONFIGURED");
        let pdfContext = context;
        if (context.pdf) {
          let prepared = preparedPdfs.get(context.pdf);
          if (!prepared) {
            prepared = preparePdfInput(context.pdf, context.signal);
            preparedPdfs.set(context.pdf, prepared);
          }
          pdfContext = { ...context, pdf: await prepared };
        }
        const client = new OpenAI({
          apiKey: token, baseURL: CHATGPT_RESOURCE, maxRetries: 0, timeout: SERVER_TIMEOUT_MS, logLevel: "off",
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        const stream = await client.responses.create(body(model, pdfContext), { signal: context.signal });
        let text = "";
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            text += event.delta;
            if (text.length > MAX_OUTPUT_CHARS) throw new GenerationError("OUTPUT_TRUNCATED");
          } else if (event.type === "response.refusal.delta") throw new GenerationError("AI_REFUSED");
          else if (event.type === "response.incomplete") throw new GenerationError("OUTPUT_TRUNCATED");
          else if (event.type === "response.failed") throw providerFailure(undefined, event.response.error?.code);
          else if (event.type === "error") throw providerFailure(undefined, event.code);
          else if (event.type === "response.completed") return text;
        }
        throw new GenerationError("PROVIDER_UNAVAILABLE");
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        if (error instanceof GenerationError) throw error;
        if (error instanceof OpenAI.APIError) throw providerFailure(error.status, error.code);
        if (error instanceof OpenAI.APIConnectionTimeoutError) throw new GenerationError("TIMEOUT");
        // Never include SDK messages, headers, tokens, or manuscript fragments in errors.
        throw new GenerationError("PROVIDER_UNAVAILABLE");
      }
    },
  };
}
