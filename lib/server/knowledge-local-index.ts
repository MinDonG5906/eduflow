import "server-only";
import { portableSearchIdentity } from "./knowledge-portability";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { contentHash } from "./knowledge-validation-store";

export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const embeddingCache = (directory: string) => join(directory, "embedding-cache");
export function localModelReady(directory: string) {
  return ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"].every(file =>
    existsSync(join(embeddingCache(directory), EMBEDDING_MODEL, EMBEDDING_REVISION, file)));
}
export type SearchIndex = {
  identity: string;
  create(name: string, signal: AbortSignal): Promise<string>;
  enabled(id: string, enabled: boolean, signal: AbortSignal): Promise<void>;
  addChunk(id: string, content: string, signal: AbortSignal): Promise<string>;
  retrieve(question: string, ids: string[], signal: AbortSignal): Promise<{ id: string; document_id: string; content: string }[]>;
};
export type Embed = (text: string, signal: AbortSignal) => Promise<number[]>;
let extractor: Promise<import("@huggingface/transformers").FeatureExtractionPipeline> | undefined;
let loadedCache: string | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** CPU only, two threads, one inference at a time. Runtime never downloads a model. */
export function localEmbedding(directory: string): Embed {
  return (text, signal) => {
    const task = queue.then(async () => {
      signal.throwIfAborted();
      const cache = resolve(embeddingCache(directory));
      if (loadedCache && loadedCache !== cache) throw new Error("다른 모델 보관함이 이미 열려 있습니다.");
      loadedCache = cache;
      extractor ??= import("@huggingface/transformers").then(({ pipeline, env }) => {
        // v4's metadata discovery does not propagate local_files_only/cache_dir.
        // Use the exact local snapshot and also prohibit remote model access globally.
        env.allowRemoteModels = false;
        return pipeline("feature-extraction", join(cache, EMBEDDING_MODEL, EMBEDDING_REVISION), {
        cache_dir: cache, local_files_only: true, dtype: "q8", device: "cpu",
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      }); }).catch(error => { extractor = undefined; loadedCache = undefined; throw error; });
      const model = await extractor;
      // Embed every part, not just the truncated beginning of long Korean chunks.
      const sum = new Array<number>(384).fill(0);
      for (let offset = 0; offset < text.length; offset += 112) {
        signal.throwIfAborted();
        const output = await model(text.slice(offset, offset + 128), { pooling: "mean", normalize: true });
        const vector = Array.from(output.data, Number);
        if (vector.length !== sum.length) throw new Error("검색 모델의 출력 크기가 다릅니다.");
        vector.forEach((value, i) => { sum[i] += value; });
        output.dispose();
      }
      signal.throwIfAborted();
      const norm = Math.hypot(...sum);
      if (!Number.isFinite(norm) || !norm) throw new Error("검색 벡터를 만들지 못했습니다.");
      return sum.map(value => value / norm);
    });
    queue = task.catch(() => {});
    return task;
  };
}

/** Exact cosine search is sufficient for this 50-document pilot; no separate server. */
export class LocalSearchIndex implements SearchIndex {
  readonly identity: string;
  constructor(private directory: string, private embed: Embed = localEmbedding(directory)) {
    this.identity = portableSearchIdentity(directory, EMBEDDING_MODEL, EMBEDDING_REVISION) ?? contentHash(`local-v1\n${resolve(directory)}\n${EMBEDDING_MODEL}\n${EMBEDDING_REVISION}\nq8-mean128-112`);
  }
  private open() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "knowledge-vectors.sqlite");
    if (lstatSync(this.directory).isSymbolicLink() || existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
      throw new Error("검색 보관함을 열 수 없습니다.");
    closeSync(openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    chmodSync(path, 0o600);
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, content TEXT NOT NULL, vector TEXT NOT NULL, model TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);`);
    return db;
  }
  async create(name: string, signal: AbortSignal) {
    signal.throwIfAborted(); const db = this.open();
    try { const id = randomUUID(); db.prepare("INSERT INTO documents(id,name) VALUES(?,?)").run(id, name); return id; }
    finally { db.close(); }
  }
  async enabled(id: string, enabled: boolean, signal: AbortSignal) {
    signal.throwIfAborted(); const db = this.open();
    try { if (!db.prepare("UPDATE documents SET enabled=? WHERE id=?").run(Number(enabled), id).changes) throw new Error("검색 자료가 없습니다."); }
    finally { db.close(); }
  }
  async addChunk(documentId: string, content: string, signal: AbortSignal) {
    const vector = await this.embed(content, signal); signal.throwIfAborted();
    const db = this.open();
    try {
      if (!db.prepare("SELECT id FROM documents WHERE id=?").get(documentId)) throw new Error("검색 자료가 없습니다.");
      const id = contentHash(`${documentId}\n${content}\n${this.identity}`);
      db.prepare("INSERT OR IGNORE INTO chunks(id,document_id,content,vector,model) VALUES(?,?,?,?,?)")
        .run(id, documentId, content, JSON.stringify(vector), this.identity);
      return id;
    } finally { db.close(); }
  }
  async retrieve(question: string, ids: string[], signal: AbortSignal) {
    if (!ids.length) return [];
    const query = await this.embed(question, signal); signal.throwIfAborted();
    const allowed = new Set(ids); const db = this.open();
    try {
      return db.prepare("SELECT c.* FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.enabled=1 AND c.model=?")
        .all(this.identity).filter(row => allowed.has(String(row.document_id))).map(row => {
          const vector: number[] = JSON.parse(String(row.vector));
          const score = vector.length === query.length ? vector.reduce((sum, value, i) => sum + value * query[i], 0) : -1;
          return { id: String(row.id), document_id: String(row.document_id), content: String(row.content), score };
        }).filter(row => Number.isFinite(row.score) && row.score >= 0.25)
        .sort((a, b) => b.score - a.score).slice(0, 30).map(({ score: _score, ...row }) => row);
    } finally { db.close(); }
  }
}
