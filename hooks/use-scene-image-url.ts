"use client";
import { useEffect, useState } from "react";
import { loadSceneImage } from "@/lib/scene-image-storage";

export function useSceneImageUrl(id?: string) {
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    let active = true, url: string | undefined;
    if (id) loadSceneImage(id).then(blob => {
      if (!active || !blob) return;
      url = URL.createObjectURL(blob);
      setPreview({ id, url });
    }).catch(() => {});
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return preview?.id === id ? preview?.url : undefined;
}
