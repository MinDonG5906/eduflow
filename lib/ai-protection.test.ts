import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { GenerationError, generationTask } from "./generation-contract";
import { defaults, generateDemo, sample } from "./storyboard";
import { readAIConfig, assertLocalAIRequest, usdMicros } from "./server/ai-config";
import { LocalAIBudget } from "./server/ai-budget";
import { protectPaidGeneration } from "./server/ai-protection";
import { createGenerateHandler } from "./server/generate-handler";
import { runGeneration, type GenerationAdapter } from "./server/generation-service";

const env: Record<string, string | undefined> = {
  EDUFLOW_AI_ENABLED: "true", EDUFLOW_AI_API_KEY: "fake-server-only-test-key",
  EDUFLOW_AI_MODEL: "fake-priced-model",
  EDUFLOW_AI_INPUT_USD_PER_MILLION: "1", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "2",
  EDUFLOW_AI_REQUEST_BUDGET_USD: "0.006", EDUFLOW_AI_DAY_BUDGET_USD: "10", EDUFLOW_AI_MONTH_BUDGET_USD: "20",
  EDUFLOW_AI_MAX_INPUT_TOKENS: "1000", EDUFLOW_AI_MAX_OUTPUT_TOKENS: "1000",
  EDUFLOW_AI_REQUESTS_PER_HOUR: "5", EDUFLOW_AI_MAX_CONCURRENT: "1",
};
const input = { manuscript: sample, settings: defaults };
const config = (overrides: Record<string, string | undefined> = {}) => readAIConfig({ ...env, ...overrides });
const coded = (code: string) => (error: unknown) => error instanceof GenerationError && error.code === code;
const localRequest = (origin = "http://127.0.0.1:3000", url = "http://127.0.0.1:3000/api/generate") =>
  new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) });
