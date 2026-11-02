import type { EvidenceVerificationRequest } from "../server/generation-grounding";

/** Deterministic judge fixture, not a semantic quality claim about a live provider. */
export function visualVerdicts(request: EvidenceVerificationRequest, sceneIndex = 1) {
  return { verdicts: request.pairs.filter(pair => pair.sceneIndex === sceneIndex).map(pair => ({
    pairId: pair.id,
    matches: pair.claims.filter(claim => claim.field === "visual").map(claim => ({
      claimId: claim.id, verdict: "supported", quote: pair.reference.excerpt,
      reason: "해당 그림·표의 구절이 화면 설명을 뒷받침합니다.", value: "corroboration", applicability: "direct", transfer: null,
    })),
  })) };
}
