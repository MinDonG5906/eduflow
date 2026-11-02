"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { apiErrorSchema, CLIENT_TIMEOUT_MS } from "@/lib/generation-contract";
import type { LocalizationTarget } from "@/lib/languages";
import { applyLocalization, localizationRequest, localizationResponseSchema, translationBatches } from "@/lib/localization";
import type { Board, Scene } from "@/lib/storyboard";

export type TranslationProgress = { language: LocalizationTarget; done: number; total: number } | null;

// Sends one batch at a time and saves each finished batch, so a failure or a
// cancel loses only the scenes still waiting. Each batch reads the latest board.
export function useLocalization(latestBoard: () => Board | null, setBoard: Dispatch<SetStateAction<Board | null>>) {
  const [progress, setProgress] = useState<TranslationProgress>(null);
  const [error, setError] = useState("");
  const running = useRef<AbortController | null>(null);

  async function translate(language: LocalizationTarget, scenes: Scene[]) {
    if (running.current || !scenes.length) return;
    const run = new AbortController();
    running.current = run;
    setError("");
    setProgress({ language, done: 0, total: scenes.length });
    let done = 0;
    try {
      for (const ids of translationBatches(scenes, language)) {
        const board = latestBoard();
        if (!board) break;
        const request = localizationRequest(board, language, ids);
        if (!request.scenes.length) continue;
        const response = await fetch("/api/localize", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
          signal: AbortSignal.any([run.signal, AbortSignal.timeout(CLIENT_TIMEOUT_MS)]),
        });
        const raw = await response.json().catch(() => null);
        // A reply that lands after 취소 is discarded, not applied.
        run.signal.throwIfAborted();
        if (!response.ok) {
          const failure = apiErrorSchema.safeParse(raw);
          throw new Error(failure.success ? failure.data.error : "번역하지 못했습니다.");
        }
        const parsed = localizationResponseSchema.safeParse(raw);
        if (!parsed.success || parsed.data.language !== language) throw new Error("번역 결과를 읽지 못했습니다.");
        setBoard(current => current ? applyLocalization(current, language, parsed.data.localization) : current);
        done += ids.length;
        setProgress({ language, done, total: scenes.length });
      }
    } catch (e) {
      const saved = done ? ` 번역한 ${done}개 장면은 저장했습니다.` : "";
      setError(run.signal.aborted ? `번역을 취소했습니다.${saved}`
        : e instanceof DOMException && e.name === "TimeoutError" ? `번역 시간이 초과되었습니다.${saved}`
        : `${e instanceof Error && e.message ? e.message : "번역하지 못했습니다."}${saved}`);
    } finally {
      running.current = null;
      setProgress(null);
    }
  }

  return { progress, error, clearError: () => setError(""), translate, cancel: () => running.current?.abort() };
}
