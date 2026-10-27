import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = "0.8.7";
const releases = {
  "darwin-arm64": ["macos-aarch64.tar.gz", "6ed46aa63f6d10c447842999f73abc59cf9586c5645fefc5e763bd6a6d43662d"],
  "darwin-x64": ["macos-x86_64.tar.gz", "07b1a5ea570e410d1b52b4d848a94f00c64674e84004883c62efad7daab61da4"],
  "linux-arm64": ["linux-aarch64.tar.gz", "c4a70f5ed11b99586ee89d1ac9069145d58a0831d00e87858bb01626e2ebf313"],
  "linux-x64": ["linux-x86_64.tar.gz", "f1e541a25cfe76b6bc1daf18bf9c1f9a5ac5e03e2c01b188daaf54107214f631"],
  "win32-x64": ["windows-x86_64.zip", "f7ac326e98f595ae8fecd8da7a614ee9a37db77bdf938782a8e07c9da473ec6f"],
};
const release = releases[`${process.platform}-${process.arch}`];
if (!release) throw new Error("이 운영체제/CPU용 한글 변환 도구가 없습니다. EDUFLOW_HWP_CONVERTER_PATH를 직접 설정해 주세요.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tools = join(root, ".eduflow-private", "tools"), destination = join(tools, "rhwp"), cache = join(tools, "cache");
await mkdir(cache, { recursive: true, mode: 0o700 });
const stage = await mkdtemp(join(tools, "rhwp-setup-"));
const exec = promisify(execFile);
const asset = `rhwp-v${version}-${release[0]}`, archive = join(cache, asset);

async function download(url, limit = 64 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error("공식 한글 변환 도구 다운로드에 실패했습니다.");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("다운로드 크기가 예상 범위를 넘었습니다.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

let replaced = false;
const backup = join(stage, "previous");
try {
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!bytes) bytes = await download(`https://github.com/edwardkim/rhwp/releases/download/v${version}/${asset}`);
  if (createHash("sha256").update(bytes).digest("hex") !== release[1])
    throw new Error("공식 배포 파일의 SHA256이 다릅니다. 설치를 중단했습니다.");
  await writeFile(archive, bytes, { mode: 0o600 });
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  const { stdout } = await exec(tar, ["-tf", archive], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (stdout.split(/\r?\n/).filter(Boolean).some((entry) => entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..")))
    throw new Error("배포 파일의 경로가 올바르지 않습니다.");
  const unpack = join(stage, "unpack"), install = join(stage, "install");
  await mkdir(unpack); await mkdir(install);
  await exec(tar, ["-xf", archive, "-C", unpack], { timeout: 30_000 });
  const executable = process.platform === "win32" ? "rhwp.exe" : "rhwp";
  const matches = (await readdir(unpack, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && entry.name === executable).map((entry) => join(entry.parentPath, entry.name));
  if (matches.length !== 1) throw new Error("배포 파일에서 한글 변환 실행 파일을 찾지 못했습니다.");
  const folder = dirname(matches[0]);
  await cp(folder, install, { recursive: true });
  await readFile(join(install, "LICENSE"));
  await chmod(join(install, executable), 0o700);
  const notices = await download(`https://raw.githubusercontent.com/edwardkim/rhwp/v${version}/THIRD_PARTY_LICENSES.md`, 4 * 1024 * 1024);
  await writeFile(join(install, "THIRD_PARTY_LICENSES.md"), notices, { mode: 0o600 });
  await writeFile(join(install, "VERSION"), `${version}\n${release[1]}\n`, { mode: 0o600 });
  try { await rename(destination, backup); replaced = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { await rename(install, destination); }
  catch (error) { if (replaced) await rename(backup, destination); throw error; }
  console.log(`한글 변환 도구 v${version} 설치 완료. 에듀플로우에서 HWP/HWPX를 불러올 수 있습니다.`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
