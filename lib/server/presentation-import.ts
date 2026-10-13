import "server-only";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DocumentImportError } from "./document-import-error";
import { prepareOfficeFonts } from "./office-fonts";
import { runDocumentConversion as runOfficeConversion } from "./document-conversion";
export { runDocumentConversion as runOfficeConversion } from "./document-conversion";

let converting = false;

function validatePresentation(name: string, data: Buffer) {
  if (!name || name.length > 255 || !/\.pptx?$/i.test(name) || !data.length)
    throw new DocumentImportError("내용이 있는 PPT 또는 PPTX 파일을 선택해 주세요.");
  if (/\.ppt$/i.test(name)) {
    if (!data.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
      throw new DocumentImportError("올바른 PPT 파일이 아닙니다. PowerPoint에서 다시 저장해 주세요.");
    return undefined;
  }
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  }
  if (end < 0) throw new DocumentImportError("PPTX를 열지 못했습니다. 손상되었거나 암호로 잠겨 있는지 확인해 주세요.");
  const entries = data.readUInt16LE(end + 10), centralEnd = data.readUInt32LE(end + 16) + data.readUInt32LE(end + 12);
  let offset = data.readUInt32LE(end + 16), expanded = 0, slides = 0, presentation = false;
  if (entries > 10000) throw new DocumentImportError("PPT의 구성 요소가 너무 많습니다. 필요한 부분을 나눠 올려 주세요.", 413);
  if (centralEnd > end) throw new DocumentImportError("PPTX 파일 구조를 읽을 수 없습니다.");
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > centralEnd || data.readUInt32LE(offset) !== 0x02014b50)
      throw new DocumentImportError("PPTX 파일 구조를 읽을 수 없습니다.");
    expanded += data.readUInt32LE(offset + 24);
    if (expanded > Math.max(30 * 1024 * 1024, data.length * 4))
      throw new DocumentImportError("PPT의 압축 데이터가 비정상적으로 큽니다. 파일을 다시 저장해 올려 주세요.", 413);
    const nameEnd = offset + 46 + data.readUInt16LE(offset + 28);
    const next = nameEnd + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
    if (next > centralEnd) throw new DocumentImportError("PPTX 파일 구조를 읽을 수 없습니다.");
    const entry = data.toString("utf8", offset + 46, nameEnd);
    if (entry === "ppt/presentation.xml") presentation = true;
    if (/^ppt\/slides\/slide\d+\.xml$/.test(entry)) slides++;
    offset = next;
  }
  if (!presentation || !slides) throw new DocumentImportError("슬라이드가 있는 PPTX 파일을 선택해 주세요.");
  if (slides > 200) throw new DocumentImportError("PPT는 최대 200슬라이드까지 불러올 수 있습니다. 필요한 부분을 나눠 올려 주세요.", 413);
  return slides;
}

async function findConverter() {
  const configured = process.env.EDUFLOW_OFFICE_CONVERTER_PATH?.trim();
  const candidates = configured ? [configured] : [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((dir) => process.platform === "win32" ? [join(dir, "soffice.com"), join(dir, "soffice.exe")] : [join(dir, "soffice")]),
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ...(process.env.ProgramFiles ? [join(process.env.ProgramFiles, "LibreOffice", "program", "soffice.com"), join(process.env.ProgramFiles, "LibreOffice", "program", "soffice.exe")] : []),
  ];
  for (const file of candidates) {
    try { await access(file, constants.X_OK); return file; } catch { /* Try the next installation. */ }
  }
  throw new DocumentImportError("이 PC에 PPT 변환 도구가 연결되지 않았습니다. LibreOffice를 설치·연결한 뒤 다시 시도하거나, PowerPoint에서 PDF로 저장해 올려 주세요.", 503);
}


type ConversionOptions = {
  binary?: string; tempRoot?: string; fontFiles?: string[];
  run?: (binary: string, args: string[], signal: AbortSignal) => Promise<void>;
};

export async function convertPresentation(name: string, data: Buffer, signal: AbortSignal, options: ConversionOptions = {}) {
  const expectedSlides = validatePresentation(name, data);
  signal.throwIfAborted();
  if (converting) throw new DocumentImportError("다른 PPT를 변환하고 있습니다. 완료 후 다시 올려 주세요.", 429);
  converting = true;
  let directory: string | undefined;
  try {
    const binary = options.binary ?? await findConverter();
    signal.throwIfAborted();
    directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "eduflow-ppt-"));
    const profile = join(directory, "profile"), output = join(directory, "output");
    await mkdir(join(profile, "user"), { recursive: true });
    await mkdir(output);
    await prepareOfficeFonts(profile, options.fontFiles);
    // A private profile avoids the user's Office settings and blocks document macros.
    await writeFile(join(profile, "user", "registrymodifications.xcu"), `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>`, { mode: 0o600 });
    const input = join(directory, /\.pptx$/i.test(name) ? "source.pptx" : "source.ppt");
    await writeFile(input, data, { mode: 0o600 });
    const filter = "pdf:impress_pdf_Export:" + JSON.stringify({
      ExportHiddenSlides: { type: "boolean", value: "true" },
      ExportNotesPages: { type: "boolean", value: "false" },
      ExportNotes: { type: "boolean", value: "false" },
      IsAddStream: { type: "boolean", value: "false" },
      UseLosslessCompression: { type: "boolean", value: "true" },
      PDFViewSelection: { type: "long", value: "3" },
    });
    await (options.run ?? runOfficeConversion)(binary, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--nologo", "--nodefault", "--norestore",
      "--convert-to", filter, "--outdir", output, input,
    ], signal);
    signal.throwIfAborted();
    const pdf = await readFile(join(output, "source.pdf"));
    const { PDFDocument } = await import("pdf-lib");
    const pages = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
    if (!pages || pages > 200) throw new DocumentImportError("PPT는 최대 200슬라이드까지 불러올 수 있습니다. 필요한 부분을 나눠 올려 주세요.", 413);
    if (expectedSlides && pages !== expectedSlides)
      throw new DocumentImportError("변환된 슬라이드 수가 원본과 다릅니다. PowerPoint에서 숨긴 슬라이드를 포함해 PDF로 저장해 올려 주세요.");
    signal.throwIfAborted();
    return { pdf, pages };
  } catch (error) {
    if (signal.aborted) throw new DocumentImportError("PPT 불러오기를 취소했습니다. 기존 작업은 유지됩니다.", 499);
    if (error instanceof DocumentImportError) throw error;
    throw new DocumentImportError("PPT를 변환하지 못했습니다. 손상·암호 여부를 확인하거나 PowerPoint에서 PDF로 저장해 올려 주세요.");
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { converting = false; }
  }
}
