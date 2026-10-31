import { addKnowledge, deleteKnowledge, listKnowledge, updateKnowledge } from "@/lib/server/knowledge-handler";

export const runtime = "nodejs";
export const GET = (request: Request) => listKnowledge(request);
export const POST = (request: Request) => addKnowledge(request);
export const PATCH = (request: Request) => updateKnowledge(request);
export const DELETE = (request: Request) => deleteKnowledge(request);
