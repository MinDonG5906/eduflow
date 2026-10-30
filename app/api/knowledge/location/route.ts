import { readKnowledgeLocation } from "@/lib/server/knowledge-handler";

export const runtime = "nodejs";
export function GET(request: Request) { return readKnowledgeLocation(request); }
