import "server-only";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const searchPortabilitySchema = z.object({
  version: z.literal(1), model: z.string(), revision: z.string(), identity: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const PORTABILITY_FILE = "search-portability.json";

// A demo carries the existing index identity, not the sender's absolute path.
// Retaining chunk IDs also retains the saved sentence/source links.
export function portableSearchIdentity(directory: string, model: string, revision: string): string | undefined {
  const file = join(directory, PORTABILITY_FILE);
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("검색 이전 정보를 확인해 주세요.");
  const value = searchPortabilitySchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (value.model !== model || value.revision !== revision) throw new Error("데모의 검색 모델 버전이 다릅니다. 같은 버전의 프로그램으로 열어 주세요.");
  return value.identity;
}
