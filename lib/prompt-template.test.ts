import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROMPT_TEMPLATE, generationTask } from "./generation-contract";
import { PROVIDER_INSTRUCTION_SUFFIX } from "./server/provider-prompt";
import { defaults, generateDemo, sample } from "./storyboard";

const blocks = (value: object): string[] =>
  Object.values(value).flatMap((item) => typeof item === "string" ? [item] : blocks(item));

test("the prompt template document quotes every prompt block verbatim", () => {
  const document = readFileSync(new URL("../docs/08_PROMPT_TEMPLATE.md", import.meta.url), "utf8");
  for (const block of [...blocks(PROMPT_TEMPLATE), PROVIDER_INSTRUCTION_SUFFIX.trim()])
    assert.ok(document.includes(block), `docs/08_PROMPT_TEMPLATE.md is missing: ${block.slice(0, 40)}…`);
});

test("a full generation asks for the target length in seconds, a scene regeneration does not", () => {
  const full = generationTask({ manuscript: sample, settings: { ...defaults, minutes: 3 } });
  assert.equal(full.targetDurationSeconds, 180);
  assert.ok(full.instruction.includes(PROMPT_TEMPLATE.duration));
  assert.ok(full.instruction.startsWith(PROMPT_TEMPLATE.instruction));
  assert.ok(full.instruction.endsWith(PROMPT_TEMPLATE.manuscriptSource));

  const scene = { ...generateDemo(sample, defaults).scenes[0], id: crypto.randomUUID() };
  const regenerate = generationTask({ manuscript: sample, settings: defaults, scene });
  assert.equal("targetDurationSeconds" in regenerate, false);
  assert.ok(!regenerate.instruction.includes(PROMPT_TEMPLATE.duration));
});
