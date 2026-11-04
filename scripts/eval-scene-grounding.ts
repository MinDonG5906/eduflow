// Real retrieval + independently judged, human-labelled scope regressions.
// --live sends one bounded verification request through the existing budget guard.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaults, newScene } from "../lib/storyboard";
import { GenerationError, generationTask } from "../lib/generation-contract";
import { searchSceneKnowledge } from "../lib/server/scene-knowledge";
import { verifySceneEvidence } from "../lib/server/generation-grounding";
import { protectPaidGeneration } from "../lib/server/ai-protection";
import { protectSubscriptionGeneration } from "../lib/server/subscription-guard";
import { selectedGenerator } from "../lib/server/generator";
import type { RetrievedReference } from "../lib/knowledge";

async function main() {
  const live = process.argv.includes("--live");
  const text = "사고 직후 작업을 중지합니다. 전원을 차단합니다. 응급조치를 실시합니다.";
  const source = "추락, 끼임, 절단, 넘어짐, 협착 등 발생 시 사고기계의 작동을 중지하고 전원을 차단한다. 사고 상황을 파악하고 119 신고 및 응급조치를 시행한다.";
  const scene = { ...newScene(), title: "기계사고 직후 대응", purpose: "기계사고 발생 직후의 대응 순서",
    narration: text, subtitle: "작업을 중지합니다.\n전원을 차단합니다.", evidence: source };
  const reference = (excerpt: string): RetrievedReference => ({ id: crypto.randomUUID(), documentId: crypto.randomUUID(),
    title: "평가용 근거", excerpt, origin: "internal", url: "", published: "", revision: "" });
  const cases = [
    { id: "original-wrong-crane-prevention", scene, expected: "no_match", refs: [reference(
      "크레인 오조작으로 코일 사이 끼임. 재해예방대책: 위험반경 내에서 운전조작 금지, 안전수칙 수립 및 교육. 중량물의 종류 및 형상, 취급방법과 순서, 작업장소의 넓이 및 지형을 포함한 작업계획서를 작성하고 작업지휘자를 지정한다.")] },
    { id: "different-condition-respirator", scene: { ...scene, narration: "사고 직후 작업을 중지합니다.", subtitle: "" },
      expected: "no_match", refs: [reference("압력계의 지시치가 30 kg/㎠ 이하로 내려가거나 경보기가 울리게 되면 곧바로 작업을 중지하고 유해가스가 없는 안전한 위치로 되돌아온다. 안전한 위치에서 마스크를 벗고 공기탱크를 교환한다.")] },
    { id: "different-condition-heat-illness", scene: { ...scene, narration: "119에 신고하고 응급조치를 실시합니다.", subtitle: "" },
      expected: "no_match", refs: [reference("온열질환 증상을 판단하기 어려운 경우에는 즉시 119에 신고 후 응급조치를 수행한다. 의식이 있는 경우 먼저 응급조치 후 증상이 개선되지 않으면 119에 신고한다.")] },
    { id: "direct-machine-response", scene, expected: "verified", refs: [reference(text)] },
    { id: "no-related-material", scene, expected: "no_match", refs: [reference("재활용품은 종류별로 분리배출합니다.")] },
  ];
  const input = { manuscript: source, settings: defaults, scene };
  let protectedRun: ReturnType<typeof protectPaidGeneration> | undefined;
  let calls = 0;
  let failureCode: string | undefined;
  try {
    // Search actual registered materials without changing them or the user's saved board.
    const started = Date.now();
    const retrieval = await searchSceneKnowledge([scene], AbortSignal.timeout(30000));
    const retrievalMs = Date.now() - started;
    const all = [...new Map(cases.flatMap(item => item.refs).map(ref => [ref.id, ref])).values()];
    const results = await verifySceneEvidence(cases.map(item => item.scene), all, live ? async verification => {
      const adapter = selectedGenerator();
      if (adapter.mode !== "ai") throw new Error("NO_PAID_PROVIDER_SELECTED");
      const request = new Request("http://localhost/api/generate", { method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" } });
      protectedRun = adapter.billing?.kind === "subscription" ? protectSubscriptionGeneration(request, adapter)
        : protectPaidGeneration(request, adapter, adapter.billing ? { config: adapter.billing.config } : {});
      calls++;
      try {
        return await protectedRun.adapter.generate(input, { task: generationTask(input), verification, signal: AbortSignal.timeout(20000) });
      } catch (error) {
        failureCode = error instanceof GenerationError ? error.code : error instanceof DOMException ? error.name : "PROVIDER_UNAVAILABLE";
        throw error;
      }
    } : undefined, AbortSignal.timeout(30000), cases.map(item => ({ references: item.refs, status: "retrieved" })));
    const report = { live, calls, retrievalMs, ...(failureCode ? { failureCode } : {}),
      retrieval: retrieval.map(result => ({ status: result.status, sources: result.references.map(ref => ({ title: ref.title, page: ref.page })) })),
      cases: results.map((result, index) => ({ id: cases[index].id, expected: cases[index].expected,
        actual: result.grounding?.status, semanticCheck: live ? result.grounding?.status === cases[index].expected : "not_run",
        sourceUnchanged: result.narration === cases[index].scene.narration, connected: result.references?.length ?? 0,
        verifiedSentences: result.grounding?.links.length ?? 0 })),
    };
    mkdirSync(resolve("output"), { recursive: true });
    writeFileSync(resolve("output", `scene-grounding-${live ? "live" : "local"}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (live && report.cases.some(item => item.semanticCheck !== true)) process.exitCode = 1;
  } finally { protectedRun?.finish(); }
}
main().catch(() => { console.error("평가를 완료하지 못했습니다. 연결과 비용 한도를 확인하세요."); process.exitCode = 1; });
