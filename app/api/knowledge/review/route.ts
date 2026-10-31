import { listKnowledgeReview, reviewKnowledgePage } from "@/lib/server/knowledge-handler";

export const runtime = "nodejs";
export const GET = (request: Request) => listKnowledgeReview(request);
export const POST = (request: Request) => reviewKnowledgePage(request);
