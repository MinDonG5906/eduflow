import { recheckKnowledge } from "@/lib/server/knowledge-handler";

export const runtime = "nodejs";
export async function POST(request: Request) { return recheckKnowledge(request); }
