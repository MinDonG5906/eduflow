import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { snapshotDemoKnowledge, copyRegularTree } from "../lib/server/demo-package";

async function main() {
  const root = process.cwd();
  const destination = resolve(process.argv[2] || join(tmpdir(), `EduFlow-Demo-${Date.now()}`));
  if (existsSync(destination)) throw new Error("새 출력 폴더를 지정해 주세요. 기존 폴더는 덮어쓰지 않습니다.");
  if (process.env.EDUFLOW_KNOWLEDGE_MODE === "ragflow") throw new Error("외부 RAGFlow는 로컬 자료로 이전한 뒤 패키지를 만들어 주세요.");
  const stage = mkdtempSync(join(tmpdir(), "eduflow-package-"));
  const app = join(stage, "app"); mkdirSync(app);
  try {
    // Copy only runtime source; never copy .env, .git, node_modules, build output,
    // old Windows binaries, arbitrary private files or machine-specific converters.
    for (const name of ["app", "components", "hooks", "lib", "public", "demo"])
      copyRegularTree(join(root, name), join(app, name));
    mkdirSync(join(app, "scripts"));
    for (const name of ["package-demo.ts", "knowledge-validation-worker.ts", "setup-hwp-converter.mjs", "setup-local-knowledge.ts"])
      copyRegularTree(join(root, "scripts", name), join(app, "scripts", name));
    for (const name of ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs"])
      copyRegularTree(join(root, name), join(app, name));
    // Source package uses next start; standalone output is for the separate native build.
    const config = readFileSync(join(app, "next.config.ts"), "utf8");
    writeFileSync(join(app, "next.config.ts"), config.replace('output: "standalone"', 'output: undefined'));
    const counts = await snapshotDemoKnowledge(join(root, ".eduflow-private"), join(app, ".eduflow-private"));
    writeFileSync(join(app, ".env.local"), "NEXT_PUBLIC_EDUFLOW_DEMO_PACKAGE=true\nEDUFLOW_GENERATOR=demo\nEDUFLOW_AI_ENABLED=false\nEDUFLOW_KNOWLEDGE_MODE=local\nEDUFLOW_AI_DAY_BUDGET_USD=10\nEDUFLOW_AI_MONTH_BUDGET_USD=20\n");
    for (const [source, target] of [["start-demo.cmd", "Windows-Start.cmd"], ["start-demo.command", "macOS-Start.command"], ["README.txt", "먼저읽기.txt"], ["API-SETUP.txt", "AI_API_연결가이드.txt"]])
      copyRegularTree(join(root, "demo", source), join(stage, target));
    const manifest = { format: "eduflow-demo", version: 1, createdAt: new Date().toISOString(), ...counts,
      requirements: "Node.js 24; internet for first dependency installation; Windows/macOS",
      apiKeysIncluded: false, browsersIncluded: false,
      files: Object.fromEntries(["knowledge.sqlite", "knowledge-vectors.sqlite", "knowledge-validation.sqlite", "search-portability.json", ...(counts.example ? ["demo-work.json"] : [])]
        .filter(name => existsSync(join(app, ".eduflow-private", name))).map(name => [name, createHash("sha256").update(readFileSync(join(app, ".eduflow-private", name))).digest("hex")])) };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
    // Copy supports a destination on another filesystem. Publish only a complete stage.
    copyRegularTree(stage, destination);
    console.log(JSON.stringify({ destination, ...counts, apiKeysIncluded: false }));
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "데모 패키지 생성 실패"); process.exitCode = 1; });
