import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkKnowledge, knowledgeMetadataSchema, knowledgeSourceSchema, searchNeedles, type KnowledgeDocument, type KnowledgeImportPage, type KnowledgeLocation, type KnowledgeMetadata, type KnowledgeReviewPage, type KnowledgeSource, type RetrievedReference } from "../knowledge";

import { makeKnowledgeStructure, preserveKnowledgeReview, recommendationsForBlocks, tableRecommendationsForBlocks, structureChunks, type KnowledgeStructure } from "../knowledge-structure";
import { visualRelevance, visualSearchTerms } from "../knowledge-visual-search";

type DocumentRow = {
  id: string; title: string; origin: "official" | "internal"; url: string;
  published: string; revision: string; sha256: string; created_at: string;
  active: number; chunks: number; pending_pages?: number; has_file?: number;
};
type SearchRow = DocumentRow & { ordinal: number; page: number | null; text: string; block_ids: string; suffix?: string; visualId?: string };

function documentFromRow(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id, title: row.title, origin: row.origin, ...(row.url ? { url: row.url } : {}),
    published: row.published, revision: row.revision, sha256: row.sha256,
    createdAt: row.created_at, active: Boolean(row.active), chunks: row.chunks, pendingPages: row.pending_pages ?? 0, hasFile: Boolean(row.has_file),
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
      CREATE TABLE IF NOT EXISTS knowledge_structures (
        document_id TEXT NOT NULL REFERENCES documents(id), page INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(document_id, page)
      ) STRICT;
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
    const columns = this.db.prepare("PRAGMA table_info(chunks)").all();
    if (!columns.some(column => column.name === "block_ids")) this.db.exec("ALTER TABLE chunks ADD COLUMN block_ids TEXT NOT NULL DEFAULT '[]'");
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
      (SELECT count(*) FROM knowledge_review_pages r WHERE r.document_id=d.id AND r.status='pending') AS pending_pages,
      (SELECT count(*) FROM knowledge_files f WHERE f.document_id=d.id) AS has_file
      FROM documents d ORDER BY d.created_at DESC`).all() as DocumentRow[];
    return rows.map(documentFromRow);
  }

  addImported(meta: KnowledgeMetadata, sha256: string, pdf: Buffer, pages: KnowledgeImportPage[]): KnowledgeDocument {
    const source = knowledgeMetadataSchema.parse(meta);
    if (!pages.length || pages.length > 200 || pages.reduce((sum, page) => sum + page.text.length, 0) > 200000)
      throw new Error("KNOWLEDGE_SIZE");
    const structures = pages.map((page, index) => page.structure ?? makeKnowledgeStructure(page.page, index + 1, page.text, !page.needsReview));
    const safe = pages.filter((page) => !page.needsReview);
    const pieces = structures.filter(page => page.searchable).flatMap(page => structureChunks(page).map(chunk => ({ ...chunk, page: page.page })));
    if (pieces.length > 400 || pieces.reduce((sum, piece) => sum + piece.text.length, 0) > 200000) throw new Error("KNOWLEDGE_SIZE");
    const id = randomUUID(), createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT id FROM documents WHERE sha256=? AND active=1 LIMIT 1").get(sha256))
        throw new Error("KNOWLEDGE_DUPLICATE");
      this.db.prepare("INSERT INTO documents(id,title,origin,url,published,revision,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, source.title, source.origin, source.url ?? "", source.published, source.revision, sha256, createdAt);
      this.db.prepare("INSERT INTO knowledge_files(document_id,pdf) VALUES(?,?)").run(id, pdf);
      const insertChunk = this.db.prepare("INSERT INTO chunks(document_id,ordinal,page,text,block_ids) VALUES(?,?,?,?,?)");
      for (const [index, piece] of pieces.entries()) insertChunk.run(id, index + 1, piece.page, piece.text, JSON.stringify(piece.blockIds));
      for (const structure of structures) this.db.prepare("INSERT INTO knowledge_structures(document_id,page,data) VALUES(?,?,?)").run(id, structure.page, JSON.stringify(structure));
      const insertReview = this.db.prepare("INSERT INTO knowledge_review_pages(document_id,page,file_page,text,method,confidence,reason) VALUES(?,?,?,?,?,?,?)");
      for (const [index, page] of pages.entries()) if (page.needsReview)
        insertReview.run(id, page.page, index + 1, page.text, page.method, page.confidence, page.reviewReason);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { id, title: source.title, origin: source.origin, ...(source.url ? { url: source.url } : {}),
      published: source.published, revision: source.revision, sha256, createdAt, active: true,
      chunks: pieces.length, pendingPages: pages.length - safe.length, hasFile: true };
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

  recheckPending(id: string, updates: { originalPage: number; result: KnowledgeImportPage }[]): { autoIndexed: number; pendingPages: number } {
    let autoIndexed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const getPending = this.db.prepare("SELECT file_page FROM knowledge_review_pages WHERE document_id=? AND page=? AND status='pending'");
      const update = this.db.prepare("UPDATE knowledge_review_pages SET text=?,method=?,confidence=?,reason=?,status=?,approved_text=?,resolved_at=? WHERE document_id=? AND page=? AND status='pending'");
      for (const { originalPage, result } of updates) {
        const pending = getPending.get(id, originalPage) as { file_page: number } | undefined;
        if (!pending || pending.file_page !== result.page) continue;
        if (!result.needsReview) autoIndexed++;
        update.run(result.text, result.method, result.confidence, result.reviewReason,
          result.needsReview ? "pending" : "auto_indexed", result.needsReview ? "" : result.text,
          result.needsReview ? "" : new Date().toISOString(), id, originalPage);
        const structure = preserveKnowledgeReview(makeKnowledgeStructure(originalPage, pending.file_page, result.structure?.text ?? result.text,
          !result.needsReview, result.structure?.tables ?? []), this.structures(id).find(page => page.page === originalPage));
        structure.figureCandidates = result.structure?.figureCandidates;
        this.writeStructure(id, structure);
      }
      const pendingPages = (this.db.prepare("SELECT count(*) AS n FROM knowledge_review_pages WHERE document_id=? AND status='pending'")
        .get(id) as { n: number }).n;
      this.db.exec("COMMIT");
      return { autoIndexed, pendingPages };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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

      }
      this.db.prepare("UPDATE knowledge_review_pages SET approved_text=?,status=?,resolved_at=? WHERE document_id=? AND page=?")
        .run(action === "approve" ? approvedText : "", action === "approve" ? "approved" : "excluded", new Date().toISOString(), id, page);
      const structure = this.structures(id).find(item => item.page === page);
      if (structure) {
        const next = action === "exclude" ? { ...structure, searchable: false } : approvedText === row.text.trim()
          ? { ...structure, searchable: true }
          : makeKnowledgeStructure(page, structure.filePage, approvedText, true);
        this.writeStructure(id, next);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  setActive(id: string, active: boolean): boolean {
    return Number(this.db.prepare("UPDATE documents SET active=? WHERE id=?").run(active ? 1 : 0, id).changes) === 1;
  }

  deleteDocument(id: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM documents WHERE id=?").get(id)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      // The chunks trigger removes each row from the FTS index as well.
      this.db.prepare("DELETE FROM chunks WHERE document_id=?").run(id);
      this.db.prepare("DELETE FROM knowledge_review_pages WHERE document_id=?").run(id);
      this.db.prepare("DELETE FROM knowledge_structures WHERE document_id=?").run(id);
      this.db.prepare("DELETE FROM knowledge_files WHERE document_id=?").run(id);
      this.db.prepare("DELETE FROM documents WHERE id=?").run(id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  search(query: string, limit = 6, topic = ""): RetrievedReference[] {
    limit = Math.max(0, Math.min(20, Math.floor(limit)));
    if (!limit) return [];
    // Reserve an independent channel so a document's two text hits cannot starve its visuals.
    const visualSources = this.searchVisuals(query, Math.min(4, Math.ceil(limit / 2)), topic);
    const needles = searchNeedles(query);
    if (!needles.length) return visualSources;
    const topicNeedles = searchNeedles(topic);
    const match = needles.map((word) => `"${word}"`).join(" OR ");
    const rows = this.db.prepare(`SELECT d.*, c.ordinal, c.page, c.text, c.block_ids
      FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid
      JOIN documents d ON d.id=c.document_id
      WHERE chunk_search MATCH ? AND d.active=1
      ORDER BY bm25(chunk_search) LIMIT 60`).all(match) as SearchRow[];
    const perDocument = new Map<string, number>();
    const selected: RetrievedReference[] = [];
    const structures = new Map<string, KnowledgeStructure[]>();
    const expanded = rows.flatMap(row => {
      if (!structures.has(row.id)) structures.set(row.id, this.structures(row.id));
      const structure = structures.get(row.id)!.find(page => page.page === row.page);
      const ids: string[] = JSON.parse(row.block_ids);
      if (!structure || !ids.length) return [row];
      return ids.flatMap((id, index) => {
        const block = structure.blocks.find(block => block.id === id);
        if (!block) return [];
        return [
          { ...row, text: block.text.length <= 900 ? block.text : row.text, block_ids: JSON.stringify([id]), suffix: `:${index}` },
        ];
      }).sort((a,b) => needles.filter(n => b.text.toLocaleLowerCase("ko-KR").includes(n)).length - needles.filter(n => a.text.toLocaleLowerCase("ko-KR").includes(n)).length);
    });
    const selectedBlocks = new Set<string>();
    for (const row of expanded) {
      const blockKey = `${row.id}:${row.page}:${row.block_ids}:${row.visualId ?? "text"}`;
      if (row.suffix && selectedBlocks.has(blockKey)) continue;
      const searchable = `${row.title} ${row.text}`.toLocaleLowerCase("ko-KR");
      const overlap = needles.filter((needle) => searchable.includes(needle)).length;
      const topicMatches = topicNeedles.length > 0 && topicNeedles.some((needle) => searchable.includes(needle));
      const minimumOverlap = topicMatches ? 2 : needles.length < 5 ? 1 : Math.max(2, Math.ceil(needles.length * 0.12));
      if (overlap < minimumOverlap) continue;
      if (topicNeedles.length && !topicMatches) continue;
      const count = perDocument.get(row.id) ?? 0;
      if (count >= 2) continue;
      perDocument.set(row.id, count + 1);
      selectedBlocks.add(blockKey);
      const blockIds: string[] = JSON.parse(row.block_ids);
      selected.push({ id: `knowledge:${row.id}:${row.ordinal}${row.suffix ?? ""}`, documentId: row.id, blockIds, visuals: [],
        title: row.title, url: row.url, excerpt: row.text,
        published: row.published || "발행일 미기재", revision: row.revision,
        origin: row.origin, ...(row.page ? { page: row.page } : {}) });
      if (selected.length >= limit) break;
    }
    return [...selected.slice(0, limit - visualSources.length), ...visualSources];
  }

  searchVisuals(query: string, limit = 4, topic = ""): RetrievedReference[] {
    if (limit <= 0) return [];
    const terms = visualSearchTerms(query), topicTerms = visualSearchTerms(topic);
    if (!terms.length) return [];
    const rows = this.db.prepare(`SELECT d.*, s.data FROM knowledge_structures s
      JOIN documents d ON d.id=s.document_id JOIN knowledge_files f ON f.document_id=d.id
      WHERE d.active=1 AND NOT EXISTS (SELECT 1 FROM knowledge_review_pages r
        WHERE r.document_id=d.id AND r.page=s.page AND r.status='excluded')`).all() as (DocumentRow & { data: string })[];
    const candidates: { score: number; key: string; reference: RetrievedReference }[] = [];
    for (const row of rows) {
      const structure = JSON.parse(row.data) as KnowledgeStructure;
      const ids = structure.blocks.map(block => block.id);
      const visuals = [...ids.flatMap(id => recommendationsForBlocks(row.id, structure, [id])), ...tableRecommendationsForBlocks(row.id, structure, ids)];
      for (const visual of visuals) {
        const score = visualRelevance(visual, structure, terms);
        if (!score) continue;
        if (topicTerms.length && !visualRelevance(visual, structure, topicTerms) &&
          !topicTerms.some(term => row.title.normalize("NFC").toLocaleLowerCase("ko-KR").includes(term))) continue;
        const key = `${row.id}:${structure.page}:${visual.kind ?? "figure"}:${visual.figureId}`;
        candidates.push({ score, key, reference: {
          id: `knowledge:visual:${row.id}:${createHash("sha256").update(visual.id).digest("hex").slice(0, 24)}`, documentId: row.id, blockIds: [visual.blockId], visuals: [visual],
          title: row.title, url: row.url, excerpt: visual.quote, page: structure.page,
          published: row.published || "발행일 미기재", revision: row.revision, origin: row.origin,
        } });
      }
    }
    candidates.sort((a,b) => b.score - a.score || a.key.localeCompare(b.key));
    const byAsset = new Map<string, typeof candidates[number]>();
    for (const candidate of candidates) if (!byAsset.has(candidate.key)) byAsset.set(candidate.key, candidate);
    const unique = [...byAsset.values()];
    // Keep the best of each kind when both are relevant, then fill by relevance.
    const firstFigure = unique.find(item => item.reference.visuals![0].kind !== "table");
    const firstTable = unique.find(item => item.reference.visuals![0].kind === "table");
    const preferred = limit > 1 ? [firstFigure, firstTable].filter(item => item !== undefined) : [];
    const ordered = [...preferred, ...unique.filter(item => !preferred.includes(item))];
    return ordered.slice(0, limit).map(item => item.reference);
  }

  location(id: string, page?: number): KnowledgeLocation | null {
    const document = this.list().find(document => document.id === id);
    if (!document) return null;
    const structure = page ? this.structures(id).find(item => item.page === page) : undefined;
    const chunks = this.db.prepare("SELECT ordinal,text FROM chunks WHERE document_id=? AND (? IS NULL OR page=?) ORDER BY ordinal")
      .all(id, page ?? null, page ?? null) as { ordinal: number; text: string }[];
    if (page && !structure && !chunks.length) return null;
    return { document, ...(page ? { page } : {}), ...(structure ? { filePage: structure.filePage } : {}),
      passages: structure ? structure.blocks.map(block => ({ id: block.id, text: block.text }))
        : chunks.map(chunk => ({ id: `chunk-${chunk.ordinal}`, text: chunk.text })) };
  }

  /** Old registrations are reconstructed from stored page numbers, never renumbered as original pages. */
  structures(id: string): KnowledgeStructure[] {
    if (!this.db.prepare("SELECT 1 FROM knowledge_files WHERE document_id=?").get(id)) return [];
    const stored = this.db.prepare("SELECT page,data FROM knowledge_structures WHERE document_id=? ORDER BY page").all(id) as { page: number; data: string }[];
    const chunks = this.db.prepare("SELECT page,text FROM chunks WHERE document_id=? AND page IS NOT NULL ORDER BY ordinal").all(id) as { page: number; text: string }[];
    const reviews = this.db.prepare("SELECT page,file_page,text,approved_text,status FROM knowledge_review_pages WHERE document_id=?").all(id) as { page: number; file_page: number; text: string; approved_text: string; status: string }[];
    const numbers = [...new Set([...stored.map(p => p.page), ...chunks.map(p => p.page), ...reviews.map(p => p.page)])].sort((a,b) => a-b);
    return numbers.map((page, index) => {
      const saved = stored.find(item => item.page === page);
      if (saved) return JSON.parse(saved.data) as KnowledgeStructure;
      const review = reviews.find(item => item.page === page);
      const text = review ? review.approved_text || review.text : chunks.filter(item => item.page === page).map(item => item.text).join("\n\n");
      return makeKnowledgeStructure(page, review?.file_page ?? index + 1, text, !review || ["approved", "auto_indexed"].includes(review.status));
    });
  }

  private writeStructure(id: string, structure: KnowledgeStructure) {
    const excluded = this.db.prepare("SELECT status FROM knowledge_review_pages WHERE document_id=? AND page=?").get(id, structure.page)?.status === "excluded";
    const chunks = excluded ? [] : structureChunks(structure);
    const usage = this.db.prepare("SELECT count(*) AS n,coalesce(sum(length(text)),0) AS characters,coalesce(max(ordinal),0) AS last FROM chunks WHERE document_id=? AND (page IS NULL OR page<>?)")
      .get(id, structure.page) as { n: number; characters: number; last: number };
    if (usage.n + chunks.length > 400 || usage.characters + chunks.reduce((n, c) => n + c.text.length, 0) > 200000) throw new Error("KNOWLEDGE_SIZE");
    this.db.prepare("DELETE FROM chunks WHERE document_id=? AND page=?").run(id, structure.page);
    const insert = this.db.prepare("INSERT INTO chunks(document_id,ordinal,page,text,block_ids) VALUES(?,?,?,?,?)");
    for (const [index, chunk] of chunks.entries()) insert.run(id, usage.last + index + 1, structure.page, chunk.text, JSON.stringify(chunk.blockIds));
    this.db.prepare("INSERT INTO knowledge_structures(document_id,page,data) VALUES(?,?,?) ON CONFLICT(document_id,page) DO UPDATE SET data=excluded.data")
      .run(id, structure.page, JSON.stringify(structure));
  }

  saveStructure(id: string, structure: KnowledgeStructure, expected: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.structures(id).find(page => page.page === structure.page);
      if (!current || JSON.stringify(current) !== expected || current.filePage !== structure.filePage) { this.db.exec("ROLLBACK"); return false; }
      this.writeStructure(id, structure);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }
}

export function searchKnowledge(query: string, topic = ""): RetrievedReference[] {
  const base = new KnowledgeBase();
  try { return base.search(query, 6, topic); } finally { base.close(); }
}