function temporary(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-budget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function inspect(directory: string) {
  const db = new DatabaseSync(join(directory, "ai-budget.sqlite"), { readOnly: true });
  try {
    return {
      budgets: db.prepare("SELECT * FROM budgets ORDER BY period").all(),
      reservations: db.prepare("SELECT * FROM reservations ORDER BY created").all(),
    };
  } finally { db.close(); }
}
function fakeAI(generate?: GenerationAdapter["generate"]): GenerationAdapter {
  return {
    mode: "ai", model: env.EDUFLOW_AI_MODEL!, promptVersion: "fake-v1",
    countInputTokens: () => 10,
    generate: generate ?? (async (request) => {
      const board = generateDemo(request.manuscript, request.settings, request.scene, request.direction);
      return { title: board.title, summary: board.summary, objectives: board.objectives,
        scenes: board.scenes.map(({ id, review, reviewReason, edited, generation, ...scene }, i) => ({ ...scene, sceneNo: i + 1 })) };
    }),
  };
}

test("the evidence judge shares generation's request/day/month reservation and token ceiling", async (t) => {
  for (const overLimit of [false, true]) {
    const directory = temporary(t), policy = config();
    const underlying = fakeAI();
    let counted = 0, generated = 0;
    const protectedRun = protectPaidGeneration(localRequest(), { ...underlying,
      countInputTokens: (_, context) => { counted++; return context.verification && overLimit ? policy.maxInputTokens + 1 : 10; },
      generate: async (request, context) => {
        generated++;
        return context.verification ? { verdicts: [] } : underlying.generate(request, context);
      },
    }, { config: policy, directory });
    const passage = generateDemo(input.manuscript, input.settings).scenes[1].narration;
    try {
      const board = await runGeneration(input, protectedRun.adapter, { references: [{ id: "knowledge:budget",
        documentId: crypto.randomUUID(), title: "탄소중립 자료", excerpt: passage.slice(0, 1500),
        origin: "internal", url: "", published: "", revision: "" }] });
      assert.ok(board.scenes.every(scene => !scene.references?.length));
    } finally { protectedRun.finish(); }
    assert.equal(counted, 2, "verification payload is counted separately");
    assert.equal(generated, overLimit ? 1 : 2);
    const ledger = inspect(directory);
    assert.equal(ledger.reservations.length, 1);
    assert.equal(ledger.reservations[0].attempts, generated);
    assert.equal(ledger.reservations[0].active, 0);
    assert.ok(ledger.budgets.every(row => row.amount === generated * policy.attemptCost));
  }
});

test("paid calls are disabled by default and incomplete/unsafe configuration fails without leaking secrets", () => {
  assert.throws(() => readAIConfig({}), coded("AI_DISABLED"));
  for (const override of [
    { EDUFLOW_AI_API_KEY: "" }, { EDUFLOW_AI_MODEL: "" }, { EDUFLOW_AI_INPUT_USD_PER_MILLION: "" },
    { EDUFLOW_AI_DAY_BUDGET_USD: "0" }, { EDUFLOW_AI_MAX_INPUT_TOKENS: "1e3" },
    { EDUFLOW_AI_MONTH_BUDGET_USD: "1" }, { NEXT_PUBLIC_EDUFLOW_AI_API_KEY: "fake-public-key" },
  ]) assert.throws(() => config(override), (error: unknown) => coded("AI_NOT_CONFIGURED")(error) &&
    error instanceof Error && !error.message.includes("fake-public-key") && !error.message.includes(env.EDUFLOW_AI_API_KEY!));
  assert.equal(usdMicros("0.000001"), 1);
  assert.equal(config().attemptCost, 3000);
  assert.equal(config().reservationCost, 6000);
  for (const amount of ["-1", "NaN", "Infinity", "1e2", "0.0000001"]) assert.throws(() => usdMicros(amount));
});

test("shared daily and monthly caps apply without personal budget settings and cannot be raised by them", () => {
  const defaults = config({ EDUFLOW_AI_DAY_BUDGET_USD: undefined, EDUFLOW_AI_MONTH_BUDGET_USD: undefined });
  assert.equal(defaults.dayBudget, 40_000_000);
  assert.equal(defaults.monthBudget, 40_000_000);
  const raised = config({ EDUFLOW_AI_DAY_BUDGET_USD: "100", EDUFLOW_AI_MONTH_BUDGET_USD: "200" });
  assert.equal(raised.dayBudget, defaults.dayBudget);
  assert.equal(raised.monthBudget, defaults.monthBudget);
  const lower = config({ EDUFLOW_AI_DAY_BUDGET_USD: "0.5", EDUFLOW_AI_MONTH_BUDGET_USD: "2" });
  assert.equal(lower.dayBudget, 500_000);
  assert.equal(lower.monthBudget, 2_000_000);
  assert.throws(() => config({ EDUFLOW_AI_REQUEST_BUDGET_USD: "21" }), coded("AI_NOT_CONFIGURED"));
});

test("110000 input tokens fit the configured repair budget while 110001 are blocked before generation", async (t) => {
  const policy = config({
    EDUFLOW_AI_INPUT_USD_PER_MILLION: "0.75", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4.50",
    EDUFLOW_AI_MAX_INPUT_TOKENS: "110000", EDUFLOW_AI_MAX_OUTPUT_TOKENS: "8000",
    EDUFLOW_AI_REQUEST_BUDGET_USD: "0.24",
  });
  assert.equal(policy.maxInputTokens, 110000);
  assert.equal(policy.attemptCost, 118500);
  assert.equal(policy.reservationCost, 237000);
  assert.equal(policy.dayBudget, 10000000);
  assert.equal(policy.monthBudget, 20000000);
  assert.throws(() => config({ EDUFLOW_AI_MAX_INPUT_TOKENS: "110001" }), coded("AI_NOT_CONFIGURED"));
  const underfunded = new LocalAIBudget(temporary(t)); t.after(() => underfunded.close());
  assert.throws(() => underfunded.reserve({ ...policy, requestBudget: 200000 }), coded("BUDGET_EXCEEDED"));
  for (const counted of [110000, 110001]) {
    let calls = 0;
    const provider = { ...fakeAI(async (_, context) => {
      calls++;
      assert.equal(context.limits?.maxInputTokens, 110000);
      assert.equal(context.limits?.maxOutputTokens, 8000);
      return "accepted";
    }), countInputTokens: () => counted };
    const run = protectPaidGeneration(localRequest(), provider, { directory: temporary(t), config: policy });
    try {
      const result = run.adapter.generate(input, { task: generationTask(input), signal: new AbortController().signal });
      if (counted === 110000) assert.equal(await result, "accepted");
      else await assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.equal(error.code, "TOKEN_LIMIT_EXCEEDED");
        assert.deepEqual(error.inputUsage, { inputTokens: 110001, maxInputTokens: 110000 });
        return true;
      });
    } finally { run.finish(); }
    assert.equal(calls, counted === 110000 ? 1 : 0);
  }
});

