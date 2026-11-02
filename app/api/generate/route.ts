import { selectedGenerator, generatorStatus } from "@/lib/server/generator";
import { createGenerateHandler } from "@/lib/server/generate-handler";
import { searchSceneKnowledge } from "@/lib/server/scene-knowledge";

import { searchGenerationKnowledge } from "@/lib/server/generation-knowledge";

export const runtime = "nodejs";
export const POST = createGenerateHandler(selectedGenerator, { knowledge: searchGenerationKnowledge, sceneKnowledge: searchSceneKnowledge });

export function GET() {
  return Response.json(generatorStatus(), { headers: { "Cache-Control": "no-store" } });
}
