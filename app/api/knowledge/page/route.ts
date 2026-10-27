import { renderKnowledgePage } from "@/lib/server/knowledge-handler";

export const runtime = "nodejs";
export const GET = (request: Request) => renderKnowledgePage(request);