test("separate member PCs each receive the shared budget and preserve their own usage", (t) => {
  const firstDirectory = temporary(t), secondDirectory = temporary(t);
  const policy = config({
    EDUFLOW_AI_DAY_BUDGET_USD: "5", EDUFLOW_AI_MONTH_BUDGET_USD: "10",
    EDUFLOW_AI_REQUEST_BUDGET_USD: "2", EDUFLOW_AI_MAX_INPUT_TOKENS: "100000",
    EDUFLOW_AI_INPUT_USD_PER_MILLION: "2", EDUFLOW_AI_OUTPUT_USD_PER_MILLION: "4",
    EDUFLOW_AI_MAX_OUTPUT_TOKENS: "100000", EDUFLOW_AI_REQUESTS_PER_HOUR: "100",
  });
  const now = Date.parse("2026-10-11T10:00:00Z");
  const useDay = (budget: LocalAIBudget, timestamp: number) => {
    const id = budget.reserve(policy, timestamp);
    budget.startAttempt(id); budget.settleAttempt(id);
    budget.startAttempt(id); budget.settleAttempt(id); budget.finish(id);
  };
  const first = new LocalAIBudget(firstDirectory);
  for (let i = 0; i < 4; i++) useDay(first, now);
  assert.throws(() => first.reserve(policy, now + 1000), coded("BUDGET_EXCEEDED"));
  first.close();
  const second = new LocalAIBudget(secondDirectory);
  try { useDay(second, now); }
  finally { second.close(); }
  assert.equal(inspect(firstDirectory).budgets.find((row) => row.period === "day:2026-10-11")?.amount, 4_800_000);
  assert.equal(inspect(secondDirectory).budgets.find((row) => row.period === "day:2026-10-11")?.amount, 1_200_000);
  const reopened = new LocalAIBudget(firstDirectory);
  try {
    assert.throws(() => reopened.reserve(policy, now + 1000), coded("BUDGET_EXCEEDED"));
    // Daily turnover grants a new daily allowance, while the month remains capped.
    for (let day = 1; day < 5; day++) useDay(reopened, now + day * 86400000);
    assert.throws(() => reopened.reserve(policy, now + 5 * 86400000), coded("BUDGET_EXCEEDED"));
  } finally { reopened.close(); }
  assert.equal(inspect(firstDirectory).budgets.find((row) => row.period === "month:2026-10")?.amount, 9_600_000);
});

test("paid prototype admits only matching loopback browser origins", () => {
  assert.doesNotThrow(() => assertLocalAIRequest(localRequest()));
  assert.doesNotThrow(() => assertLocalAIRequest(localRequest("http://localhost:3000", "http://localhost:3000/api/generate")));
  for (const request of [localRequest("https://evil.example"), localRequest("http://127.0.0.1:3001"),
    localRequest("https://eduflow.example", "https://eduflow.example/api/generate"),
    new Request("http://127.0.0.1:3000/api/generate", { method: "POST" }),
  ]) assert.throws(() => assertLocalAIRequest(request), coded("AI_ACCESS_DENIED"));
});

