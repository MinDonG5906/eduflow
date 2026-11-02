// Local regression evaluation; --live uses the selected provider and the existing shared budget.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaults, newScene } from "../lib/storyboard";
import { GenerationError, generationTask } from "../lib/generation-contract";
import { verifySceneEvidence } from "../lib/server/generation-grounding";
import { selectedGenerator } from "../lib/server/generator";
import { protectPaidGeneration } from "../lib/server/ai-protection";

async function main() {
  const live = process.argv.includes("--live");
  const text = "사고 직후 작업을 중지합니다. 전원을 차단합니다. 응급조치를 실시합니다.";
  const scene = { ...newScene(), title: "사고 직후 대응", narration: text, subtitle: "작업을 중지합니다.\n전원을 차단합니다.", evidence: text, sourceId: "sentence:1-3" };
  const ref = (excerpt: string) => ({ id: `knowledge:eval:${crypto.randomUUID()}`, documentId: crypto.randomUUID(),
    title: "검증용 안전 교육 자료", origin: "internal" as const, url: "", published: "", revision: "", excerpt });
  const input = { manuscript: text, settings: defaults, scene };
  const cases = [
    { id: "accident-response-vs-prevention", sources: [ref("중량물 사고 예방을 위해 작업 전 작업계획서를 작성하고 순서를 점검합니다.")], expected: "no_match" },
    { id: "no-related-material", sources: [ref("재활용품은 종류별로 분리배출하고 용기 안의 이물질을 제거합니다.")], expected: "no_match" },
    { id: "direct-emergency-support", sources: [ref(text)], expected: "verified" },
  ];
  const results = [];
  for (const item of cases) {
    let calls = 0;
    let failureCode: string | undefined;
    let protectedRun: ReturnType<typeof protectPaidGeneration> | undefined;
    try {
      const [result] = await verifySceneEvidence([scene], item.sources, live ? async verification => {
        try {
          const adapter = selectedGenerator();
          if (adapter.mode !== "ai") { failureCode = "NO_PAID_PROVIDER_SELECTED"; throw new Error(); }
          protectedRun = protectPaidGeneration(new Request("http://localhost/api/generate", { method: "POST",
            headers: { Origin: "http://localhost", "Content-Type": "application/json" } }), adapter,
            adapter.billing ? { config: adapter.billing.config } : {});
          calls++;
          return await protectedRun.adapter.generate(input, { signal: AbortSignal.timeout(20000), task: generationTask(input), verification });
        } catch (error) {
          failureCode ??= error instanceof GenerationError ? error.code : "VERIFICATION_UNAVAILABLE";
          throw error;
        }
      } : undefined, AbortSignal.timeout(30000));
      const expected = !live && item.expected === "verified" ? "budget_skipped" : item.expected;
      results.push({ case: item.id, status: result.grounding?.status, expected, passed: result.grounding?.status === expected,
        calls, ...(failureCode ? { failureCode } : {}), connected: result.references?.length ?? 0, links: result.grounding?.links ?? [], sourceUnchanged: result.narration === text });
    } finally { protectedRun?.finish(); }
  }
  const report = { live, results };
  const filename = resolve("output", `grounding-eval-${live ? "live" : "local"}.json`);
  mkdirSync(resolve("output"), { recursive: true });
  writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ live, results: results.map(({ links, ...result }) => ({ ...result, verifiedSentences: links.length })), report: filename }, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
}

main().catch(() => { console.error("근거 평가를 완료하지 못했습니다. 연결·비용 한도를 확인하세요."); process.exitCode = 1; });
