/** Preserve notes edited in older drafts without exposing automatic review messages. */
export function sceneMemo(scene: { memo?: string; reviewReason: string; edited: string[] }): string {
  return scene.memo ?? (scene.edited.includes("reviewReason") ? scene.reviewReason : "");
}
