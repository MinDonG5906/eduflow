import { test } from "node:test";
import assert from "node:assert/strict";
import { canStartGeneration } from "./generation-availability";

const readyPdf = {
  generator: { mode: "ai" as const, available: true, label: "AI", vendor: "OpenAI" as const },
  isPdf: true, valid: true, ready: true, busy: false, importing: false,
  documentPending: false, keyword: "", storageBlocked: false,
};
const demo = { mode: "demo" as const, available: true, label: "데모", vendor: null };

test("selected PDF stays blocked in demo and becomes eligible after AI connection", () => {
  assert.equal(canStartGeneration({ ...readyPdf, generator: demo }), false);
  assert.equal(canStartGeneration({ ...readyPdf, generator: null }), false);
  assert.equal(canStartGeneration({ ...readyPdf, generator: { ...readyPdf.generator, available: false } }), false);
  assert.equal(canStartGeneration(readyPdf), true);
  assert.equal(canStartGeneration({ ...readyPdf, generator: { ...readyPdf.generator, vendor: "Anthropic" } }), true);
});

test("AI connection cannot bypass PDF selection, recovery or other input blockers", () => {
  for (const blocked of [ {valid:false}, {ready:false}, {busy:true}, {importing:true}, {documentPending:true}, {keyword:"추가 전 키워드"}, {storageBlocked:true} ]) {
    assert.equal(canStartGeneration({ ...readyPdf, ...blocked }), false, JSON.stringify(blocked));
  }
});

test("valid direct text remains available in demo and AI modes", () => {
  assert.equal(canStartGeneration({ ...readyPdf, isPdf:false, generator:demo }), true);
  assert.equal(canStartGeneration({ ...readyPdf, isPdf:false }), true);
  assert.equal(canStartGeneration({ ...readyPdf, isPdf:false, generator:demo, valid:false }), false);
});
