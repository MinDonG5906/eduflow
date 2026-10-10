import { test } from "node:test";
import assert from "node:assert/strict";
import { correctIndustrialTerms, termCorrectionNotice } from "./term-corrections";

test("known safety typos are corrected with particles, compounds and repeated occurrences", () => {
  const result = correctIndustrialTerms("껴임, 껴임을, 껴임으로, 껴임이란, 껴임사고는, 껴임재해예방을 확인합니다.");
  assert.equal(result.text, "끼임, 끼임을, 끼임으로, 끼임이란, 끼임사고는, 끼임재해예방을 확인합니다.");
  assert.deepEqual(result.corrections, [{ from: "껴임", to: "끼임", count: 6 }]);
  assert.deepEqual(correctIndustrialTerms(result.text), { text: result.text, corrections: [] });
});

test("unknown words, names, correctly spelled terms and identifiers are not guessed", () => {
  const text = "맞껴임 껴임테크 A껴임 껴임ABC 껴임_01 끼임 추락 감전 임의의오타";
  assert.deepEqual(correctIndustrialTerms(text), { text, corrections: [] });
});

test("links, email addresses, filenames and code stay intact alongside corrected prose", () => {
  const protectedText = "https://example.com/껴임/ HTTPS://example.com/껴임 www.example.com/껴임 껴임@example.com 자료/껴임.pdf C:\\자료\\껴임.png 껴임.pdf를 참고하고 `껴임을` ```text\n껴임\n```";
  const result = correctIndustrialTerms(protectedText + "\n껴임을 확인합니다.");
  assert.equal(result.text, protectedText + "\n끼임을 확인합니다.");
  assert.equal(result.corrections[0].count, 1);
});

test("correction notices retain the pair, field locations and count within the response limit", () => {
  assert.equal(termCorrectionNotice([]), null);
  assert.equal(termCorrectionNotice([
    { from: "껴임", to: "끼임", count: 2, field: "나레이션" },
    { from: "껴임", to: "끼임", count: 1, field: "자막" },
  ]), "자동 용어 교정: ‘껴임’ → ‘끼임’ (나레이션·자막, 3곳).");
  const many = Array.from({ length: 100 }, (_, i) => ({ from: `오타${i}`, to: `교정${i}`, field: "나레이션", count: 1 }));
  assert.ok(termCorrectionNotice(many)!.length <= 300);
});
