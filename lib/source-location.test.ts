import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { GenerationError } from "./generation-contract";
import { defaults } from "./storyboard";
import { findSourceMatches, matchBoxes, sourceIndexSchema, sourceLocationLabel, sourcePassages } from "./source-location";
import { indexPdfSource, pdfSourceIndexRequest } from "./server/pdf-source-index";

test("source locations are readable and verbatim quotes survive Korean wrapping without guessing a paraphrase", () => {
  assert.equal(sourceLocationLabel("pdf-page:20", "safety.hwp"), "원본 20페이지");
  assert.equal(sourceLocationLabel("pdf-page:9", "safety.pptx"), "원본 9슬라이드");
  assert.equal(sourceLocationLabel("sentence:3-5"), "원고 3~5번째 문장");
  assert.equal(sourceLocationLabel("sentence:5-3"), "근거 위치 미지정");
  assert.equal(sourceLocationLabel("manual"), "근거 위치 미지정");
  const text = "안전 안내\n안전 난간을 설치하고\n안전모를 착용합니다.\n다시 안전모를 착용합니다.";
  const [quote] = findSourceMatches(text, "본문에 ‘안전난간을 설치하고 안전모를 착용합니다.’라고 설명되어 있음.");
  assert.equal(text.slice(quote.start, quote.end), "안전 난간을 설치하고\n안전모를 착용합니다");
  assert.equal(findSourceMatches(text, "낙상 예방을 위해 보호 장구를 사용해야 합니다.").length, 0);
  assert.equal(findSourceMatches(text, "안전모를 착용합니다").length, 2);
  const fragment = findSourceMatches("앞부분은 다른 설명입니다. 위험하다면 그것을 줄이기 위한 대책을 실행합니다.", "‘앞부분이 요약된 설명이고, 위험하다면 그것을 줄이기 위한 대책을 실행합니다.’라고 설명됨")[0];
  assert.equal(fragment.kind, "fragment");
  assert.equal(fragment.characters, "위험하다면그것을줄이기위한대책을실행합니다".length);
  const nfd = "안전모를 착용".normalize("NFD");
  assert.equal(findSourceMatches(nfd, "안전모를 착용")[0].end, nfd.length);
  const emoji = "🛡️ 안전모 착용";
  assert.equal(emoji.slice(findSourceMatches(emoji, "안전모")[0].start, findSourceMatches(emoji, "안전모")[0].end), "안전모");
});

test("numeric signs, decimal points and limits cannot become false source matches", () => {
  assert.equal(findSourceMatches("높이 15m", "높이 1.5m").length, 0);
  assert.equal(findSourceMatches("온도 20℃", "온도 -20℃").length, 0);
  assert.equal(findSourceMatches("기울기 90° 이하", "기울기 90 이하").length, 0);
  assert.equal(findSourceMatches("비율 50%", "비율 50").length, 1); // verbatim partial queries are allowed
  assert.equal(findSourceMatches("높이 1.5 m", "높이 1.5m").length, 1);
});

test("adjacent glyph highlights combine into a readable line without crossing table columns or mutating the source", () => {
  const page = { page: 20, text: "Guard rail\nNext cell", runs: [
    { start: 0, end: 5, box: [0.1, 0.2, 0.2, 0.22] as [number, number, number, number] },
    { start: 6, end: 10, box: [0.21, 0.2, 0.25, 0.22] as [number, number, number, number] },
    { start: 11, end: 20, box: [0.6, 0.2, 0.8, 0.22] as [number, number, number, number] },
  ] };
  assert.deepEqual(matchBoxes(page, { start: 0, end: 20 }), [[0.1, 0.2, 0.25, 0.22], [0.6, 0.2, 0.8, 0.22]]);
  assert.equal(page.runs[0].box[2], 0.2);
});

async function sourcePdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of ["Overview only.", "Install the safety guard.", "Install the safety guard."]) {
    const page = document.addPage([400, 300]);
    page.drawText(text, { x: 60, y: 160, size: 12, font });
  }
  let x = 60;
  for (const character of "Wear a helmet.") {
    document.getPage(0).drawText(character, { x, y: 100, size: 12, font });
    x += font.widthOfTextAtSize(character, 12) + 0.1;
  }
  document.getPage(2).setCropBox(20, 30, 300, 220);
  document.getPage(2).setRotation(degrees(90));
  return document.save();
}

test("local PDF indexing keeps original page numbers, finds wrong-page citations and maps crop/rotation highlights", async () => {
  const index = sourceIndexSchema.parse(await indexPdfSource(await sourcePdf(), [5, 9, 12], new AbortController().signal));
  assert.deepEqual(index.pages.map(page => page.page), [5, 9, 12]);
  assert.ok(index.pages[0].text.includes("Wear a helmet."), "separate glyph objects must remain readable words");
  const found = index.pages.flatMap(page => findSourceMatches(page.text, "Install the safety guard").map(range => ({ page, range })));
  assert.deepEqual(found.map(hit => hit.page.page), [9, 12]);
  for (const { page, range } of found) {
    const boxes = matchBoxes(page, range);
    assert.equal(boxes.length, 1);
    const [left, top, right, bottom] = boxes[0];
    assert.ok(left >= 0 && top >= 0 && right > left && bottom > top && right <= 1 && bottom <= 1);
    const point = page.page === 9 ? [80 / 400, (300 - 164) / 300] : [(164 - 30) / 220, (80 - 20) / 300];
    assert.ok(left < point[0] && right > point[0] && top < point[1] && bottom > point[1], `text highlight misses original page ${page.page}`);
  }
  const passages = sourcePassages(index.pages[1].text);
  assert.equal(passages[0].number, 1);
  assert.match(passages[0].text, /Install the safety guard/);
});

function request(data: Uint8Array, pages: number[], origin = "http://localhost:3000") {
  const form = new FormData();
  form.set("input", JSON.stringify({ manuscript: "", settings: defaults, pdfSource: { name: "safety.hwp", pages } }));
  form.set("pdf", new Blob([new Uint8Array(data)], { type: "application/pdf" }), "selected-pages.pdf");
  return new Request("http://localhost:3000/api/documents/source", { method: "POST", headers: { origin }, body: form });
}

test("source endpoint is local, uncached, bounded and rejects invalid page mappings/origins", async () => {
  const data = await sourcePdf();
  const result = await pdfSourceIndexRequest(request(data, [5, 9, 12]));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(sourceIndexSchema.parse(await result.json()).pages[1].page, 9);
  assert.equal((await pdfSourceIndexRequest(request(data, [5, 9, 12], "https://outside.example"))).status, 403);
  assert.equal((await pdfSourceIndexRequest(request(data, [5]))).status, 400);
  assert.equal((await pdfSourceIndexRequest(request(new TextEncoder().encode("PRIVATE malformed content"), [5]))).status, 400);
  await assert.rejects(indexPdfSource(data, [5, 9, 12], AbortSignal.abort(new GenerationError("CANCELLED"))));
  const blank = await PDFDocument.create(); blank.addPage();
  assert.equal((await indexPdfSource(await blank.save(), [44], new AbortController().signal)).pages[0].text, "");
});
