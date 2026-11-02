import { NextResponse } from "next/server";
import { GenerationError } from "../generation-contract";
import { localizationRequestSchema, localizationResponseSchema } from "../localization";
import { assertLocalAIRequest } from "./ai-config";
import { protectPaidGeneration } from "./ai-protection";
import type { GenerationAdapter } from "./generation-service";
import { runLocalization } from "./localization-service";

export function createLocalizeHandler(adapterOrFactory: GenerationAdapter | (() => GenerationAdapter), options: {
  timeoutMs?: number;
  budgetDirectory?: string;
} = {}) {
  return async (request: Request) => {
    try {
      if (request.signal.aborted) throw new GenerationError("CANCELLED");
      const raw = await request.text();
      if (raw.length > 150000) throw new GenerationError("REQUEST_TOO_LARGE");
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new GenerationError("LOCALIZATION_INVALID_REQUEST"); }
      const parsed = localizationRequestSchema.safeParse(body);
      if (!parsed.success) throw new GenerationError("LOCALIZATION_INVALID_REQUEST");
      const adapter = typeof adapterOrFactory === "function" ? adapterOrFactory() : adapterOrFactory;
      if (adapter.mode !== "ai") throw new GenerationError("LOCALIZATION_AI_REQUIRED");
      assertLocalAIRequest(request);
      // Same admission, token count and shared daily/monthly budget as generation.
      const protectedRun = protectPaidGeneration(request, adapter, { ...(adapter.billing ? { config: adapter.billing.config } : {}), directory: options.budgetDirectory });
      let localization;
      try { localization = await runLocalization(parsed.data, protectedRun.adapter, { signal: request.signal, timeoutMs: options.timeoutMs }); }
      finally { protectedRun.finish(); }
      return NextResponse.json(localizationResponseSchema.parse({ language: parsed.data.language, localization }), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const failure = request.signal.aborted ? new GenerationError("CANCELLED") :
        error instanceof GenerationError ? error : new GenerationError("INTERNAL_ERROR");
      return NextResponse.json({ code: failure.code, error: failure.message, retryable: failure.retryable,
        ...(failure.inputUsage ? { inputUsage: failure.inputUsage } : {}),
      }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
    }
  };
}
