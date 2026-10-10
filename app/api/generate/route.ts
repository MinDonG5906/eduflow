import { selectedGenerator, generatorStatus } from "@/lib/server/generator";
import { createGenerateHandler } from "@/lib/server/generate-handler";

export const runtime = "nodejs";
export const POST = createGenerateHandler(selectedGenerator);

export function GET() {
  return Response.json(generatorStatus(), { headers: { "Cache-Control": "no-store" } });
}
