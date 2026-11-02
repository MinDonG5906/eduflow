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
