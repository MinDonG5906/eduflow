import { createSceneImageHandlers } from "@/lib/server/scene-image";

export const runtime = "nodejs";
const handlers = createSceneImageHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
