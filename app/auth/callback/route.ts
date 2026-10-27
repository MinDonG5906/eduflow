import { createConnectionHandlers } from "@/lib/server/connection-handler";

// Sign in with ChatGPT returns here; the path is fixed by the registered loopback URI.
export const runtime = "nodejs";
export const GET = createConnectionHandlers().callback;
