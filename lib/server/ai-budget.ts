import "server-only";
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, constants, existsSync, readFileSync, writeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GenerationError } from "../generation-contract";
import type { AIConfig } from "./ai-config";

type Reservation = {
  id: string; day: string; month: string; cost: number;
  attempts: number; settled: number; closed: number; active: number;
};

// One persistent PC, including multiple processes. Not a serverless/shared-host ledger.
export class LocalAIBudget {
  private readonly db: DatabaseSync;

  constructor(directory: string) {
    let database: DatabaseSync | undefined;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error();
      chmodSync(directory, 0o700);
      const filename = join(directory, "ai-budget.sqlite");
      const marker = join(directory, "ledger-created");
      const initialized = existsSync(marker);
      if (initialized && (!existsSync(filename) || lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8") !== "v1"))
        throw new Error();
      // Opening in append mode creates the file without ever truncating an old ledger.
      closeSync(openSync(filename, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
      if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw new Error();
      chmodSync(filename, 0o600);
      database = new DatabaseSync(filename);
      database.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;");
      if (initialized) {
        if (Number(database.prepare("PRAGMA user_version").get()?.user_version) !== 1) throw new Error();
        // Missing tables must not silently recreate empty budgets on an existing ledger.
        database.prepare("SELECT period,amount FROM budgets LIMIT 0").all();
        database.prepare("SELECT id,day,month,created,cost,attempts,settled,closed,active FROM reservations LIMIT 0").all();
      } else {
        database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS budgets (
          period TEXT PRIMARY KEY, amount INTEGER NOT NULL CHECK(amount >= 0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS reservations (
          id TEXT PRIMARY KEY, day TEXT NOT NULL, month TEXT NOT NULL, created INTEGER NOT NULL,
          cost INTEGER NOT NULL CHECK(cost > 0),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
          settled INTEGER NOT NULL DEFAULT 0 CHECK(settled BETWEEN 0 AND attempts),
          closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
        ) STRICT;
        PRAGMA user_version=1;
        COMMIT;
        `);
        try {
          const markerFile = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          try { writeSync(markerFile, "v1"); fsyncSync(markerFile); }
          finally { closeSync(markerFile); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8") !== "v1") throw error;
        }
      }
      this.db = database;
    } catch { database?.close(); throw new GenerationError("BUDGET_UNAVAILABLE"); }
  }

  private transaction<T>(operation: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError("BUDGET_UNAVAILABLE");
    }
  }

  reserve(config: AIConfig, now = Date.now()): string {
    return this.transaction(() => {
      if (config.reservationCost > config.requestBudget) throw new GenerationError("BUDGET_EXCEEDED");
      const active = this.db.prepare("SELECT count(*) AS n FROM reservations WHERE active=1").get()!;
      const recent = this.db.prepare("SELECT count(*) AS n FROM reservations WHERE created > ?").get(now - 3600000)!;
      if (Number(active.n) >= config.maxConcurrent || (config.requestsPerHour > 0 && Number(recent.n) >= config.requestsPerHour))
        throw new GenerationError("RATE_LIMITED");
      // UTC periods are deterministic across processes and independent of host timezone.
      const date = new Date(now).toISOString();
      const day = `day:${date.slice(0, 10)}`, month = `month:${date.slice(0, 7)}`;
      for (const [period, limit] of [[day, config.dayBudget], [month, config.monthBudget]] as const) {
        const used = Number(this.db.prepare("SELECT amount FROM budgets WHERE period=?").get(period)?.amount ?? 0);
        if (used + config.reservationCost > limit) throw new GenerationError("BUDGET_EXCEEDED");
        this.db.prepare("INSERT INTO budgets(period,amount) VALUES(?,?) ON CONFLICT(period) DO UPDATE SET amount=amount+excluded.amount")
          .run(period, config.reservationCost);
      }
      const id = crypto.randomUUID();
      this.db.prepare("INSERT INTO reservations(id,day,month,created,cost) VALUES(?,?,?,?,?)")
        .run(id, day, month, now, config.attemptCost);
      return id;
    });
  }

  /** Read-only scheduling hint. reserve() still enforces every limit at call time. */
  availability(config: AIConfig, now = Date.now()): { ready: boolean; nextAt: number; reason: string } {
    if (config.reservationCost > config.requestBudget) return { ready: false, nextAt: 0, reason: "요청당 비용 한도 설정 확인 필요" };
    if (Number(this.db.prepare("SELECT count(*) AS n FROM reservations WHERE active=1").get()?.n) >= config.maxConcurrent)
      return { ready: false, nextAt: now + 60000, reason: "다른 AI 작업이 끝나면 자동 재개" };
    const recent = this.db.prepare("SELECT created FROM reservations WHERE created>? ORDER BY created").all(now - 3600000);
    if (config.requestsPerHour > 0 && recent.length >= config.requestsPerHour)
      return { ready: false, nextAt: Number(recent[recent.length - config.requestsPerHour].created) + 3601000, reason: "시간당 호출 한도 · 자동 재개 대기" };
    const date = new Date(now), iso = date.toISOString();
    for (const [period, limit, nextAt, reason] of [
      [`month:${iso.slice(0, 7)}`, config.monthBudget, Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1), "월 비용 한도 · 다음 기간 자동 재개"],
      [`day:${iso.slice(0, 10)}`, config.dayBudget, Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1), "일 비용 한도 · 다음 기간 자동 재개"],
    ] as const) {
      const used = Number(this.db.prepare("SELECT amount FROM budgets WHERE period=?").get(period)?.amount ?? 0);
      if (used + config.reservationCost > limit) return { ready: false, nextAt, reason };
    }
    return { ready: true, nextAt: 0, reason: "" };
  }

  private reservation(id: string): Reservation {
    const row = this.db.prepare("SELECT * FROM reservations WHERE id=?").get(id);
    if (!row) throw new GenerationError("BUDGET_UNAVAILABLE");
    return row as unknown as Reservation;
  }

  startAttempt(id: string): void {
    this.transaction(() => {
      const row = this.reservation(id);
      if (!row.active || row.closed || row.attempts >= 2) throw new GenerationError("BUDGET_EXCEEDED");
      this.db.prepare("UPDATE reservations SET attempts=attempts+1 WHERE id=?").run(id);
    });
  }

  private releaseIfSettled(id: string): void {
    const row = this.reservation(id);
    if (!row.active || !row.closed || row.settled !== row.attempts) return;
    // Refund only calls known never to have started. Issued calls keep the full ceiling,
    // even on errors/cancellation, since the provider may already have charged them.
    const refund = (2 - row.attempts) * row.cost;
    for (const period of [row.day, row.month])
      this.db.prepare("UPDATE budgets SET amount=amount-? WHERE period=?").run(refund, period);
    this.db.prepare("UPDATE reservations SET active=0 WHERE id=?").run(id);
  }

  settleAttempt(id: string): void {
    this.transaction(() => {
      const row = this.reservation(id);
      if (row.settled >= row.attempts) throw new GenerationError("BUDGET_UNAVAILABLE");
      this.db.prepare("UPDATE reservations SET settled=settled+1 WHERE id=?").run(id);
      this.releaseIfSettled(id);
    });
  }

  finish(id: string): void {
    this.transaction(() => {
      this.reservation(id);
      this.db.prepare("UPDATE reservations SET closed=1 WHERE id=?").run(id);
      this.releaseIfSettled(id);
    });
  }

  close(): void { this.db.close(); }
}
