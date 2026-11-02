import "server-only";
import { backup, DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDING_MODEL, EMBEDDING_REVISION, LocalSearchIndex } from "./knowledge-local-index";
import { PORTABILITY_FILE } from "./knowledge-portability";
import { parseWorkPackage } from "../work-package";
import type { ValidationRun, ValidationJob } from "../knowledge-validation";

export const DEMO_DATABASES = ["knowledge.sqlite", "knowledge-vectors.sqlite", "knowledge-validation.sqlite"] as const;
export function copyRegularTree(source: string, target: string) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("배포 자료의 심볼릭 링크는 포함할 수 없습니다.");
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) if (name !== ".DS_Store") copyRegularTree(join(source, name), join(target, name));
  } else if (stat.isFile()) cpSync(source, target, { errorOnExist: true, force: false });
  else throw new Error("일반 파일만 배포할 수 있습니다.");
}
export async function snapshotDemoKnowledge(source: string, target: string) {
  if (existsSync(target)) throw new Error("새 빈 폴더에 데모를 만들어 주세요.");
  const files = DEMO_DATABASES.filter(name => existsSync(join(source, name)));
  if (!files.includes("knowledge.sqlite")) throw new Error("전달할 지식베이스가 없습니다.");
  for (const name of files) {
    const stat = lstatSync(join(source, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("지식베이스 파일을 확인해 주세요.");
  }
  const identity = new LocalSearchIndex(source).identity;
  const guard = new DatabaseSync(join(source, files[0]));
  try {
    guard.exec("PRAGMA busy_timeout=2000");
    for (let i = 1; i < files.length; i++) guard.prepare(`ATTACH DATABASE ? AS snapshot${i}`).run(join(source, files[i]));
    // Reserve writes across all databases while separate read connections back up
    // one consistent snapshot. Never copy live SQLite/WAL files with fs.copyFile.
    guard.exec("BEGIN IMMEDIATE");
    const validationIndex = files.indexOf("knowledge-validation.sqlite");
    if (validationIndex >= 0) {
      const schema = validationIndex ? `snapshot${validationIndex}` : "main";
      if (guard.prepare(`SELECT 1 FROM ${schema}.runs WHERE locked_until > ? LIMIT 1`).get(Date.now()))
        throw new Error("자료 처리 중입니다. 처리가 끝난 뒤 다시 패키지를 만들어 주세요.");
    }
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of files) {
      const reader = new DatabaseSync(join(source, name), { readOnly: true });
      try { await backup(reader, join(target, name)); } finally { reader.close(); }
    }
    guard.exec("ROLLBACK");
  } finally { guard.close(); }
  const validation = join(target, "knowledge-validation.sqlite");
  if (existsSync(validation)) {
    const db = new DatabaseSync(validation);
    try {
      for (const row of db.prepare("SELECT id,data FROM runs").all()) {
        const run = JSON.parse(String(row.data)) as ValidationRun;
        if (run.backendIdentity && run.backendIdentity !== identity)
          throw new Error("다른 검색 저장소의 기록이 있습니다. 현재 로컬 검색 데이터로 이전한 뒤 다시 만들어 주세요.");
      }
      db.exec("UPDATE runs SET lock_token=NULL,locked_until=0; UPDATE worker SET token=NULL,until=0");
      for (const row of db.prepare("SELECT run_id,data FROM jobs").all()) {
        const job = JSON.parse(String(row.data)) as ValidationJob;
        if (["queued", "processing", "waiting"].includes(job.state)) {
          job.state = "paused"; job.reason = "데모 이전 후 자동 실행을 멈췄습니다. 필요할 때 다시 시작하세요."; job.nextAt = 0;
          db.prepare("UPDATE jobs SET data=? WHERE run_id=?").run(JSON.stringify(job), row.run_id);
        }
      }
    } finally { db.close(); }
  }
  writeFileSync(join(target, PORTABILITY_FILE), JSON.stringify({ version: 1, model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, identity }, null, 2));
  // Explicit allowlist: never include connection.json, .env, budgets, logs or tools.
  for (const cache of ["embedding-cache", "ocr-cache"]) if (existsSync(join(source, cache))) copyRegularTree(join(source, cache), join(target, cache));
  const example = join(source, "demo-work.json");
  if (existsSync(example)) {
    const raw = readFileSync(example, "utf8"); parseWorkPackage(raw);
    writeFileSync(join(target, "demo-work.json"), raw, { mode: 0o600 });
  }
  const db = new DatabaseSync(join(target, "knowledge.sqlite"), { readOnly: true });
  try { return { documents: Number(db.prepare("SELECT count(*) AS n FROM documents").get()!.n), chunks: Number(db.prepare("SELECT count(*) AS n FROM chunks").get()!.n), example: existsSync(join(target, "demo-work.json")) }; }
  finally { db.close(); }
}
