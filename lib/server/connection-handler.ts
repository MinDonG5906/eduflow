import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { GenerationError } from "../generation-contract";
import { assertLocalAIRequest } from "./ai-config";
import { completeChatGPTSignIn, listChatGPTModels, signOutChatGPT, startChatGPTSignIn, type ChatGPTDeps } from "./chatgpt-auth";
import {
  CLAUDE_MODELS, PROVIDERS, experimentalClaudeSubscription, privateDirectory, publicConnection, readConnectionState,
  updateConnectionState,
} from "./connection-store";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Reads need only a loopback host: the status never contains keys or tokens. */
function assertLoopback(request: Request) {
  const url = new URL(request.url);
  const host = new URL(`http://${request.headers.get("host") ?? url.host}`);
  if (url.protocol !== "http:" || !LOOPBACK.includes(url.hostname) || !LOOPBACK.includes(host.hostname))
    throw new GenerationError("AI_ACCESS_DENIED");
}

const key = z.string().trim().min(10).max(1000).refine((value) => !/\s/.test(value));
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("select"), provider: z.enum(PROVIDERS) }),
  z.object({ action: z.literal("saveKey"), vendor: z.enum(["openai", "anthropic"]), key, consent: z.literal(true) }),
  z.object({ action: z.literal("removeKey"), vendor: z.enum(["openai", "anthropic"]) }),
  z.object({ action: z.literal("setClaudeModel"), model: z.enum(Object.keys(CLAUDE_MODELS) as [keyof typeof CLAUDE_MODELS]) }),
  z.object({ action: z.literal("setChatGPTModel"), model: z.string().trim().min(1).max(100).regex(/^[\w.:-]+$/) }),
  z.object({ action: z.literal("acknowledgeClaudeSubscription"), acknowledged: z.boolean() }),
  z.object({ action: z.literal("chatgptStart") }),
  z.object({ action: z.literal("chatgptModels") }),
  z.object({ action: z.literal("chatgptSignOut") }),
]);

function failure(error: unknown) {
  const failed = error instanceof GenerationError ? error : new GenerationError("INTERNAL_ERROR");
  return NextResponse.json({ code: failed.code, error: failed.message }, { status: failed.status, headers: { "Cache-Control": "no-store" } });
}
const ok = (body: unknown) => NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

export function createConnectionHandlers(options: { directory?: string; env?: Record<string, string | undefined>; chatgpt?: ChatGPTDeps } = {}) {
  const directory = () => options.directory ?? privateDirectory();
  const env = () => options.env ?? process.env;
  const chatgpt = () => ({ ...options.chatgpt, directory: directory() });
  const status = () => publicConnection(readConnectionState(directory(), env()), env());
  return {
    async GET(request: Request) {
      try { assertLoopback(request); return ok(status()); }
      catch (error) { return failure(error); }
    },
    async POST(request: Request) {
      try {
        // Same-origin JSON from this PC only, like paid generation requests.
        assertLocalAIRequest(request);
        const raw = await request.text();
        if (raw.length > 5000) throw new GenerationError("REQUEST_TOO_LARGE");
        let parsed;
        try { parsed = actionSchema.safeParse(JSON.parse(raw)); } catch { throw new GenerationError("INVALID_REQUEST"); }
        if (!parsed.success) throw new GenerationError("INVALID_REQUEST");
        const body = parsed.data;
        const update = (change: Parameters<typeof updateConnectionState>[0]) => updateConnectionState(change, directory(), env());
        switch (body.action) {
          case "select":
            if (body.provider === "claude-subscription" && !experimentalClaudeSubscription(env()))
              throw new GenerationError("AI_NOT_CONFIGURED");
            update((state) => ({ ...state, provider: body.provider }));
            break;
          case "saveKey":
            update((state) => body.vendor === "openai"
              ? { ...state, openaiKey: body.key, provider: "openai-api" }
              : { ...state, anthropicKey: body.key, provider: "anthropic-api" });
            break;
          case "removeKey":
            update((state) => {
              const provider = state.provider === (body.vendor === "openai" ? "openai-api" : "anthropic-api") ? "demo" : state.provider;
              return body.vendor === "openai" ? { ...state, openaiKey: undefined, provider } : { ...state, anthropicKey: undefined, provider };
            });
            break;
          case "setClaudeModel": update((state) => ({ ...state, anthropicModel: body.model })); break;
          case "setChatGPTModel": update((state) => ({ ...state, chatgptModel: body.model })); break;
          case "acknowledgeClaudeSubscription":
            update((state) => ({
              ...state, claudeSubscriptionAcknowledged: body.acknowledged,
              provider: !body.acknowledged && state.provider === "claude-subscription" ? "demo" : state.provider,
            }));
            break;
          case "chatgptStart": return ok({ url: startChatGPTSignIn(request, chatgpt()) });
          case "chatgptModels": return ok({ models: await listChatGPTModels(chatgpt()) });
          case "chatgptSignOut": return ok({ ...status(), revoked: (await signOutChatGPT(chatgpt())).revoked });
        }
        return ok(status());
      } catch (error) { return failure(error); }
    },
    async callback(request: Request) {
      // The browser arrives here from auth.openai.com, so there is no same-origin header;
      // the single-use state and PKCE verifier bind the callback to this server's attempt.
      // Return to the exact Host the browser used: NextRequest reports 127.0.0.1 as
      // localhost, which is a different origin with its own saved drafts.
      const origin = `http://${request.headers.get("host") ?? new URL(request.url).host}`;
      const back = (result: string) => NextResponse.redirect(new URL(`/?chatgpt=${result}`, origin), { headers: { "Cache-Control": "no-store" } });
      try {
        assertLoopback(request);
        const result = await completeChatGPTSignIn(new URL(request.url), chatgpt());
        return back(result.ok ? (result.planUsage ? "connected" : "no-plan") : result.reason);
      } catch { return back("invalid"); }
    },
  };
}
