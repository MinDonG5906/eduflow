import "server-only";
import { z } from "zod";
import { contentHash } from "./knowledge-validation-store";

export const PARSEFIXER_COMMIT = "c3d48d2a7d17a13c526ff0fa42731f389a3bbf83";
export type ServiceConfig = { url: string; key: string };
export function serviceConfig(kind: "RAGFLOW" | "PARSEFIXER", env: Record<string, string | undefined> = process.env): ServiceConfig {
  const address = env[`EDUFLOW_${kind}_URL`], key = env[`EDUFLOW_${kind}_KEY`];
  if (!address || !key) throw new Error(`${kind} 서버 연결 설정이 필요합니다.`);
  const url = new URL(address);
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new Error(`${kind} 주소는 HTTPS 또는 이 PC의 로컬 주소를 사용해 주세요.`);
  return { url: url.href.replace(/\/$/, ""), key };
}
export async function serviceJson(config: ServiceConfig, path: string, body: unknown, signal: AbortSignal,
  method = "POST", transport: typeof fetch = fetch) {
  const response = await transport(`${config.url}${path}`, {
    method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
    headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`연결된 검사·검색 서버가 요청을 처리하지 못했습니다 (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("서버 응답이 비어 있습니다.");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("서버 응답이 너무 큽니다."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

const parserResponse = z.object({ commit: z.literal(PARSEFIXER_COMMIT), imageHash: z.string().length(64),
  initial: z.string().max(100000), markdown: z.string().min(1).max(100000) });
export async function parseWithParseFixer(image: Buffer, signal: AbortSignal, env: Record<string, string | undefined> = process.env, transport: typeof fetch = fetch) {
  const result = parserResponse.parse(await serviceJson(serviceConfig("PARSEFIXER", env), "/parse",
    { image: image.toString("base64") }, signal, "POST", transport));
  if (result.imageHash !== contentHash(image)) throw new Error("원본 페이지와 분석 응답이 일치하지 않습니다.");
  return result;
}

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const envelope = z.object({ code: z.number(), data: z.unknown().optional() });
export class RAGFlowClient {
  readonly identity: string;
  private dataset: string;
  constructor(private config: ServiceConfig, dataset: string, private transport: typeof fetch = fetch) {
    this.dataset = identifier.parse(dataset);
    this.identity = contentHash(`${config.url}\n${dataset}`);
  }
  static fromEnv(env: Record<string, string | undefined> = process.env, transport: typeof fetch = fetch) {
    if (!env.EDUFLOW_RAGFLOW_DATASET) throw new Error("RAGFlow 전용 데이터셋 설정이 필요합니다.");
    return new RAGFlowClient(serviceConfig("RAGFLOW", env), env.EDUFLOW_RAGFLOW_DATASET, transport);
  }
  private async call(path: string, body: unknown, signal: AbortSignal, method = "POST") {
    const result = envelope.parse(await serviceJson(this.config, `/api/v1${path}`, body, signal, method, this.transport));
    if (result.code !== 0) throw new Error(`RAGFlow 처리가 실패했습니다 (코드 ${result.code}).`);
    return result.data;
  }
  private path(document?: string) { return `/datasets/${this.dataset}/documents${document ? `/${identifier.parse(document)}` : ""}`; }
  async create(name: string, signal: AbortSignal) {
    const data = z.array(z.object({ id: identifier })).min(1).parse(await this.call(`${this.path()}?type=empty`, { name }, signal));
    return data[0].id;
  }
  async enabled(id: string, enabled: boolean, signal: AbortSignal) {
    await this.call(this.path(id), { enabled: enabled ? 1 : 0 }, signal, "PATCH");
  }
  async addChunk(id: string, content: string, signal: AbortSignal) {
    return z.object({ chunk: z.object({ id: identifier }) }).parse(
      await this.call(`${this.path(id)}/chunks`, { content }, signal)).chunk.id;
  }
  async retrieve(question: string, documentIds: string[], signal: AbortSignal) {
    // Empty document_ids means ALL documents in RAGFlow; never issue that request.
    if (!documentIds.length) return [];
    return z.object({ chunks: z.array(z.object({ id: identifier, document_id: identifier,
      content: z.string().max(100000) })).max(100) }).parse(await this.call("/retrieval", {
      question, dataset_ids: [this.dataset], document_ids: documentIds, page_size: 30,
      keywords_similarity_weight: 0.5, highlight: false, include_knowledge_compilation: false,
    }, signal)).chunks;
  }
}
