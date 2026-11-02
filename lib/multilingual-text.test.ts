import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFParse } from "pdf-parse";
import { defaults, generateDemo, sample } from "./storyboard";
import { wrapCompositionText } from "./scene-composition";
import { graphemes, needsShaping, wrapLines } from "./text-segment";
import { exportStoryboardPdf } from "./server/pdf-export";
import { renderCompositionOverlay } from "./server/composition-render";

const vietnamese = "Trước khi vào công trường, hãy đội mũ bảo hộ và cài chặt dây đeo.";
const chinese = "进入工地前，请佩戴安全帽并系好下颚带。";
const sinhala = "වැඩබිමට ඇතුළු වීමට පෙර ආරක්ෂිත හිස්වැස්ම පළඳින්න.";
const khmer = "មុនពេលចូលការដ្ឋាន សូមពាក់មួកសុវត្ថិភាព និងរឹតខ្សែឲ្យតឹង។";
const length = (text: string) => graphemes(text).length;

test("wrapping keeps Khmer and Vietnamese words whole and closing punctuation attached", () => {
  const khmerLines = wrapLines(khmer, 12, length);
  assert.ok(khmerLines.length > 1);
  assert.equal(khmerLines.join(""), khmer.replace(/ /g, ""));
  for (const word of ["មុន", "ពេល", "សុវត្ថិភាព"]) assert.ok(khmerLines.some(line => line.includes(word)), `${word} split across lines`);
  assert.ok(khmerLines.every(line => !line.startsWith("។")));
  const vietnameseLines = wrapCompositionText(vietnamese, 20);
  assert.deepEqual(vietnameseLines.join(" ").split(" "), vietnamese.split(" "), "Latin words break only at spaces");
});

test("Korean and Chinese still break between characters", () => {
  assert.deepEqual(wrapCompositionText("안전모를반드시착용하세요", 5), ["안전모를반", "드시착용하", "세요"]);
  assert.ok(wrapLines(chinese, 6, length).every(line => length(line) <= 6));
});

test("only scripts that need shaping leave the pdf-lib text path", () => {
  assert.ok(needsShaping(sinhala) && needsShaping(khmer));
  assert.ok(![vietnamese, chinese, "안전모 착용"].some(needsShaping));
});

test("storyboard PDF keeps Vietnamese and Chinese as text and draws Sinhala and Khmer", async () => {
  const demo = generateDemo(sample, defaults);
  const languages = [vietnamese, chinese, sinhala, khmer];
  const board = { ...demo, scenes: demo.scenes.slice(0, 4).map((scene, i) => ({ ...scene, narration: languages[i], subtitle: languages[i] })) };
  const parser = new PDFParse({ data: await exportStoryboardPdf({ board }) });
  try {
    const text = (await parser.getText()).text.replace(/\s/g, "");
    assert.ok(text.includes(vietnamese.replace(/\s/g, "")), "Vietnamese letters must not be dropped");
    assert.ok(text.includes(chinese), "Chinese must be real text");
    assert.ok(text.includes("내레이션"));
  } finally { await parser.destroy(); }
});

test("storyboard image draws complex-script subtitles", async () => {
  const scene = { ...generateDemo(sample, defaults).scenes[0], subtitle: khmer, subtitleSettings: { enabled: true, position: "bottom" as const } };
  const image = await loadImage(await renderCompositionOverlay(scene, {}, true));
  const canvas = createCanvas(1600, 900), context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  const band = context.getImageData(100, 720, 1400, 160).data;
  let bright = 0;
  for (let i = 0; i < band.length; i += 4) if (band[i] > 200 && band[i + 1] > 200 && band[i + 2] > 200) bright++;
  assert.ok(bright > 2000, "subtitle glyphs must be drawn");
});
