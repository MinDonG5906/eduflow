import { pipeline } from "@huggingface/transformers";
import { EMBEDDING_MODEL, EMBEDDING_REVISION, embeddingCache } from "../lib/server/knowledge-local-index";
import { validationDirectory } from "../lib/server/knowledge-validation-store";
async function main() {
const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
  revision: EMBEDDING_REVISION, cache_dir: embeddingCache(validationDirectory()), dtype: "q8", device: "cpu",
  session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
});
const result = await extractor("작업 전 추락 위험과 안전난간을 점검한다.", { pooling: "mean", normalize: true });
console.log(JSON.stringify({ model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dimensions: result.dims, ready: true }));
result.dispose(); await extractor.dispose();
}
main().catch(error => { console.error(error instanceof Error ? error.message : "로컬 검색 모델 준비 실패"); process.exitCode = 1; });
