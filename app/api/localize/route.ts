import { selectedGenerator } from "@/lib/server/generator";
import { createLocalizeHandler } from "@/lib/server/localize-handler";

export const runtime = "nodejs";
export const POST = createLocalizeHandler(selectedGenerator);
