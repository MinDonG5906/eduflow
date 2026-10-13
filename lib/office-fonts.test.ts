import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { officeFontCandidates, prepareOfficeFonts } from "./server/office-fonts";
import { convertPresentation } from "./server/presentation-import";
import { DocumentImportError } from "./server/document-import-error";

test("Office font lookup supports Korean system fonts on macOS, Windows and Linux", () => {
  assert.ok(officeFontCandidates("darwin").some((path) => path.endsWith("AppleGothic.ttf")));
  assert.equal(officeFontCandidates("win32", { WINDIR: "D:\\Windows" })[0], "D:\\Windows\\Fonts\\malgun.ttf");
  assert.ok(officeFontCandidates("linux").some((path) => path.endsWith("NotoSansCJK-Regular.ttc")));
});

test("local font files are available only in the conversion profile, including paths with spaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-font-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const font = join(root, "한글 font.ttf"), profile = join(root, "private-profile");
  await writeFile(font, "LOCAL FONT BYTES");
  await prepareOfficeFonts(profile, [font, font]);
  assert.deepEqual(await readdir(join(profile, "user/fonts")), ["font-0.ttf"]);
  assert.equal(await readFile(join(profile, "user/fonts/font-0.ttf"), "utf8"), "LOCAL FONT BYTES");
  await rm(profile, { recursive: true });
  assert.equal(await readFile(font, "utf8"), "LOCAL FONT BYTES");
});

test("missing or invalid fonts stop conversion before Office runs and clean the profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eduflow-font-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const conversions = join(root, "conversions");
  await mkdir(conversions);
  let calls = 0;
  for (const font of [join(root, "PRIVATE-MISSING.ttf"), "relative.ttf", join(root, "file.exe"), root]) {
    await assert.rejects(convertPresentation("test.ppt", Buffer.from("d0cf11e0a1b11ae1", "hex"), new AbortController().signal, {
      binary: "test-converter", tempRoot: conversions, fontFiles: [font], run: async () => { calls++; },
    }), (error: unknown) => error instanceof DocumentImportError && error.status === 503 && !error.message.includes("PRIVATE"));
    assert.deepEqual(await readdir(conversions), []);
  }
  assert.equal(calls, 0);
});
