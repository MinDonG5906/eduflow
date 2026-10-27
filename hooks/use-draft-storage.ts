"use client";

import { useEffect, useRef, useState } from "react";
import type { SourceDocument } from "@/lib/documents";
import { deletePdf } from "@/lib/pdf-storage";
import type { Board, Settings } from "@/lib/storyboard";
import { DRAFT_STORAGE_KEY, restoreBrowserDraft, serializeDraft, type Draft } from "@/lib/studio-state";

// Keep the original key so existing Frame drafts open in EduFlow without migration.
const STORAGE = DRAFT_STORAGE_KEY;

type DraftState = { manuscript: string; settings: Settings; board: Board | null; document: SourceDocument | null };

export function useDraftStorage(
  { manuscript, settings, board, document }: DraftState,
  { onRestore, onError }: { onRestore: (draft: Draft, removedExample: boolean) => void; onError: (message: string) => void },
) {
  const [ready, setReady] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [saved, setSaved] = useState("브라우저에 자동 저장");
  const protectedDraftRef = useRef<string | null>(null);
  const savedPdfIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE);
      const { draft: parsed, removedExample } = restoreBrowserDraft(stored, localStorage);
      if (parsed) {
        savedPdfIdRef.current = parsed.document?.fileId;
        onRestore(parsed, removedExample);
        setSaved("이전 작업을 복구했어요");
      }
    } catch {
      protectedDraftRef.current = stored;
      setStorageBlocked(true);
      setSaved("기존 저장 데이터 보호 중");
      onError("저장된 작업을 복구하지 못해 자동 저장을 중지했습니다. 저장 원본을 내려받은 뒤 새 스토리보드로 시작해 주세요.");
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready || storageBlocked) return;
    let content: string;
    try {
      content = serializeDraft({ manuscript, settings, board, ...(document ? { document } : {}) });
    } catch {
      setSaved("자동 저장 보류");
      onError("입력값을 저장할 수 없습니다. 장면 시간과 생성 조건을 확인해 주세요. 기존 저장 내용은 유지됩니다.");
      return;
    }
    try {
      localStorage.setItem(STORAGE, content);
      const previousPdfId = savedPdfIdRef.current;
      savedPdfIdRef.current = document?.fileId;
      if (previousPdfId && previousPdfId !== document?.fileId) void deletePdf(previousPdfId).catch(() => {});
      setSaved("모든 변경사항 저장됨");
    } catch {
      setSaved("자동 저장 실패");
      onError("브라우저 저장 공간이 부족하거나 저장이 차단되어 있습니다. 결과를 내보내 주세요.");
    }
  }, [manuscript, settings, board, document, ready, storageBlocked]);

  return {
    ready,
    storageBlocked,
    saved,
    // The unreadable original stays untouched until the user starts over.
    protectedDraft: protectedDraftRef.current,
    releaseProtectedDraft() {
      protectedDraftRef.current = null;
      setStorageBlocked(false);
    },
  };
}
