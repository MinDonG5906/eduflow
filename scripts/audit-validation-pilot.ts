import { ValidationStore, validationDirectory } from "../lib/server/knowledge-validation-store";
import { candidateProblems } from "../lib/knowledge-validation";
import { KnowledgeBase } from "../lib/server/knowledge-base";
import { LocalSearchIndex } from "../lib/server/knowledge-local-index";

// A non-model audit. Preserve all original attempts, bytes and publication identifiers.
async function main() {
  const directory = validationDirectory(), store = new ValidationStore(directory), base = new KnowledgeBase(directory);
  try {
    for (const run of store.list().filter(run => run.testOnly && !run.quarantine)) {
      const failed = run.pages.filter(page => page.status === "passed").flatMap(page => {
        const attempt = page.attempts.at(-1)!;
        return attempt.candidate ? candidateProblems(attempt.candidate, attempt.verdict).map(reason => `${page.page}쪽: ${reason}`) : ["판독 결과 없음"];
      });
      if (!failed.length) continue;
      const token = store.claim(run.id);
      try {
        run.quarantine = { at: new Date().toISOString(), reasons: failed };
        store.save(run, token);
        if (run.localDocumentId) base.setActive(run.localDocumentId, false);
        const index = new LocalSearchIndex(directory);
        if (run.remoteDocumentId && run.backendIdentity === index.identity) await index.enabled(run.remoteDocumentId, false, AbortSignal.timeout(5000));
        console.log(JSON.stringify({ title: run.metadata.title, quarantine: run.quarantine }));
      } finally { store.release(run.id, token); }
    }
  } finally { base.close(); store.close(); }
}
main().catch(() => { console.error("추가 검사 기록을 확인해 주세요."); process.exitCode = 1; });
