import { documentSchema, type SourceDocument } from "./documents";
import { isHangul, isPresentation, sourceFormat } from "./pdf-source";

export async function readDocumentUpload(response: Response, original: File): Promise<{ document: SourceDocument; pdf?: File }> {
  if (!response.ok) {
    const failure = await response.json();
    throw new Error(typeof failure.error === "string" ? failure.error : "문서를 읽지 못했습니다.");
  }
  if (isPresentation(original.name) || isHangul(original.name)) {
    const format = sourceFormat(original.name);
    if (response.headers.get("content-type")?.split(";")[0] !== "application/pdf")
      throw new Error(`${format} 변환 결과를 읽지 못했습니다. 다시 올려 주세요.`);
    const document = documentSchema.parse({ name: original.name, kind: "pdf", pages: Number(response.headers.get("x-document-pages")), text: "", query: "", selectedPages: [] });
    const blob = await response.blob();
    if (!blob.size) throw new Error(`${format} 변환 결과가 비어 있습니다. 다시 올려 주세요.`);
    return { document, pdf: new File([blob], "converted-pages.pdf", { type: "application/pdf" }) };
  }
  const document = documentSchema.parse(await response.json());
  return { document, ...(document.kind === "pdf" ? { pdf: original } : {}) };
}
