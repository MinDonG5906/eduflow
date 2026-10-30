import { createKnowledgeStructureHandlers } from "@/lib/server/knowledge-structure-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createKnowledgeStructureHandlers().figure;
