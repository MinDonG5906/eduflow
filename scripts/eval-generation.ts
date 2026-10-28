// Runs the evaluation cases in eval/cases.json and writes reviewer files.
//   npm run eval                                    free extractive demo, called in-process
//   npm run eval -- --server http://127.0.0.1:3000  the running app's /api/generate, so the
//                                                   server's key handling and cost limits apply
// Options: --cases <file>, --only <case id>, --confirm-paid (required when the server uses a paid model).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { generationRequestSchema, type GenerationInput } from "../lib/generation-contract";
import { checkBoard, scoringSheet, type EvalReport, type ScoringCase } from "../lib/eval-checks";
import { settingsSchema, type Board } from "../lib/storyboard";
import { demoAdapter } from "../lib/server/demo-adapter";
import { runGeneration } from "../lib/server/generation-service";

const casesSchema = z.object({
  note: z.string().optional(),
  cases: z.array(z.object({
    id: z.string().regex(/^[\w-]+$/), title: z.string().min(1), manuscript: z.string().min(1),
    placeholder: z.boolean().default(false), settings: settingsSchema,
  })).min(1),
});
type CaseResult = ScoringCase & { audience: string; placeholder: boolean; elapsedMs: number; report?: EvalReport };
// Once the server reports a spent or unreadable budget, further calls cannot succeed.
const STOP_CODES = new Set(["BUDGET_EXCEEDED", "BUDGET_UNAVAILABLE", "AI_NOT_CONFIGURED", "AI_ACCESS_DENIED"]);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 다음에 값을 입력해 주세요.`);
  return value;
}

async function serverGenerator(server: string, confirmPaid: boolean) {
  const origin = new URL(server).origin;
  const status = await fetch(`${origin}/api/generate`, { cache: "no-store" }).then((response) => response.json()) as { mode?: string; available?: boolean };
  if (!status.available) throw new Error("서버의 생성 기능을 사용할 수 없습니다. 서버 설정과 키를 확인해 주세요.");
  if (status.mode === "ai" && !confirmPaid)
    throw new Error("서버가 유료 AI 모드입니다. 비용이 발생하므로 --confirm-paid를 함께 지정해야 실행합니다.");
  return async (input: GenerationInput): Promise<{ raw?: unknown; error?: string }> => {
    const response = await fetch(`${origin}/api/generate`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(input),
    });
    const raw = await response.json().catch(() => null) as { code?: unknown } | null;
    if (response.ok) return { raw };
    return { error: typeof raw?.code === "string" ? raw.code : `HTTP_${response.status}` };
  };
}

const levelLabel = { pass: "통과", fail: "실패", warn: "경고", info: "참고" } as const;

function summary(results: CaseResult[], meta: { mode: string; startedAt: string; note?: string }) {
  const board = results.find((result) => result.board)?.board;
  const generated = results.filter((result) => result.report);
  const lines = [
    "# EduFlow 생성 평가 자동 검사 결과", "",
    `- 실행 시각: ${meta.startedAt}`,
    `- 실행 방식: ${meta.mode}`,
    ...(board?.generation ? [`- 모델: ${board.generation.model} · 프롬프트: ${board.generation.promptVersion}`] : []),
    `- 필수 항목 충족: ${generated.filter((result) => result.report!.passed).length} / ${results.length}건 (생성 실패는 미충족)`,
    "- 중대한 원문 왜곡과 대상·난이도 적합성은 사람 평가로 판정합니다. `scoring.csv`를 평가자별로 복사해 채점하세요 (docs/06_AI_EVAL.md).",
    ...(results.some((result) => result.placeholder) ? ["", `> 임시 표본 원고가 포함되어 있습니다. 이 결과로 품질을 판정하지 마세요.${meta.note ? ` ${meta.note}` : ""}`] : []),
    "", "| 케이스 | 교육대상 | 필수 항목 | 장면 | 시간(합계/목표) | 경고 | 참고 | 응답 시간 |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => {
      if (!result.report) return `| ${result.id} | ${result.audience} | 생성 실패 (${result.error}) | - | - | - | - | ${(result.elapsedMs / 1000).toFixed(1)}초 |`;
      const { checks, stats, passed } = result.report;
      const count = (level: string) => checks.filter((check) => check.level === level).length;
      return `| ${result.id} | ${result.audience} | ${passed ? "통과" : "실패"} | ${stats?.scenes ?? "-"} | ${stats ? `${stats.totalSeconds}/${stats.targetSeconds}초` : "-"} | ${count("warn")} | ${count("info")} | ${(result.elapsedMs / 1000).toFixed(1)}초 |`;
    }),
  ];
  for (const result of results) {
    const notable = result.report?.checks.filter((check) => check.level !== "pass") ?? [];
    if (!notable.length) continue;
    lines.push("", `## ${result.id} · ${result.title}`, "", ...notable.map((check) => `- ${levelLabel[check.level]} · ${check.label}: ${check.detail}`));
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const casesPath = resolve(option("--cases") ?? "eval/cases.json");
  const only = option("--only");
  const server = option("--server");
  const file = casesSchema.parse(JSON.parse(await readFile(casesPath, "utf8")));
  const cases = file.cases.filter((entry) => !only || entry.id === only);
  if (!cases.length) throw new Error(`실행할 케이스가 없습니다: ${only}`);

  const generate = server ? await serverGenerator(server, process.argv.includes("--confirm-paid")) :
    async (input: GenerationInput) => ({ raw: await runGeneration(input, demoAdapter) as unknown });
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  let stopped: string | undefined;
  for (const entry of cases) {
    const base = { id: entry.id, title: entry.title, audience: entry.settings.audience, placeholder: entry.placeholder };
    if (stopped) {
      results.push({ ...base, elapsedMs: 0, error: `SKIPPED_AFTER_${stopped}` });
      console.log(`${entry.id}: 건너뜀 (${stopped} 이후 호출 중지)`);
      continue;
    }
    const manuscript = await readFile(resolve(dirname(casesPath), entry.manuscript), "utf8");
    const input = generationRequestSchema.parse({ manuscript, settings: entry.settings });
    const started = performance.now();
    let outcome: { raw?: unknown; error?: string };
    try { outcome = await generate(input); }
    catch (error) { outcome = { error: error && typeof error === "object" && "code" in error ? String(error.code) : "REQUEST_FAILED" }; }
    const elapsedMs = Math.round(performance.now() - started);
    if (outcome.error) {
      if (STOP_CODES.has(outcome.error)) stopped = outcome.error;
      results.push({ ...base, elapsedMs, error: outcome.error });
    } else {
      const report = checkBoard(outcome.raw, input);
      results.push({ ...base, elapsedMs, report, ...(report.stats ? { board: outcome.raw as Board } : { error: "INVALID_OUTPUT" }) });
    }
    const last = results[results.length - 1];
    console.log(`${entry.id}: ${!last.report ? `생성 실패 ${last.error}` : last.report!.passed ? "필수 항목 통과" : "필수 항목 실패"} (${(elapsedMs / 1000).toFixed(1)}초)`);
  }

  const out = join(resolve("eval/results"), startedAt.replace(/[:.]/g, "-"));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "results.json"), JSON.stringify({ startedAt, server: server ?? null, cases: results }, null, 2) + "\n");
  await writeFile(join(out, "summary.md"), summary(results, { mode: server ? `서버 호출 (${new URL(server).origin})` : "무료 데모 (서버 없이 직접 호출)", startedAt, note: file.note }));
  await writeFile(join(out, "scoring.csv"), scoringSheet(results));
  console.log(`결과: ${out}`);
  if (stopped) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
