import { searchKnowledgeRequest } from "@/lib/server/knowledge-handler";

export const runtime = "nodejs";
export const POST = (request: Request) => searchKnowledgeRequest(request);
