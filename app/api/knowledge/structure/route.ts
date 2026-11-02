import { createKnowledgeStructureHandlers } from "@/lib/server/knowledge-structure-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = createKnowledgeStructureHandlers();
export const GET = handlers.GET;
export const POST = () => Response.json({ error: "개별 연결 분석과 검수 기능이 제거되었습니다." }, { status: 410 });
