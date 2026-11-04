import test from "node:test";
import assert from "node:assert/strict";
import { referenceLocation, sceneReferenceLocations } from "./reference-location";
import { newScene, defaults, plainText } from "./storyboard";

const excerpt = "재해 사례\n● 사례1 : 계단으로 변압기 운반작업 중 전기공 깔림\n● 사례2 : 천장 전기작업 중 사다리와 함께 넘어짐\n● 사례3 : 천장 보와 작업대 난간 사이에 작업자 머리 끼임";
const quote = "천장 보와 작업대 난간 사이에 작업자 머리 끼임";
const reference = { id: "knowledge:test", title: "전기설비작업 안전", published: "2015", excerpt,
  origin: "official" as const, url: "https://example.org/source.pdf", page: 21,
  context: { documentTitle: "전기설비작업 안전", sectionTitle: "재해 사례", tableHeaders: [] } };

test("source locator identifies the cited case, not the first item in a retrieved paragraph", () => {
  const text = referenceLocation(reference, [quote, quote]);
  assert.match(text, /원본 21페이지 · 재해 사례/);
  assert.match(text, /항목: 사례3/);
  assert.doesNotMatch(text, /사례1|사례2/);
  assert.equal(text.match(/찾을 구절:/g)?.length, 1);
  assert.ok(text.includes(reference.url));
  assert.match(referenceLocation({ ...reference, page: undefined, context: undefined }), /페이지 정보 없음/);
  assert.match(referenceLocation(reference, ["없는 구절"]), /발췌 시작:/);
  assert.doesNotMatch(referenceLocation({ ...reference, excerpt: "사례1 : 확인\n사례2 : 확인" }, ["확인"]), /항목:/);
});

test("TXT keeps the compact locator and complete per-sentence evidence separately", () => {
  const scene = { ...newScene(), references: [reference], narration: "원문 내용입니다.", grounding: { status: "verified" as const,
    links: [{ referenceId: reference.id, field: "narration" as const, sentence: "원문 내용입니다.", start: 0, end: 10,
      quote, reason: "테스트 연결", value: "example" as const, applicability: "direct" as const }] } };
  const location = sceneReferenceLocations(scene);
  const text = plainText({ title: "출처 위치 테스트", summary: "출처", objectives: ["출처 확인"], scenes: [scene], settings: defaults, mode: "demo" });
  assert.ok(text.includes(location));
  assert.ok(text.includes(`원문 구절: ${quote}`));
  assert.doesNotMatch(text, /사례1 :/);
});
