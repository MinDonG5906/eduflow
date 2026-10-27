"use client";

import { useEffect, useState } from "react";

// Toast text that clears itself after four seconds.
export function useNotice() {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  return [notice, setNotice] as const;
}

// Indicative progress while busy; it stops at 90% until the caller sets 100.
export function useBusyProgress(busy: boolean) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setProgress((p) => Math.min(p + 9, 90)), 180);
    return () => clearInterval(t);
  }, [busy]);
  return [progress, setProgress] as const;
}
