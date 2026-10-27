import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { GenerationError } from "../generation-contract";
import { assertLocalAIRequest } from "./ai-config";
import {
  CLAUDE_MODELS, PROVIDERS, privateDirectory, publicConnection, readConnectionState,
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
]);

function failure(error: unknown) {
  const failed = error instanceof GenerationError ? error : new GenerationError("INTERNAL_ERROR");
  return NextResponse.json({ code: failed.code, error: failed.message }, { status: failed.status, headers: { "Cache-Control": "no-store" } });
}
const ok = (body: unknown) => NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });

export function createConnectionHandlers(options: { directory?: string; env?: Record<string, string | undefined> } = {}) {
  const directory = () => options.directory ?? privateDirectory();
  const env = () => options.env ?? process.env;
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
        }
        return ok(status());
      } catch (error) { return failure(error); }
    },
  };
}
