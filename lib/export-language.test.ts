import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFParse } from "pdf-parse";
import { applyLocalization, localizedBoard, masterHash, titleHash, type Localization } from "./localization";
import { defaults, generateDemo, markdown, sample } from "./storyboard";
import { srt, subtitleCues, vtt } from "./subtitles";
import { exportStoryboardPdf } from "./server/pdf-export";

const board = generateDemo(sample, defaults);
const vietnamese: Localization = {
  contractVersion: "eduflow-localization-v1", model: "fake", promptVersion: "fake", createdAt: new Date().toISOString(),
  title: "Trung hòa carbon", titleBasedOn: titleHash(board.title),
  scenes: Object.fromEntries(board.scenes.map((scene, i) => [scene.id, {
    title: `Cảnh ${i + 1}`, narration: `Lời dẫn ${i + 1}`, subtitle: `Phụ đề ${i + 1}\nDòng hai`,
    backTranslation: { title: "", narration: "", subtitle: "" }, basedOn: masterHash(scene), warnings: [],
  }])),
};
const translated = applyLocalization(board, "vi", vietnamese);

test("subtitle cues follow scene durations and skip empty subtitles", () => {
  const scenes = [{ ...board.scenes[0], duration: 30, subtitle: "첫 줄\n둘째 줄" }, { ...board.scenes[1], duration: 45, subtitle: " " }, { ...board.scenes[2], duration: 3605, subtitle: "마지막" }];
  assert.deepEqual(subtitleCues({ scenes }), [{ start: 0, end: 30, text: "첫 줄\n둘째 줄" }, { start: 75, end: 3680, text: "마지막" }]);
  const file = srt({ scenes });
  assert.ok(file.startsWith("﻿1\r\n00:00:00,000 --> 00:00:30,000\r\n첫 줄\r\n둘째 줄\r\n"));
  assert.ok(file.includes("2\r\n00:01:15,000 --> 01:01:20,000\r\n마지막\r\n"), "numbering stays continuous after a skipped scene");
  const web = vtt({ scenes: [{ ...scenes[0], subtitle: "a --> b" }] });
  assert.ok(web.startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:30.000\na → b\n"));
});

test("the localized board swaps viewer text only, with optional Korean subtitle lines", () => {
  const only = localizedBoard(translated, "vi");
  assert.equal(only.title, "Trung hòa carbon");
  assert.equal(only.scenes[0].narration, "Lời dẫn 1");
  assert.equal(only.scenes[0].subtitle, "Phụ đề 1\nDòng hai");
  assert.equal(only.scenes[0].evidence, board.scenes[0].evidence, "evidence stays Korean");
  assert.equal(localizedBoard(translated, "vi", "dual").scenes[0].subtitle, `Phụ đề 1\nDòng hai\n${board.scenes[0].subtitle}`);
  assert.deepEqual(localizedBoard(translated, "km"), translated, "no translation, no change");
  assert.ok(srt(only).includes("Phụ đề 1\r\nDòng hai"));
  assert.ok(markdown(only, "베트남어").includes("시청자 언어: 베트남어"));
});

test("a translated PDF labels the language and keeps the Korean master for staff", async () => {
  const parser = new PDFParse({ data: await exportStoryboardPdf({ board: localizedBoard(translated, "vi"),
    language: { label: "베트남어", master: Object.fromEntries(board.scenes.map(scene => [scene.id, { narration: scene.narration, subtitle: scene.subtitle }])) } }) });
  try {
    const text = (await parser.getText()).text.replace(/\s/g, "");
    for (const expected of ["자막(베트남어)", "내레이션(베트남어)", "한국어자막", "한국어내레이션", "언어:베트남어", "Lờidẫn1", board.scenes[0].narration.replace(/\s/g, "").slice(0, 20)])
      assert.ok(text.includes(expected), expected);
  } finally { await parser.destroy(); }
});
