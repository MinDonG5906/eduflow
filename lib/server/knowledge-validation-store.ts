import "server-only";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import type { KnowledgeMetadata } from "../knowledge";
import type { ValidationRun, ValidationJob } from "../knowledge-validation";

export const validationDirectory = () => join(process.cwd(), ".eduflow-private");
export const contentHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Separate staging: no FTS index and no entry in the live document collection. */
export class ValidationStore {
  private db: DatabaseSync;
  constructor(directory = validationDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("검사 보관함을 열 수 없습니다.");
    const path = join(directory, "knowledge-validation.sqlite");
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("검사 보관함을 열 수 없습니다.");
    closeSync(openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL, pdf BLOB NOT NULL, lock_token TEXT, locked_until INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS jobs(run_id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS worker(id INTEGER PRIMARY KEY, token TEXT, until INTEGER NOT NULL DEFAULT 0) STRICT;
      INSERT OR IGNORE INTO worker(id) VALUES(1);`);
  }
  create(metadata: KnowledgeMetadata, pdf: Buffer, pages: number[], testOnly = false) {
    const run: ValidationRun = { id: randomUUID(), createdAt: new Date().toISOString(), metadata,
      sha256: contentHash(pdf), pages: pages.map(page => ({ page, status: "pending", attempts: [] })), status: "staged", testOnly };
    this.db.prepare("INSERT INTO runs(id,data,pdf) VALUES(?,?,?)").run(run.id, JSON.stringify(run), pdf);
    return run;
  }
  list(): ValidationRun[] { return this.db.prepare("SELECT data FROM runs ORDER BY rowid DESC").all().map(row => JSON.parse(String(row.data))); }
  get(id: string): ValidationRun | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  pdf(id: string) {
    const row = this.db.prepare("SELECT pdf FROM runs WHERE id=?").get(id);
    if (!row) throw new Error("검사 자료를 찾지 못했습니다.");
    return Buffer.from(row.pdf as Uint8Array);
  }
  claim(id: string): string {
    const token = randomUUID();
    if (!this.db.prepare("UPDATE runs SET lock_token=?,locked_until=? WHERE id=? AND locked_until < ?")
      .run(token, Date.now() + 20 * 60_000, id, Date.now()).changes) throw new Error("이 자료의 다른 검사가 진행 중입니다.");
    return token;
  }
  save(run: ValidationRun, token: string) {
    if (!this.db.prepare("UPDATE runs SET data=? WHERE id=? AND lock_token=? AND locked_until > ?")
      .run(JSON.stringify(run), run.id, token, Date.now()).changes) throw new Error("검사 상태가 변경됐습니다. 다시 불러와 주세요.");
  }
  release(id: string, token: string) { this.db.prepare("UPDATE runs SET lock_token=NULL,locked_until=0 WHERE id=? AND lock_token=?").run(id, token); }
  jobs(): ValidationJob[] { return this.db.prepare("SELECT data FROM jobs ORDER BY rowid").all().map(row => JSON.parse(String(row.data))); }
  job(id: string) { return this.jobs().find(job => job.runId === id); }
  putJob(job: ValidationJob) { this.db.prepare("INSERT INTO jobs(run_id,data) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data").run(job.runId, JSON.stringify(job)); }
  enqueue(id: string) {
    const run = this.get(id); if (!run || run.quarantine) throw new Error("자동 처리할 자료를 확인해 주세요.");
    const previous = this.job(id);
    if (previous && ["queued", "processing", "waiting", "complete"].includes(previous.state)) return previous;
    const now = new Date().toISOString();
    const job: ValidationJob = { runId: id, state: "queued", updatedAt: now, retrySince: now, nextAt: 0, reason: "자동 처리 대기" };
    this.putJob(job); return job;
  }
  workerAlive(now = Date.now()) { return Number(this.db.prepare("SELECT until FROM worker WHERE id=1").get()?.until) > now; }
  claimWorker(now = Date.now()): string | undefined {
    const token = randomUUID();
    return this.db.prepare("UPDATE worker SET token=?,until=? WHERE id=1 AND until<=?").run(token, now + 600000, now).changes ? token : undefined;
  }
  releaseWorker(token: string) { this.db.prepare("UPDATE worker SET until=0,token=NULL WHERE id=1 AND token=?").run(token); }
  renewWorker(token: string) {
    if (!this.db.prepare("UPDATE worker SET until=? WHERE id=1 AND token=?").run(Date.now() + 600000, token).changes)
      throw new Error("자동 처리 작업자가 변경됐습니다.");
  }
  close() { this.db.close(); }
}
