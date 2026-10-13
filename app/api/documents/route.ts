import { importDocumentRequest } from "@/lib/server/document-import";

export const runtime = "nodejs";
export const POST = (request: Request) => importDocumentRequest(request);
