"use client";

import { useEffect, useRef, useState } from "react";
import { loadPdf } from "@/lib/pdf-storage";

// The original upload lives only in memory; the selected pages are restored from IndexedDB.
export function usePdfSelection(fileId: string | undefined, onError: (message: string) => void) {
  const [original, setOriginal] = useState<File | null>(null);
  const [selected, setSelected] = useState<Blob | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerVersion, setPickerVersion] = useState(0);
  const originalRef = useRef<File | null>(null);

  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    loadPdf(fileId).then((file) => {
      if (cancelled) return;
      setSelected(file ?? null);
      if (!file) onError("저장된 PDF를 찾지 못했습니다. 원본 PDF를 다시 불러와 페이지를 선택해 주세요.");
    }).catch(() => { if (!cancelled) onError("저장된 PDF를 열지 못했습니다. PDF를 다시 불러와 주세요."); });
    return () => { cancelled = true; };
  }, [fileId]);

  return {
    original,
    selected,
    pickerOpen,
    pickerVersion,
    setPickerOpen,
    open(file: File) {
      setPickerVersion((version) => version + 1);
      setOriginal(file); originalRef.current = file; setPickerOpen(true);
    },
    select(blob: Blob) {
      setSelected(blob); setPickerOpen(false);
    },
    clear() {
      setOriginal(null); originalRef.current = null;
      setSelected(null); setPickerOpen(false);
    },
    // True while `file` is still the loaded original, across awaits.
    isCurrent(file: File) {
      return originalRef.current === file;
    },
  };
}
