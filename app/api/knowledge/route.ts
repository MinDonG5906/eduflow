import { addKnowledge, listKnowledge, updateKnowledge } from "@/lib/server/knowledge-handler";

export const runtime = "nodejs";
export const GET = (request: Request) => listKnowledge(request);
export const POST = (request: Request) => addKnowledge(request);
export const PATCH = (request: Request) => updateKnowledge(request);
