import { selectedGenerator, generatorStatus } from "@/lib/server/generator";
import { createGenerateHandler } from "@/lib/server/generate-handler";
import { searchGenerationKnowledge } from "@/lib/server/generation-knowledge";

export const runtime = "nodejs";
export const POST = createGenerateHandler(selectedGenerator, { knowledge: searchGenerationKnowledge });

export function GET() {
  return Response.json(generatorStatus(), { headers: { "Cache-Control": "no-store" } });
}