test("Next.js normalized loopback URL uses the original Host and rejects spoofed or mismatched origins", () => {
  const request = (host: string, origin: string) => new Request("http://localhost:3000/api/generate", {
    headers: { host, origin, "content-type": "application/json" },
  });
  assert.doesNotThrow(() => assertLocalAIRequest(request("127.0.0.1:3000", "http://127.0.0.1:3000")));
  assert.doesNotThrow(() => assertLocalAIRequest(request("[::1]:3000", "http://[::1]:3000")));
  for (const [host, origin] of [
    ["evil.example:3000", "http://evil.example:3000"],
    ["127.0.0.1:3001", "http://127.0.0.1:3001"],
    ["127.0.0.1:3000", "http://localhost:3000"],
    ["evil.example@localhost:3000", "http://localhost:3000"],
  ]) assert.throws(() => assertLocalAIRequest(request(host, origin)), coded("AI_ACCESS_DENIED"));
});

test("request/day budget is reserved before work and persists across reopening", (t) => {
  const directory = temporary(t), policy = config({ EDUFLOW_AI_DAY_BUDGET_USD: "0.006" });
  const first = new LocalAIBudget(directory);
  assert.throws(() => first.reserve(config({ EDUFLOW_AI_REQUEST_BUDGET_USD: "0.005" })), coded("BUDGET_EXCEEDED"));
  const id = first.reserve(policy);
  first.startAttempt(id); first.settleAttempt(id); first.finish(id); first.close();
  const reopened = new LocalAIBudget(directory);
  try { assert.throws(() => reopened.reserve(policy), coded("BUDGET_EXCEEDED")); }
  finally { reopened.close(); }
  assert.ok(inspect(directory).budgets.every((row) => row.amount === 3000));
});

test("repair cost is retained, a third provider call is blocked, and hourly counts survive completion", (t) => {
  const directory = temporary(t), budget = new LocalAIBudget(directory);
  const policy = config({ EDUFLOW_AI_REQUESTS_PER_HOUR: "1" });
  const now = Date.parse("2026-10-08T10:00:00Z"), id = budget.reserve(policy, now);
  budget.startAttempt(id); budget.settleAttempt(id); budget.startAttempt(id); budget.settleAttempt(id);
  assert.throws(() => budget.startAttempt(id), coded("BUDGET_EXCEEDED"));
  budget.finish(id);
  assert.throws(() => budget.reserve(policy, now + 1000), coded("RATE_LIMITED"));
  const later = budget.reserve(policy, now + 3600001);
  budget.finish(later); budget.close();
  assert.ok(inspect(directory).budgets.every((row) => row.amount === 6000));
});

test("daily turnover cannot bypass monthly budget; new month has its own ceiling", (t) => {
  const directory = temporary(t), budget = new LocalAIBudget(directory);
  const policy = config({ EDUFLOW_AI_DAY_BUDGET_USD: "0.006", EDUFLOW_AI_MONTH_BUDGET_USD: "0.009" });
  const id = budget.reserve(policy, Date.parse("2026-10-08T12:00:00Z"));
  budget.startAttempt(id); budget.settleAttempt(id); budget.startAttempt(id); budget.settleAttempt(id); budget.finish(id);
  assert.throws(() => budget.reserve(policy, Date.parse("2026-10-09T12:00:00Z")), coded("BUDGET_EXCEEDED"));
  const next = budget.reserve(policy, Date.parse("2026-11-01T12:00:00Z"));
  budget.finish(next); budget.close();
  assert.equal(inspect(directory).budgets.find((row) => row.period === "month:2026-10")?.amount, 6000);
});

