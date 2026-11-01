import { readValidation, writeValidation } from "@/lib/server/knowledge-validation-handler";

export const runtime = "nodejs";
export const GET = (request: Request) => readValidation(request);
export const POST = (request: Request) => writeValidation(request);
