import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkKnowledge, knowledgeMetadataSchema, knowledgeSourceSchema, searchNeedles, type KnowledgeDocument, type KnowledgeImportPage, type KnowledgeMetadata, type KnowledgeReviewPage, type KnowledgeSource, type RetrievedReference } from "../knowledge";

type DocumentRow = {
  id: string; title: string; origin: "official" | "internal"; url: string;
  published: string; revision: string; sha256: string; created_at: string;
  active: number; chunks: number; pending_pages?: number;
};
type SearchRow = DocumentRow & { ordinal: number; page: number | null; text: string };

function documentFromRow(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id, title: row.title, origin: row.origin, ...(row.url ? { url: row.url } : {}),
    published: row.published, revision: row.revision, sha256: row.sha256,
    createdAt: row.created_at, active: Boolean(row.active), chunks: row.chunks, pendingPages: row.pending_pages ?? 0,
  };
}

export class KnowledgeBase {
  private readonly db: DatabaseSync;

  constructor(directory = join(process.cwd(), ".eduflow-private")) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("KNOWLEDGE_UNAVAILABLE");
    chmodSync(directory, 0o700);
    const filename = join(directory, "knowledge.sqlite");
    if (existsSync(filename) && (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()))
      throw new Error("KNOWLEDGE_UNAVAILABLE");
    closeSync(openSync(filename, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA busy_timeout=2000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, origin TEXT NOT NULL,
        url TEXT NOT NULL, published TEXT NOT NULL, revision TEXT NOT NULL,
        sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
        ordinal INTEGER NOT NULL, page INTEGER, text TEXT NOT NULL,
        UNIQUE(document_id, ordinal)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunk_search(rowid, text) VALUES(new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunk_search(chunk_search, rowid, text) VALUES('delete', old.id, old.text);
      END;
      CREATE TABLE IF NOT EXISTS knowledge_files (
        document_id TEXT PRIMARY KEY REFERENCES documents(id),
        pdf BLOB NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_review_pages (
        document_id TEXT NOT NULL REFERENCES documents(id),
        page INTEGER NOT NULL, file_page INTEGER NOT NULL, text TEXT NOT NULL, method TEXT NOT NULL,
        confidence REAL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        approved_text TEXT NOT NULL DEFAULT '', resolved_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(document_id, page)
      ) STRICT;
    `);
  }

  add(source: KnowledgeSource): KnowledgeDocument {
    const parsed = knowledgeSourceSchema.parse(source);
    const pieces = chunkKnowledge(parsed.text);
    if (!pieces.length || pieces.length > 400) throw new Error("KNOWLEDGE_SIZE");
    const sha256 = createHash("sha256").update(parsed.text).digest("hex");
    const id = randomUUID(), createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT id FROM documents WHERE sha256=? AND active=1 LIMIT 1").get(sha256))
        throw new Error("KNOWLEDGE_DUPLICATE");
      this.db.prepare("INSERT INTO documents(id,title,origin,url,published,revision,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, parsed.title, parsed.origin, parsed.url ?? "", parsed.published, parsed.revision, sha256, createdAt);
      const insert = this.db.prepare("INSERT INTO chunks(document_id,ordinal,page,text) VALUES(?,?,?,?)");
      for (const piece of pieces) insert.run(id, piece.ordinal, piece.page ?? null, piece.text);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { id, title: parsed.title, origin: parsed.origin, ...(parsed.url ? { url: parsed.url } : {}),
      published: parsed.published, revision: parsed.revision, sha256, createdAt, active: true, chunks: pieces.length };
  }

  list(): KnowledgeDocument[] {
    const rows = this.db.prepare(`SELECT d.*,
      (SELECT count(*) FROM chunks c WHERE c.document_id=d.id) AS chunks,
      (SELECT count(*) FROM knowledge_review_pages r WHERE r.document_id=d.id AND r.status='pending') AS pending_pages
      FROM documents d ORDER BY d.created_at DESC`).all() as DocumentRow[];
    return rows.map(documentFromRow);
  }

  addImported(meta: KnowledgeMetadata, sha256: string, pdf: Buffer, pages: KnowledgeImportPage[]): KnowledgeDocument {
    const source = knowledgeMetadataSchema.parse(meta);
    if (!pages.length || pages.length > 200 || pages.reduce((sum, page) => sum + page.text.length, 0) > 200000)
      throw new Error("KNOWLEDGE_SIZE");
    const safe = pages.filter((page) => !page.needsReview);
    const pieces = safe.flatMap((page) => chunkKnowledge(`[PDF ${page.page}페이지]\n\n${page.text}`));
    if (pieces.length > 400) throw new Error("KNOWLEDGE_SIZE");
    const id = randomUUID(), createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT id FROM documents WHERE sha256=? AND active=1 LIMIT 1").get(sha256))
        throw new Error("KNOWLEDGE_DUPLICATE");
      this.db.prepare("INSERT INTO documents(id,title,origin,url,published,revision,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, source.title, source.origin, source.url ?? "", source.published, source.revision, sha256, createdAt);
      this.db.prepare("INSERT INTO knowledge_files(document_id,pdf) VALUES(?,?)").run(id, pdf);
      const insertChunk = this.db.prepare("INSERT INTO chunks(document_id,ordinal,page,text) VALUES(?,?,?,?)");
      for (const [index, piece] of pieces.entries()) insertChunk.run(id, index + 1, piece.page ?? null, piece.text);
      const insertReview = this.db.prepare("INSERT INTO knowledge_review_pages(document_id,page,file_page,text,method,confidence,reason) VALUES(?,?,?,?,?,?,?)");
      for (const [index, page] of pages.entries()) if (page.needsReview)
        insertReview.run(id, page.page, index + 1, page.text, page.method, page.confidence, page.reviewReason);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { id, title: source.title, origin: source.origin, ...(source.url ? { url: source.url } : {}),
      published: source.published, revision: source.revision, sha256, createdAt, active: true,
      chunks: pieces.length, pendingPages: pages.length - safe.length };
  }

  reviewPages(id: string): KnowledgeReviewPage[] {
    const rows = this.db.prepare("SELECT page,file_page,text,method,confidence,reason,status FROM knowledge_review_pages WHERE document_id=? ORDER BY page")
      .all(id) as { page: number; file_page: number; text: string; method: KnowledgeReviewPage["method"]; confidence: number | null; reason: string; status: KnowledgeReviewPage["status"] }[];
    return rows.map(({ reason, file_page, ...row }) => ({ ...row, filePage: file_page, reviewReason: reason }));
  }

  pdf(id: string): Buffer | null {
    const row = this.db.prepare("SELECT pdf FROM knowledge_files WHERE document_id=?").get(id) as { pdf: Uint8Array } | undefined;
    return row ? Buffer.from(row.pdf) : null;
  }

  resolvePage(id: string, page: number, action: "approve" | "exclude", text = ""): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT status,text FROM knowledge_review_pages WHERE document_id=? AND page=?")
        .get(id, page) as { status: string; text: string } | undefined;
      if (!row || row.status !== "pending") { this.db.exec("ROLLBACK"); return false; }
      const approvedText = text.trim() || row.text.trim();
      if (action === "approve") {
        if (approvedText.length < 10 || approvedText.length > 20000) throw new Error("KNOWLEDGE_REVIEW_TEXT");
        const start = (this.db.prepare("SELECT coalesce(max(ordinal),0) AS last FROM chunks WHERE document_id=?")
          .get(id) as { last: number }).last;
        const pieces = chunkKnowledge(`[PDF ${page}페이지]\n\n${approvedText}`);
        const usage = this.db.prepare("SELECT coalesce(sum(length(text)),0) AS characters, count(*) AS chunks FROM chunks WHERE document_id=?")
          .get(id) as { characters: number; chunks: number };
        if (usage.characters + pieces.reduce((sum, piece) => sum + piece.text.length, 0) > 200000 || usage.chunks + pieces.length > 400)
          throw new Error("KNOWLEDGE_SIZE");
        const insert = this.db.prepare("INSERT INTO chunks(document_id,ordinal,page,text) VALUES(?,?,?,?)");
        for (const [index, piece] of pieces.entries()) insert.run(id, start + index + 1, page, piece.text);
      }
      this.db.prepare("UPDATE knowledge_review_pages SET approved_text=?,status=?,resolved_at=? WHERE document_id=? AND page=?")
        .run(action === "approve" ? approvedText : "", action === "approve" ? "approved" : "excluded", new Date().toISOString(), id, page);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  setActive(id: string, active: boolean): boolean {
    return Number(this.db.prepare("UPDATE documents SET active=? WHERE id=?").run(active ? 1 : 0, id).changes) === 1;
  }

  search(query: string, limit = 6, topic = ""): RetrievedReference[] {
    const needles = searchNeedles(query);
    if (!needles.length) return [];
    const topicNeedles = searchNeedles(topic);
    const match = needles.map((word) => `"${word}"`).join(" OR ");
    const rows = this.db.prepare(`SELECT d.*, c.ordinal, c.page, c.text
      FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid
      JOIN documents d ON d.id=c.document_id
      WHERE chunk_search MATCH ? AND d.active=1
      ORDER BY bm25(chunk_search) LIMIT 60`).all(match) as SearchRow[];
    const perDocument = new Map<string, number>();
    const selected: RetrievedReference[] = [];
    for (const row of rows) {
      const searchable = `${row.title} ${row.text}`.toLocaleLowerCase("ko-KR");
      const overlap = needles.filter((needle) => searchable.includes(needle)).length;
      const topicMatches = topicNeedles.length > 0 && topicNeedles.some((needle) => searchable.includes(needle));
      const minimumOverlap = topicMatches ? 2 : needles.length < 5 ? 1 : Math.max(2, Math.ceil(needles.length * 0.12));
      if (overlap < minimumOverlap) continue;
      if (topicNeedles.length && !topicMatches) continue;
      const count = perDocument.get(row.id) ?? 0;
      if (count >= 2) continue;
      perDocument.set(row.id, count + 1);
      selected.push({ id: `knowledge:${row.id}:${row.ordinal}`, documentId: row.id,
        title: row.title, url: row.url, excerpt: row.text,
        published: row.published || "발행일 미기재", revision: row.revision,
        origin: row.origin, ...(row.page ? { page: row.page } : {}) });
      if (selected.length >= limit) break;
    }
    return selected;
  }

  close(): void { this.db.close(); }
}

export function searchKnowledge(query: string, topic = ""): RetrievedReference[] {
  const base = new KnowledgeBase();
  try { return base.search(query, 6, topic); } finally { base.close(); }
}
