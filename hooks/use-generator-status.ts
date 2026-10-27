"use client";

import { useEffect, useState } from "react";
import type { GeneratorStatus } from "@/components/studio/types";

export function useGeneratorStatus(onError: (message: string) => void): GeneratorStatus {
  const [generator, setGenerator] = useState<GeneratorStatus>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/generate", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const status = await response.json();
        if (!["ai", "demo"].includes(status.mode) || typeof status.available !== "boolean") throw new Error();
        setGenerator({ mode: status.mode, available: status.available });
      }).catch(() => { if (!controller.signal.aborted) onError("생성 연결 상태를 확인하지 못했습니다. 화면을 새로고침해 주세요."); });
    return () => controller.abort();
  }, []);
  return generator;
}
