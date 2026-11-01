import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { ValidationStore, contentHash, validationDirectory } from "../lib/server/knowledge-validation-store";
import sources from "../eval/knowledge-validation/sources.json";

// No downloads, live indexing, paid requests or guessed replacements. Fetch the official files first.
async function main() {
  const directory = validationDirectory();
  const store = new ValidationStore(directory);
  try {
    for (const source of sources) {
      const pdf = readFileSync(join(directory, "validation-corpus", source.filename));
      if (contentHash(pdf) !== source.sha256) throw new Error(`원본 파일 변경: ${source.id}`);
      if ((await PDFDocument.load(pdf)).getPageCount() !== source.totalPages) throw new Error(`쪽수 변경: ${source.id}`);
      const existing = store.list().find(run => run.metadata.title.startsWith("[시험용]") && run.sha256 === source.sha256 &&
        JSON.stringify(run.pages.map(page => page.page)) === JSON.stringify(source.pages));
      const run = existing ?? store.create({ title: `[시험용] ${source.title}`, origin: "official", url: source.url,
        published: source.published, revision: source.revision }, pdf, source.pages, true);
      if (!run.testOnly) {
        const token = store.claim(run.id);
        try { run.testOnly = true; store.save(run, token); } finally { store.release(run.id, token); }
      }
      console.log(JSON.stringify({ source: source.id, runId: run.id, status: run.status, pages: source.pages }));
    }
  } finally { store.close(); }
}
main().catch(() => { console.error("공식 시험 파일과 해시·쪽수를 확인해 주세요. 자동 승인이나 검색 반영은 하지 않았습니다."); process.exitCode = 1; });
