import { selectedGenerator, generatorStatus } from "@/lib/server/generator";
import { createGenerateHandler } from "@/lib/server/generate-handler";
import { searchKnowledge } from "@/lib/server/knowledge-base";
import { manuscriptSource } from "@/lib/storyboard";

export const runtime = "nodejs";
export const POST = createGenerateHandler(selectedGenerator, { knowledge: (input) => searchKnowledge(
  [input.manuscript, input.sourceRequest ?? "", input.pdfSource?.name ?? "", ...input.settings.keywords].join(" "),
  input.sourceRequest || input.settings.keywords.join(" ") || manuscriptSource(input.manuscript).title,
) });

export function GET() {
  return Response.json(generatorStatus(), { headers: { "Cache-Control": "no-store" } });
}
