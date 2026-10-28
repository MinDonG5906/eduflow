import { readKnowledgePdf } from "@/lib/server/knowledge-handler";

export const runtime = "nodejs";
export const GET = (request: Request) => readKnowledgePdf(request);
