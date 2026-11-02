import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertLocalAIRequest } from "@/lib/server/ai-config";
import { GenerationError } from "@/lib/generation-contract";
import { MAX_WORK_PACKAGE_BYTES, parseWorkPackage } from "@/lib/work-package";
import { validationDirectory } from "@/lib/server/knowledge-validation-store";

export const runtime = "nodejs";
export async function POST(request: Request) {
  let temporary: string | undefined;
  try {
    assertLocalAIRequest(request);
    // Same-origin POST for both read and write; never expose sample contents to a cross-origin GET.
    if (request.headers.get("x-demo-action") === "read") {
      try { return new Response(await readFile(join(validationDirectory(), "demo-work.json")), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
      catch { return Response.json({ error: "패키지에 저장된 예제가 없습니다. 작업 묶음 파일을 불러와 주세요." }, { status: 404 }); }
    }
    if (Number(request.headers.get("content-length")) > MAX_WORK_PACKAGE_BYTES) return Response.json({ error: "작업 묶음이 너무 큽니다." }, { status: 413 });
    const reader = request.body?.getReader(); if (!reader) throw new Error("작업 묶음이 없습니다.");
    let size = 0; const parts: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > MAX_WORK_PACKAGE_BYTES) { await reader.cancel(); return Response.json({ error: "작업 묶음이 너무 큽니다." }, { status: 413 }); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(parts).toString("utf8");
    const { value } = parseWorkPackage(raw);
    const { createHash } = await import("node:crypto");
    for (const asset of [...value.images, ...(value.pdf ? [value.pdf] : [])]) {
      if (createHash("sha256").update(Buffer.from(asset.data, "base64")).digest("hex") !== asset.sha256) throw new Error("작업 묶음의 파일이 손상되었습니다.");
    }
    const directory = validationDirectory(); await mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = join(directory, `demo-work-${randomUUID()}.tmp`);
    await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(directory, "demo-work.json")); temporary = undefined;
    return Response.json({ saved: true });
  } catch (error) {
    return Response.json({ error: error instanceof GenerationError ? error.message : "작업 묶음을 저장하지 못했습니다. 파일 형식과 저장 공간을 확인해 주세요." }, { status: error instanceof GenerationError ? error.status : 400 });
  } finally { if (temporary) await rm(temporary, { force: true }); }
}
