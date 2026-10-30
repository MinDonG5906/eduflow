import { createKnowledgeStructureHandlers } from "@/lib/server/knowledge-structure-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = createKnowledgeStructureHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
