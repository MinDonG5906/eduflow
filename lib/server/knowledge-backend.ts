import "server-only";
import { LocalSearchIndex, type SearchIndex } from "./knowledge-local-index";
import { RAGFlowClient } from "./knowledge-services";
export function knowledgeMode() {
  const mode = process.env.EDUFLOW_KNOWLEDGE_MODE ?? "local";
  if (mode !== "local" && mode !== "ragflow") throw new Error("자료 처리 방식 설정을 확인해 주세요.");
  return mode;
}
export function knowledgeIndex(directory: string): SearchIndex {
  return knowledgeMode() === "local" ? new LocalSearchIndex(directory) : RAGFlowClient.fromEnv();
}