test("restart and unfinished cancellation do not release concurrency or uncertain charges", (t) => {
  const directory = temporary(t), policy = config();
  const budget = new LocalAIBudget(directory), id = budget.reserve(policy);
  budget.startAttempt(id); budget.finish(id); budget.close();
  const reopened = new LocalAIBudget(directory);
  assert.throws(() => reopened.reserve(policy), coded("RATE_LIMITED"));
  assert.ok(inspect(directory).budgets.every((row) => row.amount === 6000));
  reopened.settleAttempt(id);
  const next = reopened.reserve(policy); reopened.finish(next); reopened.close();
  assert.ok(inspect(directory).budgets.every((row) => row.amount === 3000));
});

test("independent server processes cannot both reserve the last available budget", async (t) => {
  const directory = temporary(t);
  const initial = new LocalAIBudget(directory); initial.close();
  const moduleURL = new URL("./server/ai-budget.ts", import.meta.url).href;
  const policy = config({ EDUFLOW_AI_DAY_BUDGET_USD: "0.006", EDUFLOW_AI_MAX_CONCURRENT: "4" });
  // Test configuration includes no credentials in child arguments or output.
  const { apiKey, ...publicPolicy } = policy;
  const script = `import {LocalAIBudget} from ${JSON.stringify(moduleURL)};
    const b = new LocalAIBudget(${JSON.stringify(directory)});
    try { b.reserve(${JSON.stringify(publicPolicy)}); process.stdout.write("allowed"); }
    catch(e) { process.stdout.write(e.code || "failed"); } finally { b.close(); }`;
  const child = () => new Promise<string>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", script], { cwd: globalThis.process.cwd() });
    let output = ""; process.stdout.on("data", (chunk) => { output += chunk; });
    process.on("error", reject); process.on("close", (code) => code === 0 ? resolve(output) : reject(new Error("child failed")));
  });
  assert.deepEqual((await Promise.all([child(), child()])).sort(), ["BUDGET_EXCEEDED", "allowed"]);
});

test("damaged usage ledger fails closed rather than silently resetting", (t) => {
  const directory = temporary(t);
  writeFileSync(join(directory, "ai-budget.sqlite"), "damaged data");
  assert.throws(() => new LocalAIBudget(directory), coded("BUDGET_UNAVAILABLE"));
  assert.equal(readFileSync(join(directory, "ai-budget.sqlite"), "utf8"), "damaged data");
});

test("a deleted initialized ledger or missing table cannot reset the spending ceiling", (t) => {
  for (const damage of ["deleted", "missing-table"]) {
    const directory = temporary(t), budget = new LocalAIBudget(directory); budget.close();
    const filename = join(directory, "ai-budget.sqlite");
    if (damage === "deleted") rmSync(filename);
    else {
      const database = new DatabaseSync(filename);
      database.exec("DROP TABLE budgets"); database.close();
    }
    assert.throws(() => new LocalAIBudget(directory), coded("BUDGET_UNAVAILABLE"));
  }
});

test("paid wrapper passes server token ceilings and waits for ignored cancellation before releasing", async (t) => {
  const directory = temporary(t), policy = config();
  let complete!: (value: unknown) => void;
  const provider = fakeAI(async (_, context) => {
    assert.deepEqual(context.limits, { maxInputTokens: 1000, maxOutputTokens: 1000, maxProviderCalls: 1 });
    assert.ok(!JSON.stringify(context).includes(policy.apiKey));
    return new Promise((resolve) => { complete = resolve; });
  });
  const protectedRun = protectPaidGeneration(localRequest(), provider, { directory, config: policy });
  try { await assert.rejects(runGeneration(input, protectedRun.adapter, { timeoutMs: 20 }), coded("TIMEOUT")); }
  finally { protectedRun.finish(); }
  assert.throws(() => protectPaidGeneration(localRequest(), provider, { directory, config: policy }), coded("RATE_LIMITED"));
  complete(null);
  await new Promise((resolve) => setImmediate(resolve));
  const next = protectPaidGeneration(localRequest(), provider, { directory, config: policy }); next.finish();
  assert.ok(inspect(directory).budgets.every((row) => row.amount === 3000));
});

