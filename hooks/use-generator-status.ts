"use client";

import { useEffect, useState } from "react";
import type { GeneratorStatus } from "@/components/studio/types";

// The connection screen fires this after any change so the badge and send notices update.
export const CONNECTION_CHANGED = "eduflow:connection-changed";

export function useGeneratorStatus(onError: (message: string) => void): GeneratorStatus {
  const [generator, setGenerator] = useState<GeneratorStatus>(null);
  useEffect(() => {
    let controller = new AbortController();
    const load = () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      fetch("/api/generate", { cache: "no-store", signal })
        .then(async (response) => {
          if (!response.ok) throw new Error();
          const status = await response.json();
          if (!["ai", "demo"].includes(status.mode) || typeof status.available !== "boolean" || typeof status.label !== "string" ||
              ![null, "OpenAI", "Anthropic", "Google"].includes(status.vendor)) throw new Error();
          setGenerator({ mode: status.mode, available: status.available, label: status.label, vendor: status.vendor });
        }).catch(() => { if (!signal.aborted) onError("생성 연결 상태를 확인하지 못했습니다. 화면을 새로고침해 주세요."); });
    };
    load();
    window.addEventListener(CONNECTION_CHANGED, load);
    return () => {
      window.removeEventListener(CONNECTION_CHANGED, load);
      controller.abort();
    };
  }, []);
  return generator;
}
