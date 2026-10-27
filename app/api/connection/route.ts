import { createConnectionHandlers } from "@/lib/server/connection-handler";

export const runtime = "nodejs";
const handlers = createConnectionHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