test("missing token counter or excessive input is blocked before a paid provider call", async (t) => {
  const directory = temporary(t), policy = config();
  const missing = fakeAI(); delete missing.countInputTokens;
  assert.throws(() => protectPaidGeneration(localRequest(), missing, { directory, config: policy }), coded("AI_NOT_CONFIGURED"));
  let calls = 0;
  const oversized = { ...fakeAI(async () => { calls++; return null; }), countInputTokens: () => 1001 };
  const protectedRun = protectPaidGeneration(localRequest(), oversized, { directory, config: policy });
  try { await assert.rejects(runGeneration(input, protectedRun.adapter), (error: unknown) => {
    assert.ok(error instanceof GenerationError);
    assert.equal(error.code, "TOKEN_LIMIT_EXCEEDED");
    assert.deepEqual(error.inputUsage, { inputTokens: 1001, maxInputTokens: 1000 });
    return true;
  }); }
  finally { protectedRun.finish(); }
  assert.equal(calls, 0);
  assert.ok(inspect(directory).budgets.every((row) => row.amount === 0));
});

test("paid HTTP handler cannot bypass missing configuration; demo still works with AI locked", async () => {
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env, { EDUFLOW_AI_ENABLED: "false" });
  try {
    let calls = 0;
    const paid = createGenerateHandler(fakeAI(async () => { calls++; return null; }));
    const disabled = await paid(localRequest());
    assert.equal(disabled.status, 503); assert.equal((await disabled.json()).code, "AI_DISABLED");
    process.env.EDUFLOW_AI_ENABLED = "true"; process.env.EDUFLOW_AI_API_KEY = "";
    const invalid = await paid(localRequest());
    assert.equal(invalid.status, 503); assert.equal((await invalid.json()).retryable, false); assert.equal(calls, 0);
    const demo = { ...fakeAI(), mode: "demo" as const };
    const response = await createGenerateHandler(demo)(localRequest());
    assert.equal(response.status, 200); assert.equal((await response.json()).mode, "demo");
    assert.ok(!JSON.stringify(generationTask(input)).includes(env.EDUFLOW_AI_API_KEY!));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});


test("zero hourly cap allows more than 100 sequential requests but preserves budget and concurrency limits", t => {
  const directory = temporary(t), budget = new LocalAIBudget(directory);
  t.after(() => budget.close());
  const policy = config({ EDUFLOW_AI_REQUESTS_PER_HOUR: "0" });
  const now = Date.parse("2026-11-01T04:00:00Z");
  assert.equal(policy.requestsPerHour, 0);
  for (let i = 0; i < 105; i++) {
    assert.equal(budget.availability(policy, now).ready, true);
    const id = budget.reserve(policy, now);
    budget.startAttempt(id); budget.settleAttempt(id); budget.finish(id);
  }
  const active = budget.reserve(policy, now);
  assert.equal(budget.availability(policy, now).ready, false);
  assert.throws(() => budget.reserve(policy, now), coded("RATE_LIMITED"));
  budget.finish(active);
  const dayLimited = config({ EDUFLOW_AI_REQUESTS_PER_HOUR: "0", EDUFLOW_AI_DAY_BUDGET_USD: "0.315" });
  assert.match(budget.availability(dayLimited, now).reason, /일 비용 한도/);
  assert.throws(() => budget.reserve(dayLimited, now), coded("BUDGET_EXCEEDED"));
  const monthLimited = config({ EDUFLOW_AI_REQUESTS_PER_HOUR: "0", EDUFLOW_AI_DAY_BUDGET_USD: "0.315", EDUFLOW_AI_MONTH_BUDGET_USD: "0.315" });
  assert.match(budget.availability(monthLimited, now + 86400000).reason, /월 비용 한도/);
  assert.throws(() => budget.reserve(monthLimited, now + 86400000), coded("BUDGET_EXCEEDED"));
});
