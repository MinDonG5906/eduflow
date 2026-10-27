import "server-only";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DocumentImportError } from "./document-import-error";
import { runDocumentConversion } from "./document-conversion";
import { prepareOfficeFonts } from "./office-fonts";

let converting = false;

function validateHangul(name: string, data: Buffer) {
  if (!name || name.length > 255 || !/\.hwpx?$/i.test(name) || !data.length)
    throw new DocumentImportError("내용이 있는 HWP 또는 HWPX 파일을 선택해 주세요.");
  if (/\.hwp$/i.test(name)) {
    if (!data.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
      throw new DocumentImportError("지원하는 HWP 5 형식이 아닙니다. 한글에서 HWPX 또는 PDF로 저장해 올려 주세요.");
    return;
  }
  const invalid = () => new DocumentImportError("HWPX 파일을 열지 못했습니다. 손상·암호 여부를 확인해 주세요.");
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  }
  if (end < 0) throw invalid();
  const entries = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16), expanded = 0, header = false, section = false;
  const centralEnd = offset + data.readUInt32LE(end + 12);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || !entries || centralEnd > end) throw invalid();
  if (entries > 10000) throw new DocumentImportError("한글 문서의 구성 요소가 너무 많습니다. 필요한 부분을 나눠 올려 주세요.", 413);
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > centralEnd || data.readUInt32LE(offset) !== 0x02014b50 || data.readUInt16LE(offset + 8) & 1) throw invalid();
    expanded += data.readUInt32LE(offset + 24);
    if (expanded > Math.max(30 * 1024 * 1024, data.length * 4))
      throw new DocumentImportError("한글 문서의 압축 데이터가 비정상적으로 큽니다. 필요한 부분을 나눠 올려 주세요.", 413);
    const nameEnd = offset + 46 + data.readUInt16LE(offset + 28);
    const next = nameEnd + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
    if (next > centralEnd) throw invalid();
    const entry = data.toString("utf8", offset + 46, nameEnd);
    if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..")) throw invalid();
    if (entry === "Contents/header.xml") header = true;
    if (/^Contents\/section\d+\.xml$/.test(entry)) section = true;
    offset = next;
  }
  if (!header || !section || offset !== centralEnd) throw invalid();
}

async function findConverter() {
  const configured = process.env.EDUFLOW_HWP_CONVERTER_PATH?.trim();
  const executable = process.platform === "win32" ? "rhwp.exe" : "rhwp";
  const candidates = configured ? [configured] : [
    join(process.cwd(), ".eduflow-private", "tools", "rhwp", executable),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable)),
  ];
  for (const file of candidates) {
    try { await access(file, constants.X_OK); return file; } catch { /* Try the next installation. */ }
  }
  throw new DocumentImportError("이 PC에 한글 변환 도구가 연결되지 않았습니다. 프로젝트의 한글 변환 도구 설정을 완료하거나, 한글에서 PDF로 저장해 올려 주세요.", 503);
}

type ConversionOptions = {
  binary?: string; tempRoot?: string; fontFiles?: string[];
  run?: (binary: string, args: string[], signal: AbortSignal) => Promise<void>;
};

export async function convertHangul(name: string, data: Buffer, signal: AbortSignal, options: ConversionOptions = {}) {
  validateHangul(name, data);
  signal.throwIfAborted();
  if (converting) throw new DocumentImportError("다른 한글 문서를 변환하고 있습니다. 완료 후 다시 올려 주세요.", 429);
  converting = true;
  let directory: string | undefined;
  try {
    const binary = options.binary ?? await findConverter();
    signal.throwIfAborted();
    directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "eduflow-hwp-"));
    await prepareOfficeFonts(directory, options.fontFiles);
    const input = join(directory, /\.hwpx$/i.test(name) ? "source.hwpx" : "source.hwp"), output = join(directory, "source.pdf");
    await writeFile(input, data, { mode: 0o600 });
    const font = process.env.EDUFLOW_HWP_FALLBACK_FONT?.trim() || (process.platform === "darwin" ? "AppleGothic" : process.platform === "win32" ? "Malgun Gothic" : "Noto Sans CJK KR");
    // Embed the local font subset so Korean text survives the PDF preview.
    // The AI path analyzes these same visible pages and retains visual fallbacks.
    const run = options.run ?? ((bin, args, abort) => runDocumentConversion(bin, args, abort, 120_000, "한글 문서"));
    await run(binary, ["export-pdf", input, "-o", output, "--font-path", join(directory, "user", "fonts"), "--fallback-serif", font, "--fallback-sans", font], signal);
    signal.throwIfAborted();
    const pdf = await readFile(output);
    const { PDFDocument } = await import("pdf-lib");
    const pages = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
    if (!pages || pages > 200) throw new DocumentImportError("한글 문서는 최대 200페이지까지 불러올 수 있습니다. 필요한 부분을 나눠 올려 주세요.", 413);
    signal.throwIfAborted();
    return { pdf, pages };
  } catch (error) {
    if (signal.aborted) throw new DocumentImportError("한글 문서 불러오기를 취소했습니다. 기존 작업은 유지됩니다.", 499);
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError("한글 문서를 변환하지 못했습니다. 손상·암호 여부를 확인하거나, 한글에서 PDF로 저장해 올려 주세요.");
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { converting = false; }
  }
}
