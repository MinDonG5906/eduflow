import { z } from "zod";

export const groundingFailureSchema = z.object({
  stage: z.enum(["source_search", "scene_search", "verification"]),
  reason: z.enum(["timeout", "search_failed", "input_limit", "output_limit", "invalid_response",
    "rate_limited", "auth_failed", "configuration", "budget", "refused", "provider_error", "unknown"]),
  recordedAt: z.string().datetime(),
  elapsedMs: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive().optional(),
  inputTokens: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  pairCount: z.number().int().nonnegative().max(40).optional(),
  claimCount: z.number().int().nonnegative().max(500).optional(),
});
export type GroundingFailure = z.infer<typeof groundingFailureSchema>;

export function groundingFailureMessage(failure: GroundingFailure) {
  const stage = failure.stage === "source_search" ? "생성 전 근거 검색" : failure.stage === "scene_search" ? "장면별 근거 검색" : "AI 근거 검증";
  const messages: Record<GroundingFailure["reason"], string> = {
    timeout: `${stage}이 ${failure.timeoutMs ? `${failure.timeoutMs / 1000}초 제한을 넘었습니다` : "제한 시간 안에 끝나지 않았습니다"}. 장면 재생성 시 다시 확인합니다.`,
    search_failed: `${stage}에 실패했습니다. 지식베이스 상태를 확인해 주세요.`,
    input_limit: `근거 검증에 보낼 분량이 입력 한도를 넘었습니다${failure.inputTokens && failure.maxInputTokens ? ` (${failure.inputTokens.toLocaleString("ko-KR")} / 한도 ${failure.maxInputTokens.toLocaleString("ko-KR")}토큰)` : ""}. 장면 하나씩 재생성해 주세요.`,
    output_limit: "AI의 근거 검증 답변이 출력 한도를 넘어 중단됐습니다. 장면 하나씩 재생성해 주세요.",
    invalid_response: "AI의 근거 검증 답변 형식이 잘못되었거나 필요한 판정이 누락됐습니다. 장면 재생성 시 다시 확인합니다.",
    rate_limited: "AI 근거 검증의 호출 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.",
    auth_failed: "AI 근거 검증의 인증·결제 오류입니다. 모델 연결 설정을 확인해 주세요.",
    configuration: "AI 근거 검증의 모델·권한·설정을 확인하지 못했습니다. 모델 연결 설정을 확인해 주세요.",
    budget: "비용 한도 또는 비용 기록 문제로 AI 근거 검증을 실행하지 못했습니다. 비용 설정을 확인해 주세요.",
    refused: "AI가 근거 검증 요청을 거절했습니다. 원문과 요청 내용을 확인해 주세요.",
    provider_error: "AI 서비스 오류로 근거 검증을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    unknown: "근거 검증 처리 중 원인을 분류하지 못한 오류가 발생했습니다. 장면 재생성 시 다시 확인합니다.",
  };
  return messages[failure.reason];
}
