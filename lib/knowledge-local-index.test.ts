import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSearchIndex } from "./server/knowledge-local-index";

test("local vectors persist, rank, respect document allowlists and disable immediately", async t => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-vectors-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const embed = async (text: string) => { calls++; return text.includes("추락") ? [1, 0] : [0, 1]; };
  const index = new LocalSearchIndex(directory, embed), signal = AbortSignal.timeout(5000);
  const fall = await index.create("추락", signal), chemical = await index.create("화학", signal);
  const chunk = await index.addChunk(fall, "추락 안전망", signal);
  assert.equal(await index.addChunk(fall, "추락 안전망", signal), chunk);
  await index.addChunk(chemical, "화학물질 보호구", signal);
  await index.enabled(chemical, true, signal);
  assert.deepEqual(await index.retrieve("추락", [fall, chemical], signal), []);
  await index.enabled(fall, true, signal);
  const reopened = new LocalSearchIndex(directory, embed);
  assert.equal((await reopened.retrieve("추락", [fall], signal))[0].id, chunk);
  assert.deepEqual(await reopened.retrieve("추락", [chemical], signal), []);
  const before = calls; assert.deepEqual(await reopened.retrieve("추락", [], signal), []); assert.equal(calls, before);
  await reopened.enabled(fall, false, signal);
  assert.deepEqual(await index.retrieve("추락", [fall], signal), []);
});

test("failed or cancelled embeddings never insert a searchable chunk", async t => {
  const directory = mkdtempSync(join(tmpdir(), "eduflow-vectors-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const abort = new AbortController();
  const index = new LocalSearchIndex(directory, async () => { abort.abort(); return [1, 0]; });
  const id = await index.create("취소", AbortSignal.timeout(5000));
  await assert.rejects(index.addChunk(id, "추락", abort.signal));
  await index.enabled(id, true, AbortSignal.timeout(5000));
  const reopened = new LocalSearchIndex(directory, async () => [1, 0]);
  assert.deepEqual(await reopened.retrieve("추락", [id], AbortSignal.timeout(5000)), []);
});
