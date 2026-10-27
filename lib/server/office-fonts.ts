import "server-only";
import { constants } from "node:fs";
import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, win32 } from "node:path";
import { DocumentImportError } from "./document-import-error";

export function officeFontCandidates(platform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env) {
  if (platform === "darwin") return [
    "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
  ];
  if (platform === "win32") return ["malgun.ttf", "gulim.ttc", "batang.ttc"].map((name) => win32.join(env.WINDIR || "C:\\Windows", "Fonts", name));
  return [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansKR-Regular.otf",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
  ];
}

const fontError = () => new DocumentImportError("이 PC에 문서 변환용 한글 글꼴이 연결되지 않았습니다. 한글 글꼴을 연결한 뒤 다시 시도하거나, 원본 프로그램에서 PDF로 저장해 올려 주세요.", 503);

// Headless Office builds may see only bundled Latin fonts, even when the OS has
// Korean fonts. Expose a local CJK font through this conversion's private profile.
// No system font settings change and no font is uploaded or kept with the result.
export async function prepareOfficeFonts(profile: string, files?: string[]) {
  if (files === undefined) {
    const configured = process.env.EDUFLOW_OFFICE_FONT_FILES?.trim();
    if (configured) {
      files = configured.split(delimiter).map((file) => file.trim()).filter(Boolean);
      if (!files.length) throw fontError();
    }
    else {
      for (const file of officeFontCandidates()) {
        try { await access(file, constants.R_OK); files = [file]; break; }
        catch { /* Try the next installed Korean font. */ }
      }
      if (!files) throw fontError();
    }
  }
  const destination = join(profile, "user", "fonts");
  await mkdir(destination, { recursive: true });
  for (const [i, file] of [...new Set(files)].entries()) {
    if (!isAbsolute(file) || !/\.(?:ttf|otf|ttc)$/i.test(file)) throw fontError();
    try {
      if (!(await stat(file)).isFile()) throw fontError();
      await copyFile(file, join(destination, `font-${i}${extname(file)}`));
    } catch { throw fontError(); }
  }
}
