import "server-only";
import { execFileSync, spawn } from "node:child_process";
import { DocumentImportError } from "./document-import-error";

export function runDocumentConversion(binary: string, args: string[], signal: AbortSignal, timeout = 120_000, format = "PPT"): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // A process group lets cancellation also stop the converter's child process.
    const child = spawn(binary, args, { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
    let failure: unknown;
    function stop(reason: unknown) {
      failure ??= reason;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else if (child.pid) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
      } catch { /* Process may already have exited. */ }
    }
    const abort = () => stop(signal.reason ?? new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new DocumentImportError(`${format} 변환에 시간이 오래 걸립니다. 문서를 나누거나 PDF로 저장해 올려 주세요.`, 408)), timeout);
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new DocumentImportError(`${format}를 변환하지 못했습니다. 암호·손상 여부를 확인하거나 원본 프로그램에서 PDF로 저장해 올려 주세요.`));
      else resolve();
    });
    if (signal.aborted) abort();
  });
}
