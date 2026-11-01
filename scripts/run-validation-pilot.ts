import { loadEnvConfig } from "@next/env";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationStore, validationDirectory } from "../lib/server/knowledge-validation-store";
import { checkValidationPage, publishValidation } from "../lib/server/knowledge-validation-service";

async function main() {
  loadEnvConfig(process.cwd());
  const directory = validationDirectory(), store = new ValidationStore(directory);
  const runs = store.list().filter(run => run.testOnly && (!process.argv[2] || run.id === process.argv[2]));
  store.close();
  if (!runs.length || runs.length > 5) throw new Error("시험 자료 1~5건을 지정해 주세요.");
  for (const run of runs) {
    if (run.status === "published") continue;
    for (const page of run.pages) {
      // A rerun must not silently spend again on an already-attempted failed page.
      if (page.attempts.length) continue;
      console.log(JSON.stringify({ phase: "checking", title: run.metadata.title, page: page.page }));
      const checked = await checkValidationPage(run.id, page.page, directory, AbortSignal.timeout(180000));
      console.log(JSON.stringify({ phase: "checked", title: run.metadata.title, pages: checked.pages.map(p => ({
        page: p.page, status: p.status, reasons: p.attempts.at(-1)?.reasons,
      })) }));
    }
    const current = new ValidationStore(directory); const checked = current.get(run.id)!; current.close();
    if (checked.pages.some(page => page.status === "passed") && checked.pages.every(page => page.status !== "pending")) {
      await publishValidation(run.id, directory, AbortSignal.timeout(180000));
      console.log(JSON.stringify({ phase: "stored-test-only", title: run.metadata.title }));
    }
  }
  const final = new ValidationStore(directory);
  try {
    writeFileSync(join(directory, "validation-pilot-results.json"), JSON.stringify({
      at: new Date().toISOString(), mode: "local", measuredAccuracy: null,
      runs: final.list().filter(run => runs.some(selected => selected.id === run.id)),
    }, null, 2), { mode: 0o600 });
  } finally { final.close(); }
}
main().catch(() => { console.error("시험 실행을 완료하지 못했습니다. 검사 기록과 연결·비용 한도를 확인해 주세요."); process.exitCode = 1; });
